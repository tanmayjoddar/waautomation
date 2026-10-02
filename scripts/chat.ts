/**
 * Interactive console chat (Slice 4): talk to the REAL worker as a fake
 * customer of the demo client, without Meta delivery.
 *
 *   npm run chat            # SEND_MODE must be console
 *
 * Each line you type goes through the SAME inbound function as the webhook
 * (ingestWebhookPayload), then the real worker runs in-process: scoped claim,
 * pipeline, settle, until the queue is quiet. Replies print here. The debounce
 * is skipped (delay 0), so the answer comes back immediately.
 *
 * Refuses to run unless SEND_MODE=console: with live sends every turn would
 * attempt a real WhatsApp delivery. Demo client only, enforced twice (config
 * gate here, factory gate on every send).
 *
 * The fake customer is one fixed contact. Its rows live in the demo tenant
 * while you chat (open Table Editor mid-session to inspect them) and are
 * deleted on exit: contacts cascade to messages/jobs, the contact's
 * sheet_outbox rows (no foreign key) are removed explicitly first, and
 * usage_log rows from this session are removed by timestamp.
 */
import { pathToFileURL } from "node:url";
import * as readline from "node:readline";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import { loadEnvFromFile, type AppConfig } from "../src/config.js";
import { claimDueJob, createServiceClient } from "../src/db/supabase.js";
import { createLogger } from "../src/logger.js";
import { type PipelineDeps } from "../src/jobs/pipeline.js";
import { createDbNotifier } from "../src/staff/alerts.js";
import { settleJob } from "../src/jobs/worker.js";
import { createLlmAdapter, createFallbackLlmAdapter } from "../src/ai/index.js";
import type { LlmAdapter } from "../src/ai/llm.js";
import type { WhatsAppClient } from "../src/whatsapp/client.js";
import {
  ingestWebhookPayload,
  type IngestSummary,
} from "../src/webhook/ingest.js";

/** Fixed fake customer number (E.164 digits). Never a real phone. */
export const CHAT_CONTACT_PHONE = "15550001111";
const CHAT_PROFILE_NAME = "Chat Tester";
/** Worker-drive iterations per turn: enough for retries, bounded against loops. */
const MAX_DRAIN_ITERATIONS = 10;

export type ChatDeps = {
  supabase: SupabaseClient;
  logger: Logger;
  llm: LlmAdapter;
  llmConfig: NonNullable<AppConfig["llm"]>;
  config: AppConfig;
  demoClientId: string;
  demoPhoneNumberId: string;
  contactPhone?: string;
  /** Prints lines to the human. Defaults to process.stdout. */
  out?: { write(chunk: string): void };
  sendGapMs?: number;
  /** Test seam: replaces the SEND_MODE-resolved sender. Production never sets it. */
  sender?: WhatsAppClient;
  /**
   * Extra tenant ids the console sender may serve, beyond the demo client.
   * Scripts with their own tenant (eval) pass exactly one id; the interactive
   * chat never sets it.
   */
  consoleAllowList?: string[];
};

export type ChatReply = { summary: IngestSummary; replies: string[]; fallbacks: string[] };

let chatCounter = 0;

/**
 * One chat turn: the typed text through ingest, then the real worker until
 * quiet. Returns the saved reply texts. Exported for tests. SEND_MODE must
 * be console: this function sends through the pipeline's factory, and live
 * mode would attempt real deliveries.
 */
export async function chatOnce(
  deps: ChatDeps,
  text: string,
): Promise<ChatReply> {
  if (deps.config.sendMode !== "console") {
    throw new Error(
      "chat runs in console mode only: set SEND_MODE=console so nothing reaches Meta.",
    );
  }
  const phone = deps.contactPhone ?? CHAT_CONTACT_PHONE;
  const out = deps.out ?? process.stdout;
  chatCounter += 1;
  const wamid = `wamid.CHAT.${Date.now().toString(36)}.${chatCounter}`;

  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA-CHAT",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15550000000",
                phone_number_id: deps.demoPhoneNumberId,
              },
              contacts: [
                { profile: { name: CHAT_PROFILE_NAME }, wa_id: phone },
              ],
              messages: [
                {
                  from: phone,
                  id: wamid,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  // Same inbound function as the webhook. No hooks: the worker below does the
  // replying, exactly like production (the echo is gone in Slice 4).
  // Debounce skipped: delay 0 puts the job due now.
  const summary = await ingestWebhookPayload(
    { supabase: deps.supabase, logger: deps.logger, debounceSeconds: 0 },
    payload,
  );

  // The real worker, in-process and demo-scoped: claim, settle, repeat until
  // the queue is quiet. Replies print through the console factory; the saved
  // part texts are collected here for a clean transcript.
  const pipeline: Omit<PipelineDeps, "config"> & { config: AppConfig } = {
    supabase: deps.supabase,
    logger: deps.logger,
    llm: deps.llm,
    fallbackLlm:
      createFallbackLlmAdapter(deps.llmConfig, deps.logger) ?? undefined,
    llmConfig: deps.llmConfig,
    config: deps.config,
    notifier: createDbNotifier(deps.supabase, deps.logger),
    sendGapMs: deps.sendGapMs ?? 0,
    sender: deps.sender,
    consoleAllowList: deps.consoleAllowList,
    // Swallowed on purpose: the factory would print every reply itself, and
    // this script prints its own cleaner `bot>` transcript below instead.
    consoleOut: { write: () => undefined },
  };
  const replies: string[] = [];
  const fallbacks: string[] = [];
  for (let i = 0; i < MAX_DRAIN_ITERATIONS; i += 1) {
    const job = await claimDueJob(deps.supabase, deps.demoClientId);
    if (job === null) break;
    const settled = await settleJob(deps.supabase, deps.logger, pipeline, job);
    if (
      settled.fallback !== null &&
      settled.fallback !== undefined &&
      !fallbacks.includes(settled.fallback)
    ) {
      fallbacks.push(settled.fallback);
    }
    const { data } = await deps.supabase
      .from("messages")
      .select("text, wamid")
      .eq("job_id", job.id)
      .order("part_index");
    for (const row of (data ?? []) as Array<{ text: string | null; wamid: string | null }>) {
      if (row.wamid !== null && row.text !== null && !replies.includes(row.text)) {
        replies.push(row.text);
        // The fallback tag travels with the reply line, so a fallback is
        // visible right where the eye already is — not just in the logs.
        const tag =
          settled.fallback !== null && settled.fallback !== undefined
            ? ` [fallback: ${settled.fallback}]`
            : "";
        out.write(`bot> ${row.text}${tag}\n`);
      }
    }
    if (settled.outcome !== "done") {
      out.write(
        `bot> (job ${settled.outcome}: ${settled.error ?? "will retry"})\n`,
      );
    }
  }
  return { summary, replies, fallbacks };
}

/**
 * Removes everything this script wrote: messages, jobs and usage rows plus
 * the contact itself. Contacts cascade to messages/jobs; sheet_outbox rows
 * (no foreign key) and usage_log rows (per client, no contact link) are
 * removed explicitly first.
 */
export async function cleanupChatRows(
  supabase: SupabaseClient,
  clientId: string,
  contactPhone: string = CHAT_CONTACT_PHONE,
  usageSinceIso: string | null = null,
): Promise<{ contacts: number; sheetOutbox: number; usageLog: number }> {
  const { data: contacts, error } = await supabase
    .from("contacts")
    .select("id")
    .eq("client_id", clientId)
    .eq("phone", contactPhone);
  if (error) throw new Error(`cannot list chat contacts: ${error.message}`);
  const ids = (contacts ?? []).map((c) => c.id as string);
  if (ids.length === 0) return { contacts: 0, sheetOutbox: 0, usageLog: 0 };

  const { data: outbox, error: outboxError } = await supabase
    .from("sheet_outbox")
    .delete()
    .eq("client_id", clientId)
    .eq("entity", "contact")
    .in("entity_id", ids)
    .select("id");
  if (outboxError)
    throw new Error(
      `cannot delete chat sheet_outbox rows: ${outboxError.message}`,
    );

  const { data: removed, error: contactError } = await supabase
    .from("contacts")
    .delete()
    .in("id", ids)
    .select("id");
  if (contactError)
    throw new Error(`cannot delete chat contacts: ${contactError.message}`);

  let usageLog = 0;
  if (usageSinceIso !== null) {
    const { data: usage, error: usageError } = await supabase
      .from("usage_log")
      .delete()
      .eq("client_id", clientId)
      .gte("created_at", usageSinceIso)
      .select("id");
    if (usageError)
      throw new Error(`cannot delete chat usage rows: ${usageError.message}`);
    usageLog = usage?.length ?? 0;
  }
  return {
    contacts: removed?.length ?? 0,
    sheetOutbox: outbox?.length ?? 0,
    usageLog,
  };
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// Only run when executed directly, not when imported by a test.
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const run = async (): Promise<void> => {
    const config: AppConfig = loadEnvFromFile();
    if (config.sendMode !== "console") {
      fail(
        "chat refuses to run with SEND_MODE=live: every turn would attempt a real WhatsApp delivery. Set SEND_MODE=console.",
      );
    }
    if (config.whatsappDemo === null) {
      fail(
        "Demo WhatsApp config is missing: set WA_PHONE_NUMBER_ID and WA_TOKEN in .env first.",
      );
    }
    if (config.llm === null) {
      fail(
        "No LLM configured: set LLM_PROVIDER, LLM_API_KEY and LLM_MODEL first (LLM_PROVIDER=fake works offline, free).",
      );
    }
    const sessionStart = new Date().toISOString();
    const logger = createLogger({ level: config.logLevel });
    const supabase = createServiceClient(config);
    const { data: demo, error } = await supabase
      .from("clients")
      .select("id, business_name")
      .eq(
        "phone_number_id",
        (config.whatsappDemo as { phoneNumberId: string }).phoneNumberId,
      )
      .maybeSingle();
    if (error) fail(`Cannot look up the demo client: ${error.message}`);
    if (!demo)
      fail("No client has WA_PHONE_NUMBER_ID. Run npm run seed first.");

    const demoId = (demo as { id: string }).id;
    const demoName = (demo as { business_name: string }).business_name;
    const llm = createLlmAdapter(config.llm, logger);
    process.stdout.write(
      `Chatting with "${demoName}" (${config.llm.provider}) as a fake customer. Real worker, console sends.\n`,
    );
    process.stdout.write(
      "Rows live in the demo tenant while you chat; they are deleted on exit. Type /quit to leave.\n",
    );

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "you> ",
    });
    let closed = false;
    const cleanup = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        const removed = await cleanupChatRows(
          supabase,
          demoId,
          CHAT_CONTACT_PHONE,
          sessionStart,
        );
        process.stdout.write(
          `\nCleaned up ${removed.contacts} chat contact(s), ${removed.sheetOutbox} sheet row(s), ${removed.usageLog} usage row(s).\n`,
        );
      } catch (err) {
        process.stderr.write(
          `\nCleanup failed (rows may remain - delete the ${CHAT_CONTACT_PHONE} contact by hand): ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      process.exit(0);
    };
    rl.on("close", () => void cleanup());
    rl.on("SIGINT", () => void cleanup());
    rl.prompt();

    for await (const line of rl) {
      const text = line.trim();
      if (text === "" || text === "/quit") {
        if (text === "/quit") rl.close();
        else rl.prompt();
        continue;
      }
      try {
        const { summary } = await chatOnce(
          {
            supabase,
            logger,
            llm,
            llmConfig: config.llm,
            config,
            demoClientId: demoId,
            demoPhoneNumberId: (
              config.whatsappDemo as { phoneNumberId: string }
            ).phoneNumberId,
          },
          text,
        );
        if (summary.stored === 0)
          process.stdout.write(
            "(that delivery was a duplicate: stored nothing)\n",
          );
      } catch (err) {
        process.stderr.write(
          `chat turn failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      rl.prompt();
    }
  };

  run().catch((err: unknown) => {
    process.stderr.write(
      `chat failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
