/**
 * Reply pipeline tests against a real Supabase project (Slice 4).
 *
 * The LLM is always the FAKE adapter and sends go through explicit stub/fake
 * clients, so no test touches Meta or a provider. What IS real: the database
 * (isolated `wa-test-pipe-*` tenants, deleted in afterAll), the ingest shape
 * of inbound rows, and every pipeline branch. Skips like the other suites.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config.js";
import {
  enqueueReplyJob,
  claimDueJob,
  markJobDone,
} from "../../src/db/supabase.js";
import type { Contact, Job, Message } from "../../src/db/types.js";
import { createLogger } from "../../src/logger.js";
import { createFakeLlm } from "../../src/ai/fake.js";
import { LlmError } from "../../src/ai/llm.js";
import {
  CircuitBreaker,
  withCircuitBreaker,
} from "../../src/ai/circuitBreaker.js";
import { WhatsAppApiError } from "../../src/whatsapp/client.js";
import { settleJob } from "../../src/jobs/worker.js";
import { ingestWebhookPayload } from "../../src/webhook/ingest.js";
import { createClient } from "@supabase/supabase-js";
import {
  AUDIO_ONLY_TEXT,
  FALLBACK_REPEAT_TEXT,
  FALLBACK_TEXT,
  HANDOVER_TEXT,
  SLOW_DOWN_TEXT,
  TEAM_CONFIRM_TEXT,
  runReplyJob,
  type PipelineDeps,
} from "../../src/jobs/pipeline.js";
import { createDbNotifier, type AlertRefs } from "../../src/staff/alerts.js";
import {
  createFakeWhatsAppClient,
  type FakeWhatsAppClient,
} from "../../src/whatsapp/fake.js";
import type { WhatsAppClient } from "../../src/whatsapp/client.js";
import { baseEnv, collectingStream } from "../helpers.js";
import {
  dbHarness,
  dbTest,
  deleteTestClient,
  purgeAbandonedTestTenants,
  schemaReadiness,
  testPhone,
  TEST_CLIENT_PREFIX,
  type DbHarness,
} from "../db/harness.js";

const NAMESPACE = `${TEST_CLIENT_PREFIX}pipe-`;

const ready = dbHarness();
const suiteName = ready.ok
  ? "reply pipeline (live database, fake LLM)"
  : `reply pipeline (skipped: ${ready.reason})`;

const replyJson = (
  parts: string[],
  extra: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    reply_parts: parts,
    language: "english",
    intent: "question",
    name: null,
    service: null,
    chosen_slot: null,
    confidence: 0.9,
    ...extra,
  });

describe.skipIf(!ready.ok)(suiteName, () => {
  let h!: DbHarness;
  let skipReason: string | null = null;
  let clientId = "";
  let phoneNumberId = "";
  const createdClientIds: string[] = [];
  const { stream, text: logs } = collectingStream();
  let phoneN = 40;

  const test = (body: (h: DbHarness) => Promise<void>) =>
    dbTest(() => skipReason, body);

  const testConfig = (overrides: Record<string, string | undefined> = {}) =>
    loadEnv(
      baseEnv({
        SEND_MODE: "console",
        WA_PHONE_NUMBER_ID: phoneNumberId,
        WA_TOKEN: "test-pipe-token",
        ...overrides,
      }),
    );

  const depsFor = (
    fake: ReturnType<typeof createFakeLlm>,
    overrides: Partial<PipelineDeps> = {},
  ): {
    deps: PipelineDeps;
    alerts: Array<{ clientId: string; kind: string; reason: string; refs?: AlertRefs }>;
    sender: FakeWhatsAppClient;
  } => {
    const alerts: Array<{ clientId: string; kind: string; reason: string; refs?: AlertRefs }> = [];
    const sender = createFakeWhatsAppClient();
    const deps: PipelineDeps = {
      supabase: h.supabase,
      logger: createLogger({ level: "debug", destination: stream }),
      llm: fake,
      llmConfig: {
        provider: "fake",
        apiKey: "test-llm-key-CANARY-9",
        model: "fake",
        fallbackModel: null,
        timeoutMs: 5000,
        maxOutputTokens: 400,
      },
      config: testConfig(),
      notifier: {
        notify: async (clientId: string, kind: string, reason: string, refs?: AlertRefs) => {
          alerts.push({ clientId, kind, reason, refs });
          return { created: true };
        },
      },
      sendGapMs: 0,
      sender,
      consoleOut: { write: () => undefined },
      ...overrides,
    };
    return { deps, alerts, sender };
  };

  const newContact = async (
    n?: number,
    patch: Partial<Contact> = {},
  ): Promise<Contact> => {
    const num = n ?? ++phoneN;
    const { data, error } = await h.supabase
      .from("contacts")
      .insert({
        client_id: clientId,
        phone: testPhone(h.tag, num),
        last_inbound_at: new Date().toISOString(),
        ...patch,
      })
      .select("*")
      .single();
    expect(error, "cannot create a pipeline test contact").toBeNull();
    return data as Contact;
  };

  const addInbound = async (
    contact: Contact,
    text: string,
    kind: "text" | "audio" = "text",
  ): Promise<void> => {
    const wamid = `wamid.PIPE.${h.tag}.${contact.phone}.${Date.now()}.${Math.floor(Math.random() * 1e6)}`;
    const { error } = await h.supabase.from("messages").insert({
      client_id: clientId,
      contact_id: contact.id,
      wamid,
      direction: "in",
      type: kind,
      text: kind === "text" ? text : null,
    });
    expect(error, "cannot insert an inbound test message").toBeNull();
    await h.supabase
      .from("contacts")
      .update({ last_inbound_at: new Date().toISOString() })
      .eq("id", contact.id);
  };

  const addKnowledge = async (
    rows: Array<{ kind: string; title: string; content: string }>,
  ): Promise<void> => {
    const { error } = await h.supabase
      .from("knowledge")
      .insert(rows.map((r) => ({ client_id: clientId, ...r })));
    expect(error, "cannot seed knowledge").toBeNull();
  };

  const claimJob = async (contact: Contact, delaySeconds = 0): Promise<Job> => {
    await enqueueReplyJob(h.supabase, clientId, contact.id, delaySeconds);
    const job = await claimDueJob(h.supabase, clientId);
    expect(job, "a job must be claimable").not.toBeNull();
    return job as Job;
  };

  const outRows = async (contactId: string): Promise<Message[]> => {
    const { data, error } = await h.supabase
      .from("messages")
      .select("*")
      .eq("client_id", clientId)
      .eq("contact_id", contactId)
      .eq("direction", "out")
      .order("part_index");
    expect(error, "cannot read out rows").toBeNull();
    return (data ?? []) as Message[];
  };

  /** Structured log records, so tests assert levels and fields, not substrings. */
  const logRecords = (): Array<Record<string, unknown>> =>
    logs()
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  beforeAll(async () => {
    if (!ready.ok) return;
    h = ready.harness;
    skipReason = await schemaReadiness(h.supabase, {
      requireWorkerQueue: true,
      requireStaffAlerts: true,
    });
    if (skipReason !== null) return;
    phoneNumberId = `${h.tag}-pipe`;
    const { data, error } = await h.supabase
      .from("clients")
      .insert({
        business_name: `${NAMESPACE}demo-${h.tag}`,
        phone_number_id: phoneNumberId,
      })
      .select("id")
      .single();
    expect(error, "cannot create a pipeline test client").toBeNull();
    clientId = (data as { id: string }).id;
    createdClientIds.push(clientId);
  });

  afterAll(async () => {
    if (!ready.ok || skipReason !== null) return;
    for (const id of createdClientIds) await deleteTestClient(h.supabase, id);
    await purgeAbandonedTestTenants(h.supabase, NAMESPACE);
  });

  it(
    "answers a question with one LLM call and one reply",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "What are your prices?");
      await addKnowledge([
        { kind: "price", title: "Haircut", content: "Rs 200" },
      ]);
      const fake = createFakeLlm([{ text: replyJson(["Haircut is Rs 200."]) }]);
      const { deps } = depsFor(fake);
      const job = await claimJob(contact);

      await runReplyJob(deps, job);

      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]?.userText).toContain("What are your prices?");
      const rows = await outRows(contact.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        text: "Haircut is Rs 200.",
        part_index: 0,
      });
      expect(rows[0]?.wamid).toMatch(/^wamid\.FAKE\./);
      expect(rows[0]?.job_id).toBe(job.id);
      const { count } = await h.supabase
        .from("usage_log")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId);
      expect(count).toBeGreaterThan(0);
      const { data: updated } = await h.supabase
        .from("contacts")
        .select("language,status")
        .eq("id", contact.id)
        .single();
      expect((updated as Contact).language).toBe("english");
      expect((updated as Contact).status).toBe("new");
      // One info line for the attempt, with fields and no customer content.
      const calls = logRecords().filter((r) => r["msg"] === "llm call");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        level: "info",
        jobId: job.id,
        provider: "fake",
        model: "fake",
        attempt: 1,
        outcome: "ok",
      });
      expect(typeof calls[0]?.["latencyMs"]).toBe("number");
      expect(calls[0]?.["inputTokens"]).toBeGreaterThan(0);
    }),
  );

  it(
    "debounce: three rapid messages produce ONE LLM call and ONE reply",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "first question here");
      await addInbound(contact, "second question here");
      await addInbound(contact, "third question here");
      // What the webhook does on a burst: three enqueues collapse into one job.
      await enqueueReplyJob(h.supabase, clientId, contact.id, 0);
      await enqueueReplyJob(h.supabase, clientId, contact.id, 0);
      await enqueueReplyJob(h.supabase, clientId, contact.id, 0);
      const job = await claimDueJob(h.supabase, clientId);
      expect(job).not.toBeNull();
      const fake = createFakeLlm([
        { text: replyJson(["One answer for all three."]) },
      ]);
      const { deps } = depsFor(fake);

      await runReplyJob(deps, job as Job);

      expect(fake.calls).toHaveLength(1);
      const userText = fake.calls[0]?.userText ?? "";
      expect(userText).toContain("first question here");
      expect(userText).toContain("second question here");
      expect(userText).toContain("third question here");
      expect(await outRows(contact.id)).toHaveLength(1);
    }),
  );

  it(
    "a job with nothing unanswered sends nothing (clears Slice 2 leftovers)",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "already answered");
      // An outbound reply sitting after the inbound: nothing left to answer.
      await h.supabase.from("messages").insert({
        client_id: clientId,
        contact_id: contact.id,
        wamid: `wamid.PIPE.OUT.${h.tag}.${contact.phone}`,
        direction: "out",
        type: "text",
        text: "earlier reply",
      });
      const fake = createFakeLlm([]);
      const { deps } = depsFor(fake);
      const job = await claimJob(contact);

      await runReplyJob(deps, job);

      expect(fake.calls).toHaveLength(0);
      expect(await outRows(contact.id)).toHaveLength(1);
    }),
  );

  it(
    "a crash retry resumes saved parts without re-running the LLM or duplicating",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "two parter please");
      const fake = createFakeLlm([
        { text: replyJson(["part one here", "part two here"]) },
      ]);
      let sends = 0;
      const sentBodies: string[] = [];
      const flaky: WhatsAppClient = {
        async sendText(_to: string, body: string): Promise<{ wamid: string }> {
          sends += 1;
          // Recorded only on success: a throw means "unknown" (Meta may or may
          // not have it - the send API has no idempotency key, so an ambiguous
          // failure can double-send to the phone; the ROW invariant below is
          // what stays exact).
          if (sends === 2) throw new Error("Meta down mid-reply");
          sentBodies.push(body);
          return { wamid: `wamid.STUB.${sends}` };
        },
        async markReadAndType(): Promise<void> {},
      };
      const { deps } = depsFor(fake, { sender: flaky });
      const job = await claimJob(contact);

      await expect(runReplyJob(deps, job)).rejects.toThrow(
        "Meta down mid-reply",
      );
      expect(fake.calls).toHaveLength(1);
      let rows = await outRows(contact.id);
      expect(rows.map((r) => [r.part_index, r.wamid !== null])).toEqual([
        [0, true],
        [1, false],
      ]);

      // Retry (same job, sender healed): no second LLM call, no duplicate part 0.
      await runReplyJob(deps, job);
      expect(fake.calls).toHaveLength(1);
      rows = await outRows(contact.id);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.wamid !== null)).toBe(true);
      expect(sentBodies).toEqual(["part one here", "part two here"]);
    }),
  );

  it(
    "invalid JSON retries once with a reminder, then falls back",
    test(async () => {
      const contact = await newContact(90);
      const canaryPhone = testPhone(h.tag, 90);
      const canaryText = "PII_JSON_CANARY_5519";
      await addInbound(contact, canaryText);
      const fake = createFakeLlm([
        { text: "not json at all" },
        { text: "still not json" },
      ]);
      const { deps } = depsFor(fake);
      const job = await claimJob(contact);

      await runReplyJob(deps, job);

      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[1]?.userText).toContain("valid JSON only");
      const rows = await outRows(contact.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.text).toBe(FALLBACK_TEXT);
      const { data: updated } = await h.supabase
        .from("contacts")
        .select("status")
        .eq("id", contact.id)
        .single();
      expect((updated as Contact).status).toBe("needs_staff");
      // Even on the failure path: no phone, no customer text, no key in logs.
      const out = logs();
      expect(out).not.toContain(canaryPhone);
      expect(out).not.toContain(canaryText);
      expect(out).not.toContain("test-llm-key-CANARY-9");
      const fallback = logRecords().find(
        (r) => r["msg"] === "pipeline fallback" && r["jobId"] === job.id,
      );
      expect(fallback).toMatchObject({ level: "info", reason: "invalid_json_twice" });
    }),
  );

  it(
    "a 429 backs off inside the adapter and then falls back, without a second LLM call",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "hello?");
      const fake = createFakeLlm([
        new LlmError("rate limited", 429, "rate_limited", true),
      ]);
      const { deps } = depsFor(fake);
      const job = await claimJob(contact);

      await runReplyJob(deps, job);

      expect(fake.calls).toHaveLength(1);
      const rows = await outRows(contact.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.text).toBe(FALLBACK_TEXT);
      const attempts = logRecords().filter(
        (r) => r["msg"] === "llm call" && r["jobId"] === job.id,
      );
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ attempt: 1, outcome: "http_status 429" });
      const fallback = logRecords().find(
        (r) => r["msg"] === "pipeline fallback" && r["jobId"] === job.id,
      );
      expect(fallback).toMatchObject({ level: "info", reason: "llm_error" });
    }),
  );

  it(
    "rate limit: a flood gets one notice, never an LLM call",
    test(async () => {
      const contact = await newContact();
      for (let i = 0; i < 4; i += 1)
        await addInbound(contact, `flood message ${i}`);
      const fake = createFakeLlm([]);
      const limited = { ...depsFor(fake).deps };
      limited.config = testConfig({
        RATE_LIMIT_MESSAGES: "3",
        RATE_LIMIT_WINDOW_SECONDS: "3600",
      });
      const job = await claimJob(contact);

      await runReplyJob(limited, job);

      expect(fake.calls).toHaveLength(0);
      expect((await outRows(contact.id)).map((r) => r.text)).toEqual([
        SLOW_DOWN_TEXT,
      ]);

      // Second job, same flood: still no LLM call, and no second notice. The
      // first job is settled first, exactly like the worker settles before the
      // next claim (otherwise the per-contact guard refuses the claim).
      const firstJobId = (
        await h.supabase
          .from("jobs")
          .select("id")
          .eq("contact_id", contact.id)
          .eq("status", "running")
          .single()
      ).data as { id: string };
      await markJobDone(h.supabase, firstJobId.id);
      await enqueueReplyJob(h.supabase, clientId, contact.id, 0);
      const again = await claimDueJob(h.supabase, clientId);
      await runReplyJob(limited, again as Job);
      expect(fake.calls).toHaveLength(0);
      expect(await outRows(contact.id)).toHaveLength(1);
    }),
  );

  it(
    "daily cap: fallback reply, needs_staff, logged as an error",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "hello?");
      await h.supabase.from("usage_log").insert({
        client_id: clientId,
        kind: "llm",
        units: 100,
        est_cost: 0.001,
      });
      const fake = createFakeLlm([]);
      const limited = { ...depsFor(fake).deps };
      limited.config = testConfig({ MAX_LLM_CALLS_PER_CLIENT_PER_DAY: "1" });
      const job = await claimJob(contact);

      await runReplyJob(limited, job);

      expect(fake.calls).toHaveLength(0);
      expect((await outRows(contact.id)).map((r) => r.text)).toEqual([
        FALLBACK_TEXT,
      ]);
      const { data: updated } = await h.supabase
        .from("contacts")
        .select("status")
        .eq("id", contact.id)
        .single();
      expect((updated as Contact).status).toBe("needs_staff");
      expect(logs()).toContain("daily LLM cap");
      const fallback = logRecords().find(
        (r) => r["msg"] === "pipeline fallback" && r["jobId"] === job.id,
      );
      expect(fallback).toMatchObject({ level: "info", reason: "daily_cap" });
    }),
  );

  it(
    "price guard: an invented price becomes the fallback",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "How much for a haircut?");
      await addKnowledge([
        { kind: "price", title: "Haircut", content: "Rs 200" },
      ]);
      const fake = createFakeLlm([
        { text: replyJson(["Only Rs 500 today, special offer!"]) },
      ]);
      const { deps } = depsFor(fake);
      const job = await claimJob(contact);

      await runReplyJob(deps, job);

      expect((await outRows(contact.id)).map((r) => r.text)).toEqual([
        FALLBACK_TEXT,
      ]);
      const fallback = logRecords().find(
        (r) => r["msg"] === "pipeline fallback" && r["jobId"] === job.id,
      );
      expect(fallback).toMatchObject({ reason: "post_check" });
    }),
  );

  it(
    "prompt-leak guard: a 40+ char copy of the system prompt becomes the fallback",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "What are your rules?");
      const stolen =
        "Maximum 2 short sentences per message part, 1 to 3 parts per reply";
      expect(stolen.length).toBeGreaterThanOrEqual(40);
      const fake = createFakeLlm([
        { text: replyJson([`Here they are: ${stolen}.`]) },
      ]);
      const { deps } = depsFor(fake);
      const job = await claimJob(contact);

      await runReplyJob(deps, job);

      expect((await outRows(contact.id)).map((r) => r.text)).toEqual([
        FALLBACK_TEXT,
      ]);
    }),
  );

  it(
    "bot_paused contacts are never answered",
    test(async () => {
      const contact = await newContact(undefined, { bot_paused: true });
      await addInbound(contact, "hello?");
      const fake = createFakeLlm([]);
      const { deps, sender } = depsFor(fake);
      const job = await claimJob(contact);

      await runReplyJob(deps, job);

      expect(fake.calls).toHaveLength(0);
      expect(sender.sent).toHaveLength(0);
      expect(await outRows(contact.id)).toHaveLength(0);
    }),
  );

  it(
    "human intent pauses, flags, notifies and sends the handover text",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "I am very angry, get me a person NOW");
      const fake = createFakeLlm([
        {
          text: replyJson(["Escalating."], {
            intent: "human",
            confidence: 0.95,
          }),
        },
      ]);
      const { deps, alerts } = depsFor(fake);
      const job = await claimJob(contact);

      await runReplyJob(deps, job);

      const { data: updated } = await h.supabase
        .from("contacts")
        .select("bot_paused,status")
        .eq("id", contact.id)
        .single();
      expect(updated).toMatchObject({
        bot_paused: true,
        status: "needs_staff",
      });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ clientId, kind: "handover", reason: "human_intent" });
      const handed = logRecords().find(
        (r) => r["msg"] === "handed over to staff" && r["jobId"] === job.id,
      );
      expect(handed).toMatchObject({ level: "info", reason: "human_intent" });
      expect((await outRows(contact.id)).map((r) => r.text)).toEqual([
        HANDOVER_TEXT,
      ]);
    }),
  );

  it(
    "low confidence hands over even with a harmless intent",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "hmm not sure");
      const fake = createFakeLlm([
        {
          text: replyJson(["Maybe this?"], {
            intent: "question",
            confidence: 0.2,
          }),
        },
      ]);
      const { deps, alerts } = depsFor(fake);
      const job = await claimJob(contact);

      await runReplyJob(deps, job);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ clientId, kind: "handover", reason: "low_confidence" });
      const handed = logRecords().find(
        (r) => r["msg"] === "handed over to staff" && r["jobId"] === job.id,
      );
      expect(handed).toMatchObject({ level: "info", reason: "low_confidence" });
      const { data: updated } = await h.supabase
        .from("contacts")
        .select("bot_paused")
        .eq("id", contact.id)
        .single();
      expect((updated as Contact).bot_paused).toBe(true);
    }),
  );

  it(
    "audio without a transcript gets the voice notice, no LLM call",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "", "audio");
      const fake = createFakeLlm([]);
      const { deps } = depsFor(fake);
      const job = await claimJob(contact);

      await runReplyJob(deps, job);

      expect(fake.calls).toHaveLength(0);
      expect((await outRows(contact.id)).map((r) => r.text)).toEqual([
        AUDIO_ONLY_TEXT,
      ]);
    }),
  );

  it(
    "book intent: hot status, name saved, team-confirm reply, no booking row",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "I want to book on Saturday, I am Rina");
      const fake = createFakeLlm([
        {
          text: replyJson(["We have Saturday open."], {
            intent: "book",
            name: "Rina",
            confidence: 0.9,
          }),
        },
      ]);
      const { deps } = depsFor(fake);
      const job = await claimJob(contact);

      await runReplyJob(deps, job);

      const { data: updated } = await h.supabase
        .from("contacts")
        .select("status,name")
        .eq("id", contact.id)
        .single();
      expect(updated).toMatchObject({ status: "hot", name: "Rina" });
      expect((await outRows(contact.id)).map((r) => r.text)).toEqual([
        "We have Saturday open.",
        TEAM_CONFIRM_TEXT,
      ]);
      const { count } = await h.supabase
        .from("bookings")
        .select("id", { count: "exact", head: true })
        .eq("contact_id", contact.id);
      expect(count).toBe(0);
    }),
  );

  it(
    "language and name are learned only into empty fields",
    test(async () => {
      const contact = await newContact(undefined, {
        language: "hindi",
        name: "Asha",
      });
      await addInbound(contact, "What are the timings?");
      const fake = createFakeLlm([
        {
          text: replyJson(["We open at 10 am."], {
            language: "english",
            confidence: 0.9,
          }),
        },
      ]);
      const { deps } = depsFor(fake);
      const job = await claimJob(contact);

      await runReplyJob(deps, job);

      const { data: updated } = await h.supabase
        .from("contacts")
        .select("language,name")
        .eq("id", contact.id)
        .single();
      expect(updated).toMatchObject({ language: "hindi", name: "Asha" });
    }),
  );

  it(
    "logs carry ids and reasons only: no phones, text or keys",
    test(async () => {
      const canaryPhone = testPhone(h.tag, 77);
      const canaryText = "PII_CANARY_TEXT_7482";
      const { data: contact } = await h.supabase
        .from("contacts")
        .insert({
          client_id: clientId,
          phone: canaryPhone,
          last_inbound_at: new Date().toISOString(),
        })
        .select("*")
        .single();
      await addInbound(contact as Contact, canaryText);
      const fake = createFakeLlm([{ text: replyJson(["Noted."]) }]);
      const { deps } = depsFor(fake);
      const job = await claimJob(contact as Contact);

      await runReplyJob(deps, job);

      const out = logs();
      expect(out).not.toContain(canaryPhone);
      expect(out).not.toContain(canaryText);
      expect(out).not.toContain("test-llm-key-CANARY-9");
    }),
  );
  /* ---- Slice 4 hardening: fallback model, truncated JSON, cooldown ---- */

  const twoModels = (fallbackLlm: ReturnType<typeof createFakeLlm>) => ({
    fallbackLlm,
    llmConfig: {
      provider: "fake" as const,
      apiKey: "test-llm-key-CANARY-9",
      model: "fake",
      fallbackModel: "fake-2",
      timeoutMs: 5000,
      maxOutputTokens: 400,
    },
  });

  it(
    "primary model fails at transport level, fallback model answers",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "fees kitna hai?");
      const primary = createFakeLlm([
        new LlmError("unavailable", 503, "UNAVAILABLE", true),
      ]);
      const backup = createFakeLlm([
        { text: replyJson(["Answer from the backup model."]) },
      ]);
      const { deps } = depsFor(primary, twoModels(backup));
      const job = await claimJob(contact);

      await runReplyJob(deps, job);

      expect(primary.calls).toHaveLength(1);
      expect(backup.calls).toHaveLength(1);
      expect((await outRows(contact.id)).map((r) => r.text)).toEqual([
        "Answer from the backup model.",
      ]);
      expect(logs()).toContain("primary model failed: trying fallback model");
      expect(logs()).toContain('"model":"fake-2"');
    }),
  );

  it(
    "both models fail: the customer still gets the fallback text",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "hello?");
      const primary = createFakeLlm([
        new LlmError("unavailable", 503, "UNAVAILABLE", true),
      ]);
      const backup = createFakeLlm([
        new LlmError("unavailable", 503, "UNAVAILABLE", true),
      ]);
      const { deps } = depsFor(primary, twoModels(backup));
      const job = await claimJob(contact);

      await runReplyJob(deps, job);

      expect(primary.calls).toHaveLength(1);
      expect(backup.calls).toHaveLength(1);
      expect((await outRows(contact.id)).map((r) => r.text)).toEqual([
        FALLBACK_TEXT,
      ]);
    }),
  );

  it(
    "truncated JSON once, then a valid reply on the reminder retry",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "timings please");
      await addKnowledge([
        { kind: "timing", title: "Hours", content: "We open at 10 am." },
      ]);
      const fake = createFakeLlm([
        { text: '{"reply_parts":["We open at 10' },
        { text: replyJson(["We open at 10 am."]) },
      ]);
      const { deps } = depsFor(fake);
      const job = await claimJob(contact);

      await runReplyJob(deps, job);

      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[1]?.userText).toContain("valid JSON only");
      expect((await outRows(contact.id)).map((r) => r.text)).toEqual([
        "We open at 10 am.",
      ]);
    }),
  );

  it(
    "fallback cooldown: a second fallback sends a different short line, never silence",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "first message");
      const bad = () =>
        createFakeLlm([{ text: "not json" }, { text: "not json either" }]);
      const first = await claimJob(contact);
      await runReplyJob(depsFor(bad()).deps, first);
      await markJobDone(h.supabase, first.id);

      await addInbound(contact, "second message");
      const second = await claimJob(contact);
      await runReplyJob(depsFor(bad()).deps, second);

      const texts = (await outRows(contact.id)).map((r) => r.text).sort();
      expect(texts).toEqual([FALLBACK_REPEAT_TEXT, FALLBACK_TEXT].sort());
    }),
  );

  it(
    "open circuit: no LLM call, fallback sent, blocked attempt logged",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "hello?");
      const fake = createFakeLlm([
        { text: replyJson(["Should never be used."]) },
      ]);
      const breaker = new CircuitBreaker(1, 60_000);
      breaker.recordFailure();
      expect(breaker.opened).toBe(true);
      const guarded = withCircuitBreaker(fake, breaker);
      const { deps } = depsFor(createFakeLlm([]));
      const guardedDeps = { ...deps, llm: guarded };
      const job = await claimJob(contact);

      await runReplyJob(guardedDeps, job);

      expect(fake.calls).toHaveLength(0);
      expect((await outRows(contact.id)).map((r) => r.text)).toEqual([
        FALLBACK_TEXT,
      ]);
      const blocked = logRecords().filter(
        (r) => r["msg"] === "llm call" && r["outcome"] === "circuit_open",
      );
      expect(blocked.length).toBeGreaterThan(0);
      expect(blocked[0]).toMatchObject({ jobId: job.id, level: "info" });
      const fallback = logRecords().find(
        (r) => r["msg"] === "pipeline fallback" && r["jobId"] === job.id,
      );
      expect(fallback).toMatchObject({ reason: "llm_error" });
    }),
  );

  it(
    "human takeover mid-pipeline cancels the send",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "hello?");
      const pausing = {
        provider: "pausing",
        generate: async () => {
          await h.supabase
            .from("contacts")
            .update({ bot_paused: true })
            .eq("id", contact.id);
          return { text: replyJson(["Hello there."]), inputTokens: 1, outputTokens: 1 };
        },
      };
      const { deps } = depsFor(createFakeLlm([]));
      const pausingDeps = { ...deps, llm: pausing as never };
      const job = await claimJob(contact);

      await runReplyJob(pausingDeps, job);

      expect(await outRows(contact.id)).toHaveLength(0);
      expect(logs()).toContain("paused mid-pipeline");
    }),
  );

  it(
    "outside the 24h window with messages waiting: flagged, nothing sent",
    test(async () => {
      const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const contact = await newContact(undefined, { last_inbound_at: old });
      await h.supabase.from("messages").insert({
        client_id: clientId,
        contact_id: contact.id,
        wamid: `wamid.PIPE.STALE.${h.tag}`,
        direction: "in",
        type: "text",
        text: "old question",
        created_at: old,
      });
      const fake = createFakeLlm([]);
      const { deps } = depsFor(fake);
      const job = await claimJob(contact);

      await runReplyJob(deps, job);

      expect(fake.calls).toHaveLength(0);
      expect(await outRows(contact.id)).toHaveLength(0);
      const { data: updated } = await h.supabase
        .from("contacts")
        .select("status")
        .eq("id", contact.id)
        .single();
      expect((updated as Contact).status).toBe("needs_staff");
      expect(logs()).toContain("outside 24h window");
    }),
  );

  it(
    "exact repeat of an answered question sends nothing",
    test(async () => {
      const contact = await newContact();
      const base = Date.now() - 60_000;
      const iso = (offsetMs: number) => new Date(base + offsetMs).toISOString();
      const rows = [
        { wamid: `wamid.PIPE.REP.1.${h.tag}`, direction: "in", type: "text", text: "same question", created_at: iso(0) },
        { wamid: `wamid.PIPE.REP.OUT.${h.tag}`, direction: "out", type: "text", text: "same answer", created_at: iso(1000) },
        { wamid: `wamid.PIPE.REP.2.${h.tag}`, direction: "in", type: "text", text: "same question", created_at: iso(2000) },
      ];
      for (const row of rows) {
        const { error } = await h.supabase.from("messages").insert({
          client_id: clientId,
          contact_id: contact.id,
          ...row,
        });
        expect(error, "cannot seed repeat rows").toBeNull();
      }
      const fake = createFakeLlm([]);
      const { deps } = depsFor(fake);
      const job = await claimJob(contact);

      await runReplyJob(deps, job);

      expect(fake.calls).toHaveLength(0);
      expect((await outRows(contact.id)).filter((r) => r.direction === "out")).toHaveLength(1);
      expect(logs()).toContain("repeated question already answered");
    }),
  );

  it(
    "markdown and unlisted links are stripped before sending",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "What do you have?");
      await addKnowledge([{ kind: "faq", title: "Menu", content: "See all at our shop." }]);
      const fake = createFakeLlm([{ text: replyJson(["See **bold deal** today"]) }]);
      const { deps } = depsFor(fake);
      const job = await claimJob(contact);

      await runReplyJob(deps, job);

      expect((await outRows(contact.id)).map((r) => r.text)).toEqual(["See bold deal today"]);
    }),
  );

  it(
    "settings caps override config: calls and tokens",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "hello?");
      await h.supabase.from("settings").insert({ client_id: clientId, daily_llm_call_cap: 0 });
      const fake = createFakeLlm([{ text: replyJson(["Hi."]) }]);
      const { deps } = depsFor(fake);
      try {
        const job = await claimJob(contact);
        await runReplyJob(deps, job);
        expect(fake.calls).toHaveLength(0);
        expect((await outRows(contact.id)).map((r) => r.text)).toEqual([FALLBACK_TEXT]);
      } finally {
        await h.supabase.from("settings").delete().eq("client_id", clientId);
      }
    }),
  );

  it(
    "settings token cap triggers the fallback",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "hello?");
      await h.supabase.from("settings").insert({ client_id: clientId, daily_llm_call_cap: 9999, daily_llm_token_cap: 1 });
      await h.supabase.from("usage_log").insert({ client_id: clientId, kind: "llm", units: 100, est_cost: null });
      const fake = createFakeLlm([{ text: replyJson(["Hi."]) }]);
      const { deps } = depsFor(fake);
      try {
        const job = await claimJob(contact);
        await runReplyJob(deps, job);
        expect(fake.calls).toHaveLength(0);
        expect((await outRows(contact.id)).map((r) => r.text)).toEqual([FALLBACK_TEXT]);
      } finally {
        await h.supabase.from("settings").delete().eq("client_id", clientId);
      }
    }),
  );

  it(
    "terminal job failure writes exactly one staff alert",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "hello?");
      const failing = {
        provider: "failing",
        generate: async () => ({ text: replyJson(["Hi."]), inputTokens: 1, outputTokens: 1 }),
      };
      const throwing: WhatsAppClient = {
        sendText: async () => {
          throw new WhatsAppApiError("sendText: down", 503, null, 1, "Meta down");
        },
        markReadAndType: async () => undefined,
      };
      const { deps } = depsFor(createFakeLlm([]));
      const logger = createLogger({ level: "debug", destination: stream });
      const failingDeps = {
        ...deps,
        llm: failing as never,
        sender: throwing,
        notifier: createDbNotifier(h.supabase, logger),
      };
      const job = await claimJob(contact);
      await h.supabase.from("jobs").update({ attempts: 3 }).eq("id", job.id);

      const { settleJob: settle } = await import("../../src/jobs/worker.js");
      const outcome = await settle(h.supabase, logger, { ...failingDeps }, { ...job, attempts: 3 });

      expect(outcome.outcome).toBe("failed");
      const { data, error } = await h.supabase
        .from("staff_alerts")
        .select("*")
        .eq("client_id", clientId)
        .eq("kind", "job_failed")
        .eq("job_id", job.id);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    }),
  );

  it(
    "a database error mid-pipeline propagates for the worker to retry",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "hello?");
      const broken = createClient("https://invalid.invalid", "invalid-key", {
        auth: { persistSession: false },
      });
      const fake = createFakeLlm([{ text: replyJson(["Hi."]) }]);
      const { deps } = depsFor(fake);
      const job = await claimJob(contact);

      await expect(runReplyJob({ ...deps, supabase: broken }, job)).rejects.toThrow();
      expect(fake.calls).toHaveLength(0);
      const { data } = await h.supabase.from("jobs").select("status").eq("id", job.id).single();
      expect((data as { status: string }).status).toBe("running");
    }),
  );

  it(
    "Meta 4xx on send retries with backoff instead of failing",
    test(async () => {
      const contact = await newContact();
      await addInbound(contact, "hello?");
      const bad: WhatsAppClient = {
        sendText: async () => {
          throw new WhatsAppApiError("sendText: bad request", 400, 131000, 1, "bad request");
        },
        markReadAndType: async () => undefined,
      };
      const fake = createFakeLlm([{ text: replyJson(["Hello!"]) }]);
      const { deps } = depsFor(fake, { sender: bad });
      const job = await claimJob(contact);
      const logger = createLogger({ level: "debug", destination: stream });
      const { settleJob: settle } = await import("../../src/jobs/worker.js");

      const outcome = await settle(h.supabase, logger, deps, job);

      expect(outcome.outcome).toBe("retried");
      const { data } = await h.supabase.from("jobs").select("status,run_at,last_error").eq("id", job.id).single();
      const row = data as { status: string; run_at: string; last_error: string };
      expect(row.status).toBe("pending");
      expect(Date.parse(row.run_at)).toBeGreaterThan(Date.now());
      expect(row.last_error).not.toBeNull();
    }),
  );

  it(
    "duplicate webhook while a job runs stores nothing new",
    test(async () => {
      const phone = testPhone(h.tag, 81);
      const wamid = `wamid.PIPE.DUP.${h.tag}`;
      const delivery = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "WABA-TEST",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  metadata: { display_phone_number: "15550000000", phone_number_id: phoneNumberId },
                  contacts: [{ profile: { name: "Pipe" }, wa_id: phone }],
                  messages: [
                    { from: phone, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "dup question" } },
                  ],
                },
              },
            ],
          },
        ],
      };
      const ingest = {
        supabase: h.supabase,
        logger: createLogger({ level: "debug", destination: stream }),
        debounceSeconds: 90,
      };
      const first = await ingestWebhookPayload(ingest, delivery);
      expect(first.stored).toBe(1);
      const { data: contact } = await h.supabase.from("contacts").select("id").eq("client_id", clientId).eq("phone", phone).single();
      const contactId = (contact as { id: string }).id;
      await enqueueReplyJob(h.supabase, clientId, contactId, 0);
      const claimed = await claimDueJob(h.supabase, clientId);
      expect(claimed).not.toBeNull();

      const second = await ingestWebhookPayload(ingest, delivery);

      expect(second.duplicates).toBe(1);
      expect(second.stored).toBe(0);
      const { count } = await h.supabase.from("jobs").select("id", { count: "exact", head: true }).eq("contact_id", contactId);
      expect(count).toBe(1);
    }),
  );

  it(
    "two workers answer two contacts independently",
    test(async () => {
      const contactA = await newContact(82);
      const contactB = await newContact(83);
      await addInbound(contactA, "question A here");
      await addInbound(contactB, "question B here");
      const fakeA = createFakeLlm([{ text: replyJson(["Answer A."]) }]);
      const fakeB = createFakeLlm([{ text: replyJson(["Answer B."]) }]);
      const { deps: depsA } = depsFor(fakeA);
      const { deps: depsB } = depsFor(fakeB);
      const jobA = await claimJob(contactA);
      const jobB = await claimJob(contactB);

      await Promise.all([runReplyJob(depsA, jobA), runReplyJob(depsB, jobB)]);

      expect((await outRows(contactA.id)).map((r) => r.text)).toEqual(["Answer A."]);
      expect((await outRows(contactB.id)).map((r) => r.text)).toEqual(["Answer B."]);
    }),
  );
});
