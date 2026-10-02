/**
 * Operator summary: `npm run summary -- --period day|week [--out file]`.
 *
 * Prints per-client counts for a period (leads, bookings by status, replies,
 * fallbacks, handovers, LLM usage + cost, open alerts) using client_stats
 * plus a few direct counts. The database stays the source of truth; this is a
 * read-only view. Console only, plus an optional file copy (--out path).
 */
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadEnvFromFile } from "../src/config.js";
import { createServiceClient, getClientStats } from "../src/db/supabase.js";
import type { ClientStats } from "../src/db/types.js";

export type SummaryPeriod = "day" | "week";

/** UTC period bounds ending now. Exported for tests. */
export function periodRange(
  period: SummaryPeriod,
  now: number = Date.now(),
): { from: string; to: string } {
  const to = new Date(now).toISOString();
  const from = new Date(
    now - (period === "day" ? 24 : 7 * 24) * 60 * 60 * 1000,
  ).toISOString();
  return { from, to };
}

export type ClientSummary = {
  businessName: string;
  stats: ClientStats;
  repliesSent: number;
  fallbacksSent: number;
  handovers: number;
  llmUnits: number;
  llmCost: number | null;
  openAlerts: number;
};

async function summarizeClient(
  supabase: SupabaseClient,
  clientId: string,
  businessName: string,
  from: string,
  to: string,
): Promise<ClientSummary> {
  const stats = await getClientStats(supabase, clientId, from, to);
  const { data: out } = await supabase
    .from("messages")
    .select("text")
    .eq("client_id", clientId)
    .eq("direction", "out")
    .gte("created_at", from);
  const texts = ((out ?? []) as Array<{ text: string | null }>).map(
    (r) => r.text ?? "",
  );
  const { data: usage } = await supabase
    .from("usage_log")
    .select("units,est_cost")
    .eq("client_id", clientId)
    .eq("kind", "llm")
    .gte("created_at", from);
  const usageRows = (usage ?? []) as Array<{
    units: unknown;
    est_cost: unknown;
  }>;
  // Current count, not period-bound: a handover stays open until resumed.
  const { count: handoverCount } = await supabase
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .eq("status", "needs_staff");
  return {
    businessName,
    stats,
    repliesSent: texts.length,
    fallbacksSent: texts.filter((t) =>
      t.startsWith("Thanks! Our team will confirm this shortly."),
    ).length,
    handovers: handoverCount ?? 0,
    llmUnits: usageRows.reduce(
      (sum, r) => sum + (typeof r.units === "number" ? r.units : 0),
      0,
    ),
    llmCost:
      usageRows.length === 0
        ? null
        : usageRows.reduce(
            (sum, r) => sum + (typeof r.est_cost === "number" ? r.est_cost : 0),
            0,
          ),
    openAlerts: await countAlerts(supabase, clientId),
  };
}

async function countAlerts(
  supabase: SupabaseClient,
  clientId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("staff_alerts")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .is("acknowledged_at", null);
  if (error) throw new Error(`summary alert count failed: ${error.message}`);
  return count ?? 0;
}

/** Renders one client's block. Exported for tests. */
export function formatClientSummary(summary: ClientSummary): string {
  const lines = [
    `== ${summary.businessName} ==`,
    `leads=${summary.stats.leads} bookings=${summary.stats.bookings} ` +
      `(confirmed=${summary.stats.confirmed} pending=${summary.stats.pending} ` +
      `cancelled=${summary.stats.cancelled} reschedule_requested=${summary.stats.reschedule_requested} no_show=${summary.stats.no_show})`,
    `replies_sent=${summary.repliesSent} fallbacks=${summary.fallbacksSent} handovers=${summary.handovers}`,
    `llm_units=${summary.llmUnits} llm_cost=${summary.llmCost === null ? "n/a" : summary.llmCost.toFixed(4)} open_alerts=${summary.openAlerts}`,
  ];
  return lines.join("\n");
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const run = async (): Promise<void> => {
    const args = process.argv.slice(2);
    const periodArg = args[args.indexOf("--period") + 1];
    const period: SummaryPeriod = periodArg === "week" ? "week" : "day";
    const outIndex = args.indexOf("--out");
    const outFile = outIndex === -1 ? null : args[outIndex + 1] ?? null;

    const config = loadEnvFromFile();
    const supabase = createServiceClient(config);
    const { from, to } = periodRange(period);
    const { data: clients, error } = await supabase
      .from("clients")
      .select("id,business_name")
      .order("business_name");
    if (error) throw new Error(`summary client list failed: ${error.message}`);

    const blocks: string[] = [
      `Summary (${period}): ${from} .. ${to}`,
    ];
    for (const row of (clients ?? []) as Array<{
      id: string;
      business_name: string;
    }>) {
      const summary = await summarizeClient(
        supabase,
        row.id,
        row.business_name,
        from,
        to,
      );
      blocks.push("", formatClientSummary(summary));
    }
    const text = `${blocks.join("\n")}\n`;
    process.stdout.write(text);
    if (outFile !== null) {
      writeFileSync(outFile, text, "utf8");
    }
  };

  run().catch((err: unknown) => {
    process.stderr.write(
      `summary failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
