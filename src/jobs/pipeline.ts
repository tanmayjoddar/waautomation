/**
 * The reply pipeline: one claimed job in, at most one answered conversation
 * out (spec 1.8). Pure orchestration over small, tested helpers; every
 * database access is scoped by client_id (the claim/requeue functions are the
 * only documented exceptions, and they live in SQL).
 *
 * At-most-once reply parts (migration 003): every part is INSERTED with
 * (job_id, part_index) BEFORE it is sent. A retry (or a crash between insert
 * and send) finds the saved parts and resumes the unsent ones instead of
 * re-running the LLM or duplicating a send. "A send failure must NOT re-run
 * the LLM call" falls out of this ordering, not out of a flag.
 *
 * Nothing here logs prompts, replies, keys or phone numbers: logs carry ids,
 * counts and reasons only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import { ZodError } from "zod";
import type { AppConfig } from "../config.js";
import {
  countLlmCallsSince,
  countRecentInbound,
  listContactMessages,
  listJobParts,
  insertJobPart,
  loadClientBundle,
  loadContact,
  recentOutboundWithText,
  setJobPartWamid,
  sumLlmUnitsSince,
  updateContact,
  writeUsageLog,
} from "../db/supabase.js";
import type { Contact, Job, Knowledge, Message } from "../db/types.js";
import { selectUnanswered } from "../services/messages.js";
import { resolveSendCredentials } from "../whatsapp/tokens.js";
import {
  resolveWhatsAppClient,
  type SendTarget,
} from "../whatsapp/sendMode.js";
import type { WhatsAppClient } from "../whatsapp/client.js";
import {
  buildSystemPrompt,
  formatKnowledge,
  trimHistory,
  trimUserTextWithNote,
} from "../ai/prompt.js";
import { parseReply } from "../ai/schema.js";
import { LlmError, type LlmAdapter } from "../ai/llm.js";
import { CircuitOpenError } from "../ai/circuitBreaker.js";
import type { HistoryTurn } from "../ai/prompt.js";
import type { Reply } from "../ai/schema.js";

export const FALLBACK_TEXT = "Thanks! Our team will confirm this shortly.";
export const HANDOVER_TEXT =
  "Thanks for reaching out. Someone from our team will contact you shortly.";
export const SLOW_DOWN_TEXT =
  "Please slow down a little. I read every message and will reply shortly.";
export const AUDIO_ONLY_TEXT =
  "Sorry, I can't listen to voice notes yet, could you type it?";
export const CLARIFY_TEXT =
  "Sorry, I didn't catch that. Could you type your question in words?";
export const TEAM_CONFIRM_TEXT = "Our team will confirm the time shortly.";
export const FALLBACK_REPEAT_TEXT =
  "Our team has your message and will reply soon.";
const SLOW_DOWN_NOTICE_WINDOW_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

import type { StaffNotifier } from "../staff/alerts.js";

export type PipelineDeps = {
  supabase: SupabaseClient;
  logger: Logger;
  llm: LlmAdapter;
  fallbackLlm?: LlmAdapter;
  /** Non-null: the worker refuses to start without LLM config, so the pipeline assumes it. */
  llmConfig: NonNullable<AppConfig["llm"]>;
  config: AppConfig;
  notifier: StaffNotifier;
  /** Gap between reply parts. Tests pass 0; production uses 1000 (Slice 6 paces properly). */
  sendGapMs?: number;
  /** Test seam: replaces the SEND_MODE-resolved sender. Production never sets it. */
  sender?: WhatsAppClient;
  /** Where console-mode sends print. Defaults to process.stdout; scripts capture it. */
  consoleOut?: { write(chunk: string): void };
  /**
   * Extra phone_number_ids the console sender may serve, beyond the demo
   * client. Threaded through to the factory; the server and worker never set
   * it. Scripts with their own tenant (eval) pass exactly one id.
   */
  consoleAllowList?: string[];
};

type Loaded = {
  contact: Contact;
  businessName: string;
  botName: string;
  timezone: string;
  knowledge: Knowledge[];
};

/** 'YYYY-MM-DD HH:mm (Zone)' in the client's timezone; UTC when it is unknown. */
function nowLabel(timezone: string): string {
  try {
    const text = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
    return `${text} (${timezone})`;
  } catch {
    return `${new Date().toISOString()} (UTC)`;
  }
}

/** UTC midnight ISO: "today" for the daily cap is a UTC calendar day (documented). */
export function utcMidnightIso(now: number = Date.now()): string {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day.toISOString();
}

/** Every currency amount in the texts (Rs/INR/rupee forms, either word order), digits only. */
export function extractAmounts(texts: string[]): string[] {
  const found: string[] = [];
  const pattern =
    /₹\s?[\d,]+|\bRs\.?\s?[\d,]+|\bINR\s?[\d,]+|\brupees?\s?[\d,]+|\b[\d,]+\s?rupees?\b/gi;
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) {
      const digits = match[0].replace(/[^\d]/g, "");
      if (digits !== "") found.push(digits);
    }
  }
  return found;
}

/** True when a 40+ char chunk of the reply is copied verbatim from the system prompt. */
export function promptLeak(system: string, parts: string[]): boolean {
  const joined = parts.join("\n");
  for (let i = 0; i + 40 <= joined.length; i += 1) {
    if (system.includes(joined.slice(i, i + 40))) return true;
  }
  return false;
}

/**
 * Input classification for inbound text. Letters in ANY script (Devanagari,
 * Bengali, Latin, ...) mean real language and pass, except latin-only strings
 * with no vowels (keyboard mash). Emoji-only / digits-only / punctuation-only
 * text has no letters at all and gets the clarify notice instead of the LLM.
 */
export type InputClass = "ok" | "empty" | "unclear";

export function classifyInput(text: string): InputClass {
  const trimmed = text.trim();
  if (trimmed === "") return "empty";
  if (!/[\p{L}]/u.test(trimmed)) return "unclear";
  const letters = trimmed.replace(/[^A-Za-z]/g, "");
  if (/^[A-Za-z\s\p{P}\d]+$/u.test(trimmed) && letters.length >= 6 && !/[aeiouAEIOU]/.test(letters)) {
    return "unclear";
  }
  return "ok";
}

/**
 * True when the two newest inbound texts are identical AND an outbound reply
 * already went out after the first: re-answering the same question would spam
 * the customer, so the job is done silently.
 */
export function isRepeatQuestion(
  lastTwoInbound: [string, string] | null,
  answeredSinceFirst: boolean,
): boolean {
  return lastTwoInbound !== null && lastTwoInbound[0] === lastTwoInbound[1] && answeredSinceFirst;
}

/** Phone-like digit runs (8-15 digits), digits only. */
export function extractPhones(texts: string[]): string[] {
  const found: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(/\+?\d[\d\s\-.()]{6,13}\d/g)) {
      const digits = match[0].replace(/[^\d]/g, "");
      if (digits.length >= 8 && digits.length <= 15) found.push(digits);
    }
  }
  return found;
}

/** Explicit clock times (10:30, 5 pm). Bare numbers are not times. */
export function extractTimes(texts: string[]): string[] {
  const found: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(/\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?(?:am|pm)\b/gi)) {
      found.push(match[0].toLowerCase().replace(/\s+/g, ""));
    }
  }
  return found;
}

/** URLs the model emitted. */
export function extractUrls(texts: string[]): string[] {
  const found: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(/https?:\/\/[^\s)]+/gi)) {
      found.push(match[0]);
    }
  }
  return found;
}

/** True when the reply claims to be human ("I am human", "as a human", ...). */
export function claimsHuman(parts: string[]): boolean {
  const joined = parts.join("\n");
  return /\b(i am|i'm|\bim)\s+(human|a person|a real person)\b|\bas a human\b/i.test(joined);
}

/**
 * Consolidated output-safety verdict for a validated reply. Returns the
 * violation code, or null when the reply may be sent. Pure: the caller logs.
 * Codes: parts | price | phone | url | time | human_claim | prompt_leak.
 */
export function checkReplySafety(parts: string[], knowledgeText: string): string | null {
  if (parts.length > 3 || parts.some((p) => p === "" || p.length > 300)) return "parts";
  const plain = knowledgeText.replace(/,/g, "");
  const plainDigits = plain.replace(/[^\d]/g, "");
  const inventedPrice = extractAmounts(parts).filter((a) => !plain.includes(a.replace(/,/g, "")));
  if (inventedPrice.length > 0) return "price";
  const strangePhone = extractPhones(parts).filter((p) => !plainDigits.includes(p));
  if (strangePhone.length > 0) return "phone";
  const strangeUrl = extractUrls(parts).filter((u) => !knowledgeText.includes(u));
  if (strangeUrl.length > 0) return "url";
  const strangeTime = extractTimes(parts).filter((t) => !knowledgeText.toLowerCase().replace(/\s+/g, "").includes(t));
  if (strangeTime.length > 0) return "time";
  if (claimsHuman(parts)) return "human_claim";
  return null;
}

/**
 * Strips markdown the model was told not to use (**bold**, `code`, # headers,
 * > quotes) and links the knowledge base never gave. Idempotent: clean text
 * passes through unchanged. Returns parts with empties dropped; an empty
 * result means "nothing safe to send".
 */
export function sanitizeReply(parts: string[], knowledgeText: string): string[] {
  return parts
    .map((part) => {
      let out = part;
      out = out.replace(/(\*\*|__)(.*?)\1/g, "$2");
      out = out.replace(/(^|\s)[*_`~]+(\S)/gm, "$1$2");
      out = out.replace(/(\S)[*_`~]+(\s|$)/gm, "$1$2");
      out = out.replace(/^#{1,6}\s+/gm, "");
      out = out.replace(/^>\s?/gm, "");
      out = out.replace(/https?:\/\/[^\s)]+/gi, (url) => (knowledgeText.includes(url) ? url : ""));
      out = out.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      return out;
    })
    .filter((part) => part !== "");
}

function estCost(
  prices: AppConfig["llmPrices"],
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (prices === null) return null;
  const cost =
    (inputTokens / 1_000_000) * prices.inPerMtok +
    (outputTokens / 1_000_000) * prices.outPerMtok;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/**
 * Builds the system prompt, logging an error when knowledge is truncated:
 * a truncated knowledge block means the model answers from partial facts.
 */
function prepareSystem(deps: PipelineDeps, loaded: Loaded): string {
  const { truncated } = formatKnowledge(loaded.knowledge);
  if (truncated) {
    deps.logger.error(
      { clientId: loaded.contact.client_id },
      "knowledge exceeded 8000 chars and was truncated",
    );
  }
  return buildSystemPrompt({
    botName: loaded.botName,
    businessName: loaded.businessName,
    nowLabel: nowLabel(loaded.timezone),
    knowledge: loaded.knowledge,
    knowledgeTruncated: truncated,
  });
}

/**
 * One LLM call with usage logging, then at most ONE retry with a JSON-only
 * reminder. Returns the validated reply, or a fallback reason when the model
 * cannot produce one: 'invalid_json_twice' (both parses failed) or
 * 'llm_error' (transport exhausted after the adapter's own backoff+retries).
 * A fallback reason always ends in the fallback reply, never in silence.
 * Only unexpected errors propagate, so the worker retries those.
 *
 * Every attempt logs one info line (jobId, provider, model, latency, outcome,
 * tokens, attempt number). Outcomes: ok | invalid_json | http_status N |
 * timeout | empty | network_error. Never prompts, replies, keys or phones.
 */
type ValidatedResult =
  | { reply: Reply; fallback: null }
  | { reply: null; fallback: "invalid_json_twice" | "llm_error" };

function classifyLlmError(err: unknown): string {
  if (!(err instanceof LlmError)) return "invalid_json";
  if (/empty response/i.test(err.message)) return "empty";
  if (err.status === null) {
    return /abort|timeout/i.test(err.message) ? "timeout" : "network_error";
  }
  return `http_status ${err.status}`;
}

async function generateValidated(
  deps: PipelineDeps,
  loaded: Loaded,
  system: string,
  history: HistoryTurn[],
  userText: string,
  jobId: string,
): Promise<ValidatedResult> {
  const { supabase, logger, llm, llmConfig, config } = deps;
  const clientId = loaded.contact.client_id;

  const call = async (
    text: string,
    attempt: number,
    target: { llm: LlmAdapter; model: string } = {
      llm,
      model: llmConfig.model,
    },
  ): Promise<Reply> => {
    logger.debug({ jobId, attempt }, "llm call start");
    const started = Date.now();
    const base = {
      jobId,
      provider: target.llm.provider,
      model: target.model,
      attempt,
    };
    try {
      const result = await target.llm.generate({
        system,
        history: history.map((h) => ({ role: h.role, text: h.text })),
        userText: text,
        maxTokens: llmConfig.maxOutputTokens,
        timeoutMs: llmConfig.timeoutMs,
      });
      await writeUsageLog(supabase, {
        clientId,
        kind: "llm",
        units: result.inputTokens + result.outputTokens,
        estCost: estCost(
          config.llmPrices,
          result.inputTokens,
          result.outputTokens,
        ),
      });
      try {
        const reply = parseReply(result.text);
        logger.info(
          {
            ...base,
            latencyMs: Date.now() - started,
            outcome: "ok",
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
          },
          "llm call",
        );
        return reply;
      } catch (parseErr) {
        // Field paths and codes only, never reply text. Safe to keep in logs.
        const detail =
          parseErr instanceof ZodError
            ? parseErr.issues
                .map((i) => `${i.path.join(".")}:${i.code}`)
                .join(",")
            : "json_syntax";
        logger.info(
          {
            ...base,
            latencyMs: Date.now() - started,
            outcome: "invalid_json",
            detail,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
          },
          "llm call",
        );
        throw new Error("reply is not valid JSON");
      }
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        // Failing fast, not failing: log the blocked attempt like any other
        // outcome so "why no LLM call" is answerable from the logs.
        logger.info(
          {
            ...base,
            latencyMs: Date.now() - started,
            outcome: "circuit_open",
            inputTokens: 0,
            outputTokens: 0,
          },
          "llm call",
        );
      } else if (err instanceof LlmError) {
        // Transport exhausted (the adapter already backed off and retried):
        // log with its outcome and let the caller fall back.
        logger.info(
          {
            ...base,
            latencyMs: Date.now() - started,
            outcome: classifyLlmError(err),
            inputTokens: 0,
            outputTokens: 0,
          },
          "llm call",
        );
      }
      throw err;
    }
  };

  const callWithFallback = async (
    text: string,
    attempt: number,
  ): Promise<Reply> => {
    try {
      return await call(text, attempt);
    } catch (err) {
      // CircuitOpenError is not an LlmError and always propagates: with the
      // shared breaker the fallback model is cooling down too, so trying it
      // would only add a blocked line for no benefit.
      if (err instanceof CircuitOpenError) throw err;
      if (
        !(err instanceof LlmError) ||
        deps.fallbackLlm === undefined ||
        llmConfig.fallbackModel === null
      ) {
        throw err;
      }
      logger.warn(
        { clientId, jobId, model: llmConfig.fallbackModel },
        "primary model failed: trying fallback model",
      );
      return await call(text, attempt, {
        llm: deps.fallbackLlm,
        model: llmConfig.fallbackModel,
      });
    }
  };

  try {
    return { reply: await callWithFallback(userText, 1), fallback: null };
  } catch (err) {
    // Run-abort errors (eval quota cap) propagate untouched: scripts/ own
    // them, the pipeline must not translate them into fallbacks. Matched by
    // name so src/ never imports scripts/.
    if (err instanceof Error && err.name === "EvalCapError") throw err;
    if (err instanceof CircuitOpenError) {
      logger.warn(
        { clientId, jobId },
        "LLM circuit open: fallback reply",
      );
      return { reply: null, fallback: "llm_error" };
    }
    if (err instanceof LlmError) {
      await alertLlmPermanentError(deps, clientId, err);
      logger.warn(
        { clientId, jobId },
        "LLM unavailable after retries: fallback reply",
      );
      return { reply: null, fallback: "llm_error" };
    }
    logger.warn(
      { clientId, jobId },
      "LLM output invalid, retrying once with a JSON-only reminder",
    );
  }
  try {
    return {
      reply: await callWithFallback(
        `${userText}\n\nReminder: reply with valid JSON only, exactly the agreed schema, no markdown.`,
        2,
      ),
      fallback: null,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "EvalCapError") throw err;
    if (err instanceof CircuitOpenError) {
      logger.warn(
        { clientId, jobId },
        "LLM circuit open on retry: fallback reply",
      );
      return { reply: null, fallback: "llm_error" };
    }
    if (err instanceof LlmError) {
      await alertLlmPermanentError(deps, clientId, err);
      logger.warn(
        { clientId, jobId },
        "LLM unavailable on retry: fallback reply",
      );
      return { reply: null, fallback: "llm_error" };
    }
    logger.warn({ clientId, jobId }, "LLM retry also invalid: fallback reply");
    return { reply: null, fallback: "invalid_json_twice" };
  }
}

/**
 * Permanent provider errors (400/401/403/404: bad key, bad model, bad shape)
 * raise one client-level staff alert the first time they appear. Transient
 * errors (429/5xx/timeout) never alert: they clear on their own or the job
 * fails loudly later. Provider name + status only, never content or keys.
 */
async function alertLlmPermanentError(
  deps: PipelineDeps,
  clientId: string,
  err: LlmError,
): Promise<void> {
  if (err.status === null) return;
  if (![400, 401, 403, 404].includes(err.status)) return;
  await deps.notifier.notify(
    clientId,
    "llm_error",
    `${deps.llm.provider}: HTTP ${err.status}${typeof err.providerCode === "number" || typeof err.providerCode === "string" ? ` (code ${err.providerCode})` : ""}`,
  );
}

/** Code post-checks on a validated reply: price grounding, prompt secrecy, part count. */
function postChecksOk(
  deps: PipelineDeps,
  loaded: Loaded,
  system: string,
  reply: Reply,
): boolean {
  const clientId = loaded.contact.client_id;
  const violation = checkReplySafety(
    reply.reply_parts,
    loaded.knowledge.map((k) => `${k.title} ${k.content}`).join("\n"),
  );
  if (violation !== null) {
    deps.logger.warn(
      { clientId, violation },
      "post-check failed: reply violates output safety",
    );
    return false;
  }
  if (promptLeak(system, reply.reply_parts)) {
    deps.logger.warn(
      { clientId },
      "post-check failed: reply copies the system prompt",
    );
    return false;
  }
  return true;
}

/**
 * One claimed job, fully processed. Returns which fallback ran, if any (null
 * for normal replies and for correctly-sent-nothing paths); THROWS on
 * anything the worker must retry or mark failed (database outages, Meta send
 * failures). LLM trouble never throws: invalid output and transport
 * exhaustion both end in the fallback reply. Because parts persist with
 * (job_id, part_index), a retry resumes instead of repeating.
 */
/**
 * Permanent job failure: retrying cannot help (no token, revoked client,
 * deleted contact, paused contact), so the worker must fail the job at once
 * instead of burning three attempts. Caught by settleJob, which marks the job
 * failed and raises one staff alert.
 */
export class FatalJobError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "FatalJobError";
  }
}
export async function runReplyJob(
  deps: PipelineDeps,
  job: Job,
): Promise<{ fallback: string | null }> {
  const { supabase, logger, config } = deps;
  const clientId = job.client_id;

  // 1. Load everything, scoped to this tenant. The checks below are all
  // PERMANENT failures: retrying cannot help, so they throw FatalJobError
  // (fail at once, one alert, no retries) instead of returning done.
  const contact = await loadContact(supabase, clientId, job.contact_id);
  if (contact === null) {
    throw new FatalJobError(`contact ${job.contact_id} is gone`);
  }
  const { client, settings, knowledge } = await loadClientBundle(
    supabase,
    clientId,
  );
  if (client === null || !client.active) {
    throw new FatalJobError(
      client === null
        ? `client ${clientId} is gone`
        : `client ${clientId} is not active`,
    );
  }
  // Credentials before anything expensive: no token means no send is
  // possible, so fail before the first LLM call, not after it. Console-mode
  // allowlisted tenants (eval) are exempt here exactly as at send time; live
  // mode always requires a token.
  try {
    resolveSendCredentials(config, client, { allowMissingToken: true });
  } catch (err) {
    throw new FatalJobError(
      err instanceof Error ? err.message : String(err),
    );
  }
  if (contact.bot_paused) {
    throw new FatalJobError(
      `contact ${contact.id} is paused (human takeover)`,
    );
  }
  const loaded: Loaded = {
    contact,
    businessName: client.business_name,
    botName: settings?.bot_name ?? "Assistant",
    timezone: client.timezone ?? "Asia/Kolkata",
    knowledge,
  };

  const messages = await listContactMessages(supabase, clientId, contact.id);
  const unanswered = selectUnanswered(messages);

  // 2. Older than 24h: Meta's free-text window is closed, so no free text may
  // be sent. With messages still waiting, flag for a template or staff
  // instead of going silent; with nothing waiting, just mark done.
  const lastInbound =
    contact.last_inbound_at === null ? 0 : Date.parse(contact.last_inbound_at);
  if (Number.isNaN(lastInbound) || Date.now() - lastInbound > DAY_MS) {
    if (unanswered.length > 0) {
      await updateContact(supabase, clientId, contact.id, {
        status: "needs_staff",
      });
      logger.warn(
        { clientId, contactId: contact.id, jobId: job.id },
        "outside 24h window: flagged for template or staff, nothing sent",
      );
    } else {
      logger.info(
        { clientId, contactId: contact.id, jobId: job.id },
        "last inbound older than 24h: marking done",
      );
    }
    return { fallback: null };
  }

  const sender = deps.sender ?? senderFor(deps, client, contact);

  // 3. Resume: parts already saved for this job (retry after a crash or a
  // failed send) -> send only what lacks a wamid, never re-run the LLM, then
  // stop: anything newer arrived with its own pending job behind this one.
  // Ahead of the unanswered check on purpose: the first saved part already
  // sits AFTER the inbound it answers, so "inbound since last outbound" would
  // wrongly read as answered and the rest would never send. Ahead of rate
  // limiting too: this finishes old work instead of starting new load.
  const saved = await listJobParts(supabase, job.id);
  if (saved.length > 0) {
    logger.info(
      { clientId, contactId: contact.id, jobId: job.id, saved: saved.length },
      "resuming saved reply parts",
    );
    await sendSavedParts(deps, sender, job, contact, saved);
    return { fallback: null };
  }

  // 4. Nothing unanswered -> done. This is what clears the old Slice 2 jobs.
  if (unanswered.length === 0) {
    logger.info(
      { clientId, contactId: contact.id, jobId: job.id },
      "nothing unanswered: marking done",
    );
    return { fallback: null };
  }

  // 5. Per-phone rate limit: too many inbound in the window -> no LLM call.
  const windowStart = new Date(
    Date.now() - config.rateLimit.windowSeconds * 1000,
  ).toISOString();
  const recentInbound = await countRecentInbound(
    supabase,
    clientId,
    contact.id,
    windowStart,
  );
  if (recentInbound > config.rateLimit.messages) {
    logger.warn(
      { clientId, contactId: contact.id, jobId: job.id, recentInbound },
      "rate limit hit: no LLM call",
    );
    const noticed = await recentOutboundWithText(
      supabase,
      clientId,
      contact.id,
      SLOW_DOWN_TEXT,
      new Date(Date.now() - SLOW_DOWN_NOTICE_WINDOW_MS).toISOString(),
    );
    if (!noticed) await sendParts(deps, sender, job, contact, [SLOW_DOWN_TEXT]);
    return { fallback: null };
  }

  // 6. Daily caps (UTC day), read from settings with config fallback: over
  // either cap -> fallback + needs_staff, logged as error, staff alerted
  // once (client-level key: one open row until acknowledged).
  const callCap = settings?.daily_llm_call_cap ?? config.dailyLlmCap;
  const tokenCap = settings?.daily_llm_token_cap ?? null;
  const callsToday = await countLlmCallsSince(
    supabase,
    clientId,
    utcMidnightIso(),
  );
  const tokensToday =
    tokenCap === null
      ? 0
      : await sumLlmUnitsSince(supabase, clientId, utcMidnightIso());
  if (callsToday >= callCap || (tokenCap !== null && tokensToday >= tokenCap)) {
    logger.error(
      { clientId, jobId: job.id, callsToday, tokensToday },
      "daily LLM cap reached: fallback reply",
    );
    await deps.notifier.notify(
      clientId,
      "daily_cap",
      `over cap (${callsToday} calls, ${tokensToday} tokens today)`,
    );
    return {
      fallback: await sendFallback(deps, sender, job, contact, "daily_cap"),
    };
  }

  // 7. Audio without transcripts (voice is Slice 5): notice once, or use text.
  // Text-kind rows with empty bodies fall through to the input sanity check
  // below instead of getting a voice notice they did not ask for.
  const hasNonText = unanswered.some((m) => (m as Message).type !== "text");
  const inboundTexts = unanswered
    .map((m) => (m as Message).text ?? (m as Message).transcript ?? "")
    .filter((t) => t !== "");
  if (inboundTexts.length === 0 && hasNonText) {
    logger.info(
      { clientId, contactId: contact.id, jobId: job.id },
      "audio without transcript: notice sent",
    );
    await sendParts(deps, sender, job, contact, [AUDIO_ONLY_TEXT]);
    return { fallback: null };
  }

  // 8. Input sanity on the joined text: empty skips silently, emoji-only and
  // gibberish get one clarify notice, an exact repeat of an already-answered
  // question skips silently. Mixed scripts always proceed (real language).
  const joinedText = inboundTexts.join("\n");
  const inputClass = classifyInput(joinedText);
  if (inputClass === "empty") {
    logger.info(
      { clientId, contactId: contact.id, jobId: job.id },
      "empty inbound text: marking done",
    );
    return { fallback: null };
  }
  if (inputClass === "unclear") {
    logger.info(
      { clientId, contactId: contact.id, jobId: job.id },
      "unclear inbound text: clarify notice sent",
    );
    await sendParts(deps, sender, job, contact, [CLARIFY_TEXT]);
    return { fallback: null };
  }
  // Exact repeat of the immediately previous inbound question that already
  // got an outbound reply: answering again would spam, so skip silently.
  const trail = messages
    .filter((m) => m.direction === "in")
    .sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.seq - b.seq,
    )
    .filter((m) => (m.text ?? m.transcript ?? "") !== "");
  const lastTwo: [string, string] | null =
    trail.length >= 2
      ? [
          (trail[trail.length - 2] as Message).text ??
            (trail[trail.length - 2] as Message).transcript ??
            "",
          (trail[trail.length - 1] as Message).text ??
            (trail[trail.length - 1] as Message).transcript ??
            "",
        ]
      : null;
  const firstCreated: string | null =
    trail.length >= 2
      ? ((trail[trail.length - 2] as Message).created_at ?? null)
      : null;
  const answeredSinceFirst =
    firstCreated !== null &&
    messages.some(
      (m) => m.direction === "out" && m.created_at >= firstCreated,
    );
  if (isRepeatQuestion(lastTwo, answeredSinceFirst)) {
    logger.info(
      { clientId, contactId: contact.id, jobId: job.id },
      "repeated question already answered: marking done",
    );
    return { fallback: null };
  }
  const trimmed = trimUserTextWithNote(joinedText);
  if (trimmed.truncated) {
    logger.info(
      { clientId, contactId: contact.id, jobId: job.id },
      "user text exceeded the input limit: truncated with a note",
    );
  }
  const userText = trimmed.text;

  // 8. LLM: history + prompt, validate, ONE retry with reminder, else fallback.
  const history = trimHistory(
    messages
      .filter((m) => m.direction === "in" || m.direction === "out")
      .map((m) => ({
        role: (m.direction === "in" ? "user" : "assistant") as
          | "user"
          | "assistant",
        text: m.text ?? m.transcript ?? "",
      }))
      .filter((t) => t.text !== "")
      .slice(-10),
  );
  const system = prepareSystem(deps, loaded);
  const validated = await generateValidated(
    deps,
    loaded,
    system,
    history,
    userText,
    job.id,
  );
  if (validated.reply === null) {
    return {
      fallback: await sendFallback(
        deps,
        sender,
        job,
        contact,
        validated.fallback,
      ),
    };
  }
  const reply = validated.reply;

  // A human may have taken over while the LLM call was in flight: re-read
  // the contact and fail fast if so. The reply is discarded, not queued,
  // because anything sent now would talk over the human. Fatal, not silent:
  // a retry would hit the same paused contact.
  const afterLlm = await loadContact(supabase, clientId, contact.id);
  if (afterLlm === null || afterLlm.bot_paused) {
    throw new FatalJobError(
      `contact ${contact.id} paused mid-pipeline (human takeover)`,
    );
  }

  // 9. Post-checks in code; any failure -> fallback, never the raw reply.
  if (!postChecksOk(deps, loaded, system, reply)) {
    return {
      fallback: await sendFallback(deps, sender, job, contact, "post_check"),
    };
  }

  // 10. Intent.
  if (reply.intent === "human" || reply.confidence < 0.5) {
    const handoverReason =
      reply.intent === "human" ? "human_intent" : "low_confidence";
    await updateContact(supabase, clientId, contact.id, {
      bot_paused: true,
      status: "needs_staff",
    });
    await deps.notifier.notify(clientId, "handover", handoverReason, {
      contactId: contact.id,
      jobId: job.id,
    });
    logger.info(
      {
        clientId,
        contactId: contact.id,
        jobId: job.id,
        reason: handoverReason,
      },
      "handed over to staff",
    );
    await sendParts(deps, sender, job, contact, [HANDOVER_TEXT], {
      // This pipeline step pauses the contact itself a few lines above; the
      // handover text must still go out to tell the customer a human is coming.
      skipPauseCheck: true,
    });
    return { fallback: null };
  }

  let parts = reply.reply_parts;
  const patch: Partial<
    Pick<Contact, "bot_paused" | "status" | "name" | "language">
  > = {};
  if (reply.intent === "book") {
    patch.status = "hot";
    parts = ensureTeamConfirm(parts);
  }
  // Name and language are learned only into empty fields, never overwritten.
  if (
    (contact.name === null || contact.name === "") &&
    reply.name !== null &&
    reply.name !== ""
  ) {
    patch.name = reply.name.slice(0, 60);
  }
  if (contact.language === null || contact.language === "") {
    patch.language = reply.language;
  }
  if (Object.keys(patch).length > 0)
    await updateContact(supabase, clientId, contact.id, patch);

  // Last thing before the wire: strip markdown and links the knowledge base
  // never gave. The guards above validated the raw reply; this only removes
  // formatting, so it cannot introduce a violation. Our own appended
  // sentences (team confirm) are safe by construction and stay intact.
  const knowledgeText = loaded.knowledge
    .map((k) => `${k.title} ${k.content}`)
    .join("\n");
  const clean = sanitizeReply(parts, knowledgeText);
  if (clean.length === 0) {
    return {
      fallback: await sendFallback(deps, sender, job, contact, "post_check"),
    };
  }
  await sendParts(deps, sender, job, contact, clean);
  return { fallback: null };
}

/* -------------------------------------------------------------------------- */
/* helpers (exported for tests)                                               */
/* -------------------------------------------------------------------------- */

function senderFor(
  deps: PipelineDeps,
  client: {
    id: string;
    phone_number_id: string | null;
    wa_token_enc: string | null;
  },
  _contact: Contact,
): WhatsAppClient {
  const { phoneNumberId, token } = resolveSendCredentials(
    deps.config,
    client as Parameters<typeof resolveSendCredentials>[1],
    // Console fakes never touch Meta: allowlisted tenants (eval) send
    // without a stored token. Live mode still requires one (see above).
    { allowMissingToken: true },
  );
  const target: SendTarget = { clientId: client.id, phoneNumberId, token };
  return resolveWhatsAppClient(deps.config, deps.logger, target, {
    out: deps.consoleOut,
    extraConsoleAllowList: deps.consoleAllowList,
  });
}

/** Appends the team-confirmation sentence for bookings (Slice 7 owns real bookings). */
export function ensureTeamConfirm(parts: string[]): string[] {
  if (parts.some((p) => /confirm/i.test(p))) return parts;
  if (parts.length < 3) return [...parts, TEAM_CONFIRM_TEXT];
  return [
    ...parts.slice(0, -1),
    `${parts[parts.length - 1]} ${TEAM_CONFIRM_TEXT}`.trim(),
  ];
}

/** Sends parts through the job-part mechanism (insert first, send, stamp wamid). */
async function sendParts(
  deps: PipelineDeps,
  sender: WhatsAppClient,
  job: Job,
  contact: Contact,
  parts: string[],
  opts: { skipPauseCheck?: boolean } = {},
): Promise<void> {
  const saved = await listJobParts(deps.supabase, job.id);
  await sendSavedParts(deps, sender, job, contact, saved, parts, opts);
}

/** Sends rows that lack a wamid; missing indexes are inserted first. */
async function sendSavedParts(
  deps: PipelineDeps,
  sender: WhatsAppClient,
  job: Job,
  contact: Contact,
  saved: Message[],
  wanted?: string[],
  opts: { skipPauseCheck?: boolean } = {},
): Promise<void> {
  const byIndex = new Map(saved.map((m) => [m.part_index, m]));
  const count = Math.max(saved.length, wanted?.length ?? 0);
  for (let index = 0; index < count; index += 1) {
    let row = byIndex.get(index) ?? null;
    const text = wanted?.[index] ?? row?.text ?? null;
    if (text === null) continue;
    if (row === null) {
      const inserted = await insertJobPart(deps.supabase, {
        clientId: job.client_id,
        contactId: contact.id,
        jobId: job.id,
        partIndex: index,
        text,
      });
      row = inserted.message;
    }
    if (row.wamid !== null) continue; // already sent (inserted by an earlier attempt)
    // Re-read the contact before every send: a human may have taken over
    // while the LLM call or an earlier part was in flight. Stopping here
    // leaves the remaining parts unsent; the human owns the chat now.
    // Skipped only for the handover text itself, which is deliberately sent
    // right after pausing (it tells the customer a human is coming).
    if (opts.skipPauseCheck !== true) {
      const current = await loadContact(
        deps.supabase,
        job.client_id,
        contact.id,
      );
      if (current === null || current.bot_paused) {
        // Fatal, not silent: the remaining parts stay unsent and the failure
        // (plus alert) tells staff a takeover interrupted a reply.
        throw new FatalJobError(
          `contact ${contact.id} paused mid-send (human takeover)`,
        );
      }
    }
    // The row exists BEFORE the send: a crash here leaves a wamid-less part
    // that the next attempt resumes instead of duplicating.
    // Known limit, stated honestly: a send that throws AFTER Meta accepted it
    // (e.g. a timeout on a slow response) retries into a possible double-send
    // on the phone. The send API has no idempotency key, so this cannot be
    // closed in code; what stays exact is the ROW invariant (one row per
    // part) and never re-running the LLM.
    const { wamid } = await sender.sendText(contact.phone, text);
    await setJobPartWamid(deps.supabase, row.id, wamid);
    if (index < count - 1) await sleep(deps.sendGapMs ?? 1000);
  }
}

/** Cooldown-checked fallback. Returns the reason it ran under, for reporting. */
async function sendFallback(
  deps: PipelineDeps,
  sender: WhatsAppClient,
  job: Job,
  contact: Contact,
  reason: string,
): Promise<string> {
  await updateContact(deps.supabase, job.client_id, contact.id, {
    status: "needs_staff",
  });
  // One info line per fallback with its reason: invalid_json_twice,
  // llm_error, daily_cap, post_check. Grep this message to see every fallback.
  deps.logger.info(
    { clientId: job.client_id, contactId: contact.id, jobId: job.id, reason },
    "pipeline fallback",
  );
  const since = new Date(
    Date.now() - deps.config.fallbackCooldownSeconds * 1000,
  ).toISOString();
  const recentlySent = await recentOutboundWithText(
    deps.supabase,
    job.client_id,
    contact.id,
    FALLBACK_TEXT,
    since,
  );
  if (recentlySent) {
    // Same fallback text was sent recently: send a different short line so
    // the customer is never left in silence.
    deps.logger.info(
      { clientId: job.client_id, contactId: contact.id, jobId: job.id, reason },
      "fallback cooldown active: sending the short repeat line",
    );
    await sendParts(deps, sender, job, contact, [FALLBACK_REPEAT_TEXT]);
    return reason;
  }
  await sendParts(deps, sender, job, contact, [FALLBACK_TEXT]);
  return reason;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
