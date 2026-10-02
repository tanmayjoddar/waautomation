/**
 * Staff alerts tests against a real Supabase project (migration 005).
 *
 * Proves the operator contract: an alert is written once, repeats don't
 * create rows until acknowledged, ack re-arms, dashboard users see only
 * their own tenant's rows, and anon sees nothing. Isolated
 * `wa-test-alerts-*` tenants. Skips loudly without 005.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createLogger } from "../../src/logger.js";
import {
  acknowledgeAlert,
  createDbNotifier,
  listOpenAlerts,
} from "../../src/staff/alerts.js";
import { collectingStream } from "../helpers.js";
import {
  dbHarness,
  dbTest,
  deleteTestClient,
  purgeAbandonedTestTenants,
  retry,
  schemaReadiness,
  TEST_CLIENT_PREFIX,
  type DbHarness,
} from "./harness.js";

const NAMESPACE = `${TEST_CLIENT_PREFIX}alerts-`;

const ready = dbHarness();
const suiteName = ready.ok
  ? "staff alerts (live database)"
  : `staff alerts (skipped: ${ready.reason})`;

describe.skipIf(!ready.ok)(suiteName, () => {
  let h!: DbHarness;
  let skipReason: string | null = null;
  let clientId = "";
  const createdClientIds: string[] = [];
  const createdUserIds: string[] = [];
  const { stream, text: logs } = collectingStream();

  const test = (body: (h: DbHarness) => Promise<void>) =>
    dbTest(() => skipReason, body);

  const signInAs = async (
    harness: DbHarness,
    label: string,
  ): Promise<{ id: string; client: SupabaseClient }> => {
    const email = `wa-alerts-${label}-${harness.tag}@example.test`;
    const password = `${randomBytes(24).toString("base64url")}Aa1!`;
    const { data, error } = await harness.supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw new Error(`cannot create user: ${error.message}`);
    const userId = data.user?.id as string;
    const anon = createClient(
      harness.config.supabase.url,
      harness.config.supabase.anonKey as string,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    );
    const ok = await retry(6, 500, async () => {
      const attempt = await anon.auth.signInWithPassword({ email, password });
      return !attempt.error;
    });
    if (!ok) throw new Error("could not sign in as the test user");
    createdUserIds.push(userId);
    return { id: userId, client: anon };
  };

  beforeAll(async () => {
    if (!ready.ok) return;
    h = ready.harness;
    skipReason = await schemaReadiness(h.supabase, {
      requireStaffAlerts: true,
    });
    if (skipReason !== null) return;
    if (!h.config.supabase.anonKey) {
      skipReason = "SUPABASE_ANON_KEY is not set: the RLS checks need it";
      return;
    }
    const { data, error } = await h.supabase
      .from("clients")
      .insert({
        business_name: `${NAMESPACE}${h.tag}`,
        phone_number_id: `${h.tag}-alerts`,
      })
      .select("id")
      .single();
    expect(error, "cannot create an alerts test client").toBeNull();
    clientId = (data as { id: string }).id;
    createdClientIds.push(clientId);
  });

  afterAll(async () => {
    if (!ready.ok || skipReason !== null) return;
    for (const id of createdClientIds)
      await deleteTestClient(h.supabase, id);
    for (const userId of createdUserIds) {
      await h.supabase.auth.admin.deleteUser(userId).catch(() => undefined);
    }
    await purgeAbandonedTestTenants(h.supabase, NAMESPACE);
  });

  it("writes an alert row and one error line, then deduplicates repeats", test(async () => {
    const notify = createDbNotifier(
      h.supabase,
      createLogger({ level: "debug", destination: stream }),
    );

    const { data: contact } = await h.supabase
      .from("contacts")
      .insert({ client_id: clientId, phone: "15550009999" })
      .select("id")
      .single();
    const contactId = (contact as { id: string }).id;

    const first = await notify.notify(clientId, "handover", "human_intent", {
      contactId,
    });
    expect(first).toEqual({ created: true });
    const second = await notify.notify(clientId, "handover", "human_intent", {
      contactId,
    });
    expect(second).toEqual({ created: false });

    const { data, error } = await h.supabase
      .from("staff_alerts")
      .select("*")
      .eq("client_id", clientId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(logs()).toContain("staff alert recorded");
  }));

  it("ack re-arms: a repeat after acknowledge creates a fresh row", test(async () => {
    const notify = createDbNotifier(
      h.supabase,
      createLogger({ level: "debug", destination: stream }),
    );
    await notify.notify(clientId, "daily_cap", "over cap", {});
    const open = await listOpenAlerts(h.supabase);
    const row = open.find(
      (r) => r.client_id === clientId && r.kind === "daily_cap",
    );
    expect(row, "no open daily_cap row").toBeDefined();
    await acknowledgeAlert(h.supabase, (row as { id: string }).id.slice(0, 8));

    const again = await notify.notify(clientId, "daily_cap", "over cap", {});
    expect(again).toEqual({ created: true });
  }));

  it("dashboard users see only their own tenant's alerts, anon sees none", test(async () => {
    const { data: other } = await h.supabase
      .from("clients")
      .insert({
        business_name: `${NAMESPACE}other-${h.tag}`,
        phone_number_id: `${h.tag}-alerts-other`,
      })
      .select("id")
      .single();
    const otherId = (other as { id: string }).id;
    createdClientIds.push(otherId);

    const notify = createDbNotifier(
      h.supabase,
      createLogger({ level: "silent" }),
    );
    await notify.notify(clientId, "handover", "human_intent", {});
    await notify.notify(otherId, "handover", "human_intent", {});

    const userA = await signInAs(h, "a");
    await h.supabase
      .from("client_users")
      .insert({ user_id: userA.id, client_id: clientId });
    const seen = await userA.client.from("staff_alerts").select("client_id");
    expect(seen.error).toBeNull();
    expect(
      (seen.data ?? []).every(
        (r) => (r as { client_id: string }).client_id === clientId,
      ),
    ).toBe(true);
    expect(seen.data).not.toHaveLength(0);

    const anon = createClient(
      h.config.supabase.url,
      h.config.supabase.anonKey as string,
      { auth: { persistSession: false } },
    );
    const anonSeen = await anon.from("staff_alerts").select("id").limit(1);
    expect((anonSeen.data ?? [])).toHaveLength(0);
  }));
});
