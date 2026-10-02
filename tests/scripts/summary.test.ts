/**
 * Summary + alerts-format tests. Pure functions only, no network, no
 * database: period math and text rendering. The live queries behind them are
 * covered by the db suites.
 */
import { describe, expect, it } from "vitest";
import { formatAlertRow } from "../../scripts/alerts.js";
import {
  formatClientSummary,
  periodRange,
  type ClientSummary,
} from "../../scripts/summary.js";

describe("periodRange", () => {
  it("covers the last 24 hours for day", () => {
    const now = Date.parse("2026-10-02T12:00:00Z");
    const { from, to } = periodRange("day", now);
    expect(to).toBe("2026-10-02T12:00:00.000Z");
    expect(from).toBe("2026-10-01T12:00:00.000Z");
  });

  it("covers the last 7 days for week", () => {
    const now = Date.parse("2026-10-02T12:00:00Z");
    const { from, to } = periodRange("week", now);
    expect(to).toBe("2026-10-02T12:00:00.000Z");
    expect(from).toBe("2026-09-25T12:00:00.000Z");
  });
});

const summary = (overrides: Partial<ClientSummary> = {}): ClientSummary => ({
  businessName: "Demo Salon",
  stats: {
    leads: 3,
    bookings: 2,
    confirmed: 1,
    pending: 1,
    cancelled: 0,
    reschedule_requested: 0,
    no_show: 0,
  },
  repliesSent: 5,
  fallbacksSent: 1,
  handovers: 1,
  llmUnits: 1500,
  llmCost: 0.0045,
  openAlerts: 2,
  ...overrides,
});

describe("formatClientSummary", () => {
  it("renders every section in one block", () => {
    const text = formatClientSummary(summary());
    expect(text).toContain("Demo Salon");
    expect(text).toContain("leads=3");
    expect(text).toContain("bookings=2");
    expect(text).toContain("replies_sent=5");
    expect(text).toContain("fallbacks=1");
    expect(text).toContain("handovers=1");
    expect(text).toContain("llm_units=1500");
    expect(text).toContain("llm_cost=0.0045");
    expect(text).toContain("open_alerts=2");
  });

  it("prints n/a when cost is unknown", () => {
    expect(formatClientSummary(summary({ llmCost: null }))).toContain(
      "llm_cost=n/a",
    );
  });
});

describe("formatAlertRow", () => {
  it("renders a one-line row with a short id", () => {
    const text = formatAlertRow({
      id: "12345678-aaaa-bbbb-cccc-000000000001",
      client_id: "c1",
      kind: "handover",
      reason: "human_intent",
      contact_id: "ct1",
      job_id: null,
      created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      acknowledged_at: null,
      business_name: "Demo Salon",
      contact_phone: "919812345678",
    });
    expect(text).toContain("12345678");
    expect(text).not.toContain("12345678-aaaa");
    expect(text).toContain("handover");
    expect(text).toContain("Demo Salon");
  });
});
