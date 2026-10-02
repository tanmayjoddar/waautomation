/**
 * Eval harness tests. gateReply is pure (always runs); the abort/cap/broken
 * tenant proofs need a live database with isolated `wa-test-evalh-*`
 * tenants, deleted in afterAll. The fake LLM stands in for the provider, so
 * no quota is spent and SEND_MODE stays console.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EvalCapError,
  gateReply,
  runEval,
} from "../../scripts/eval.js";
import { loadEnv } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { createFakeLlm } from "../../src/ai/fake.js";
import { LlmError } from "../../src/ai/llm.js";
import { baseEnv, collectingStream } from "../helpers.js";
import {
  dbHarness,
  dbTest,
  deleteTestClient,
  purgeAbandonedTestTenants,
  schemaReadiness,
  TEST_CLIENT_PREFIX,
  type DbHarness,
} from "../db/harness.js";

describe("gateReply", () => {
  it("fails empty replies, with and without fallbacks", () => {
    expect(gateReply([], [])).toEqual({
      pass: false,
      note: "no reply",
    });
    expect(gateReply([], ["llm_error"])).toEqual({
      pass: false,
      note: "fallback: llm_error",
    });
  });

  it("fails fallback replies even when text exists", () => {
    expect(gateReply(["Thanks! Our team will confirm this shortly."], ["llm_error"])).toEqual({
      pass: false,
      note: "fallback: llm_error",
    });
  });

  it("passes real replies through to the case check", () => {
    expect(gateReply(["Haircut is Rs 200."], [])).toBeNull();
  });

  it("an empty reply can never pass a would-be-passing check", () => {
    // The exact vacuous pass from the broken run: "no invented answer" over
    // zero replies. The gate must stop it before the check runs.
    const wouldPass = { pass: true, note: "no amounts claimed" };
    const gated = gateReply([], []) ?? wouldPass;
    expect(gated.pass).toBe(false);
    expect(gated.note).toBe("no reply");
  });
});

const NAMESPACE = `${TEST_CLIENT_PREFIX}evalh-`;

const ready = dbHarness();
const suiteName = ready.ok
  ? "eval harness (live database, fake LLM)"
  : `eval harness (skipped: ${ready.reason})`;

describe.skipIf(!ready.ok)(suiteName, () => {
  let h!: DbHarness;
  let skipReason: string | null = null;
  const createdClientIds: string[] = [];
  const { stream } = collectingStream();

  const test = (body: (h: DbHarness) => Promise<void>) =>
    dbTest(() => skipReason, body);

  const newTenant = async (label: string, active = true) => {
    const phoneId = `${h.tag}-evalh-${label}`;
    const { data, error } = await h.supabase
      .from("clients")
      .insert({
        business_name: `${NAMESPACE}${label}-${h.tag}`,
        phone_number_id: phoneId,
        active,
      })
      .select("id")
      .single();
    expect(error, "cannot create an eval-harness tenant").toBeNull();
    const id = (data as { id: string }).id;
    createdClientIds.push(id);
    return { id, phoneId };
  };

  const evalDepsFor = (
    tenant: { id: string; phoneId: string },
    llm: ReturnType<typeof createFakeLlm>,
    overrides: Record<string, unknown> = {},
  ) => ({
    supabase: h.supabase,
    logger: createLogger({ level: "debug", destination: stream }),
    llm,
    llmConfig: {
      provider: "fake",
      apiKey: "x",
      model: "fake",
      fallbackModel: null,
      timeoutMs: 5000,
      maxOutputTokens: 400,
    },
    config: loadEnv(
      baseEnv({
        SEND_MODE: "console",
        WA_PHONE_NUMBER_ID: `other-number-${h.tag}`,
        WA_TOKEN: "test-token",
      }),
    ),
    clientId: tenant.id,
    evalPhoneId: tenant.phoneId,
    knowledgeText: "Haircut Rs 200.",
    maxCalls: 200,
    ...overrides,
  });

  beforeAll(async () => {
    if (!ready.ok) return;
    h = ready.harness;
    skipReason = await schemaReadiness(h.supabase, {
      requireWorkerQueue: true,
      requireStaffAlerts: true,
    });
  });

  afterAll(async () => {
    if (!ready.ok || skipReason !== null) return;
    for (const id of createdClientIds)
      await deleteTestClient(h.supabase, id);
    await purgeAbandonedTestTenants(h.supabase, NAMESPACE);
  });

  it(
    "three infrastructure failures in a row abort with the real cause",
    test(async () => {
      const tenant = await newTenant("broken-llm");
      // Knowledge + settings so the ONLY failure is the provider.
      await h.supabase.from("knowledge").insert({
        client_id: tenant.id,
        kind: "price",
        title: "Haircut",
        content: "Rs 200",
      });
      const llm = createFakeLlm([
        new LlmError("down", 500, null, true),
        new LlmError("down", 500, null, true),
        new LlmError("down", 500, null, true),
        new LlmError("down", 500, null, true),
      ]);
      // SEND_MODE=console here is irrelevant (chatOnce drives sends); the
      // tenant phone id is allowlisted through EvalDeps, not the demo rule.
      const report = await runEval({
        ...evalDepsFor(tenant, llm),
        abortAfter: 3,
      } as never);

      expect(report.aborted).toBe(true);
      expect(report.abortReason).toContain("3 infrastructure failures");
      // Stopped early: 3 cases attempted, not thirty.
      expect(report.results.length).toBe(3);
    }),
  );

  it(
    "hitting the per-run cap aborts instead of spending quota",
    test(async () => {
      const tenant = await newTenant("capped");
      await h.supabase.from("knowledge").insert({
        client_id: tenant.id,
        kind: "price",
        title: "Haircut",
        content: "Rs 200",
      });
      const llm = createFakeLlm([]);
      await expect(
        runEval({ ...evalDepsFor(tenant, llm), maxCalls: 1 } as never),
      ).rejects.toBeInstanceOf(EvalCapError);
    }),
  );

  it(
    "a deliberately broken (inactive) tenant aborts fast with its cause",
    test(async () => {
      const tenant = await newTenant("inactive", false);
      const llm = createFakeLlm([]);
      const report = await runEval({
        ...evalDepsFor(tenant, llm),
        abortAfter: 3,
      } as never);

      expect(report.aborted).toBe(true);
      expect(report.results.length).toBe(3);
    }),
  );
});
