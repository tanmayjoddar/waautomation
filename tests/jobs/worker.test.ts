/**
 * Worker lifecycle tests against a real Supabase project.
 *
 * startWorker with tiny intervals: claims and settles a due job end to end,
 * reaps stale jobs on its timer, and stops within the injected cap even with
 * a stuck job. Isolated `wa-test-worker-*` tenants. Skips without 003.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config.js";
import {
  enqueueReplyJob,
} from "../../src/db/supabase.js";
import type { Job } from "../../src/db/types.js";
import { createLogger } from "../../src/logger.js";
import { createFakeLlm } from "../../src/ai/fake.js";
import { startWorker } from "../../src/jobs/worker.js";
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

const NAMESPACE = `${TEST_CLIENT_PREFIX}worker-`;

const ready = dbHarness();
const suiteName = ready.ok
  ? "worker lifecycle (live database, fake LLM)"
  : `worker lifecycle (skipped: ${ready.reason})`;

const replyJson = (parts: string[]): string =>
  JSON.stringify({
    reply_parts: parts,
    language: "english",
    intent: "question",
    name: null,
    service: null,
    chosen_slot: null,
    confidence: 0.9,
  });

describe.skipIf(!ready.ok)(suiteName, () => {
  let h!: DbHarness;
  let skipReason: string | null = null;
  let clientId = "";
  let phoneNumberId = "";
  const createdClientIds: string[] = [];
  const { stream, text: logs } = collectingStream();

  const test = (body: (h: DbHarness) => Promise<void>) =>
    dbTest(() => skipReason, body);

  const workerDeps = (overrides: Record<string, unknown> = {}) => {
    const config = loadEnv(
      baseEnv({
        SEND_MODE: "console",
        WA_PHONE_NUMBER_ID: phoneNumberId,
        WA_TOKEN: "test-worker-token",
        LLM_PROVIDER: "fake",
        LLM_API_KEY: "x",
        LLM_MODEL: "fake",
        WORKER_POLL_MS: "100",
      }),
    );
    return {
      supabase: h.supabase,
      logger: createLogger({ level: "debug", destination: stream }),
      config,
      llm: createFakeLlm([{ text: replyJson(["Worker answer."]) }]),
      sendGapMs: 0,
      consoleOut: { write: () => undefined },
      ...overrides,
    };
  };

  const waitFor = async (
    check: () => Promise<boolean>,
    timeoutMs = 10000,
  ): Promise<boolean> => {
    const start = Date.now();
    for (;;) {
      if (await check()) return true;
      if (Date.now() - start > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  beforeAll(async () => {
    if (!ready.ok) return;
    h = ready.harness;
    skipReason = await schemaReadiness(h.supabase, {
      requireWorkerQueue: true,
    });
    if (skipReason !== null) return;
    phoneNumberId = `${h.tag}-worker`;
    const { data, error } = await h.supabase
      .from("clients")
      .insert({
        business_name: `${NAMESPACE}demo-${h.tag}`,
        phone_number_id: phoneNumberId,
      })
      .select("id")
      .single();
    expect(error, "cannot create a worker test client").toBeNull();
    clientId = (data as { id: string }).id;
    createdClientIds.push(clientId);
  });

  afterAll(async () => {
    if (!ready.ok || skipReason !== null) return;
    for (const id of createdClientIds)
      await deleteTestClient(h.supabase, id);
    await purgeAbandonedTestTenants(h.supabase, NAMESPACE);
  });

  it("claims and settles a due job end to end", test(async () => {
    const { data: contact } = await h.supabase
      .from("contacts")
      .insert({
        client_id: clientId,
        phone: testPhone(h.tag, 61),
        last_inbound_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    const contactId = (contact as { id: string }).id;
    await h.supabase.from("messages").insert({
      client_id: clientId,
      contact_id: contactId,
      wamid: `wamid.WORKER.1.${h.tag}`,
      direction: "in",
      type: "text",
      text: "hello worker",
    });
    await enqueueReplyJob(h.supabase, clientId, contactId, 0);

    const worker = startWorker(workerDeps() as Parameters<typeof startWorker>[0]);
    try {
      const settled = await waitFor(async () => {
        const { data } = await h.supabase
          .from("jobs")
          .select("status")
          .eq("contact_id", contactId);
        return (
          (data ?? []).length > 0 &&
          (data ?? []).every((r) => (r as { status: string }).status === "done")
        );
      });
      expect(settled, "worker never settled the job").toBe(true);
      const { data: out } = await h.supabase
        .from("messages")
        .select("text")
        .eq("contact_id", contactId)
        .eq("direction", "out");
      expect((out ?? []).map((r) => (r as { text: string }).text)).toEqual([
        "Worker answer.",
      ]);
    } finally {
      await worker.stop();
    }
  }));

  it("stop() resolves immediately when idle", test(async () => {
    const worker = startWorker(workerDeps() as Parameters<typeof startWorker>[0]);
    const started = Date.now();
    await worker.stop();
    expect(Date.now() - started).toBeLessThan(2000);
  }));

  it("stop() gives up within the injected cap on a stuck job", test(async () => {
    const stuckLlm = {
      provider: "stuck",
      generate: async () => {
        await new Promise(() => undefined);
      },
    };
    const worker = startWorker({
      ...(workerDeps() as Parameters<typeof startWorker>[0]),
      llm: stuckLlm as never,
      stopTimeoutMs: 300,
      requeueEveryMs: 200,
    });
    // Plant a due job so a claim is in flight when we stop.
    const { data: contact } = await h.supabase
      .from("contacts")
      .insert({
        client_id: clientId,
        phone: testPhone(h.tag, 62),
        last_inbound_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    const contactId = (contact as { id: string }).id;
    await h.supabase.from("messages").insert({
      client_id: clientId,
      contact_id: contactId,
      wamid: `wamid.WORKER.2.${h.tag}`,
      direction: "in",
      type: "text",
      text: "stuck please",
    });
    await enqueueReplyJob(h.supabase, clientId, contactId, 0);
    // Wait until the worker actually picked the job up: stopping before the
    // first poll would find nothing in flight and prove nothing.
    const picked = await waitFor(async () => {
      const { data } = await h.supabase
        .from("jobs")
        .select("status")
        .eq("contact_id", contactId);
      return (data ?? []).some(
        (r) => (r as { status: string }).status === "running",
      );
    });
    expect(picked, "worker never picked up the job").toBe(true);
    const started = Date.now();
    await worker.stop();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(logs()).toContain("worker stop timed out");
  }));

  it("the periodic reaper revives a stale running job", test(async () => {
    const { data: contact } = await h.supabase
      .from("contacts")
      .insert({
        client_id: clientId,
        phone: testPhone(h.tag, 63),
        last_inbound_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    const contactId = (contact as { id: string }).id;
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    await h.supabase.from("jobs").insert({
      client_id: clientId,
      contact_id: contactId,
      run_at: old,
      status: "running",
      attempts: 1,
      started_at: old,
    });

    const worker = startWorker({
      ...(workerDeps() as Parameters<typeof startWorker>[0]),
      requeueEveryMs: 200,
    });
    try {
      const reaped = await waitFor(async () => {
        const { data } = await h.supabase
          .from("jobs")
          .select("status")
          .eq("contact_id", contactId);
        return (data ?? []).some(
          (r) =>
            (r as { status: string }).status === "pending" ||
            (r as { status: string }).status === "done",
        );
      });
      expect(reaped, "stale job was never reaped").toBe(true);
    } finally {
      await worker.stop();
    }
  }));
});
