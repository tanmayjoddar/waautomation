/**
 * Eval janitor: `npm run eval:cleanup [--dry-run] [--since <iso>]`.
 *
 * Removes everything eval runs may have left behind: whole eval/decoy
 * tenants (cascades take the rest) plus, on the demo tenant if one is
 * configured, eval-prefix contacts and their orphans. Demo-tenant usage_log
 * rows are unattributable afterwards, so they go only with an explicit
 * --since bound (otherwise they are listed, not deleted).
 *
 * --dry-run prints what would be removed and deletes nothing. Use it first.
 */
import { pathToFileURL } from "node:url";
import { loadEnvFromFile } from "../src/config.js";
import { createServiceClient } from "../src/db/supabase.js";
import { listEvalJunk, removeEvalJunk } from "./eval.js";

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const run = async (): Promise<void> => {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const sinceIndex = args.findIndex(
      (a) => a === "--since" || a.startsWith("--since="),
    );
    const since =
      sinceIndex === -1
        ? null
        : args[sinceIndex]?.startsWith("--since=") === true
          ? (args[sinceIndex]?.split("=")[1] ?? null)
          : (args[sinceIndex + 1] ?? null);
    if (since !== null && Number.isNaN(Date.parse(since))) {
      process.stderr.write(
        "Usage: npm run eval:cleanup [--dry-run] [--since <iso>]\n",
      );
      process.exit(1);
    }

    const config = loadEnvFromFile();
    const supabase = createServiceClient(config);
    const demoClientId = await (async () => {
      if (config.whatsappDemo === null) return null;
      const { data } = await supabase
        .from("clients")
        .select("id")
        .eq("phone_number_id", config.whatsappDemo.phoneNumberId)
        .maybeSingle();
      return (data as { id: string } | null)?.id ?? null;
    })();

    const junk = await listEvalJunk(supabase, demoClientId, since);
    const lines: string[] = [];
    for (const t of junk.tenants) {
      lines.push(`tenant ${t.id} (${t.business_name})`);
    }
    for (const c of junk.demoContacts) {
      lines.push(`demo contact ${c.id} (${c.phone})`);
    }
    if (junk.demoSheetRows > 0) {
      lines.push(`${junk.demoSheetRows} demo sheet_outbox row(s) for those contacts`);
    }
    if (junk.demoUsageRows > 0) {
      lines.push(
        since !== null
          ? `${junk.demoUsageRows} demo usage_log row(s) since ${since}`
          : `${junk.demoUsageRows} demo usage_log row(s) (needs --since to delete)`,
      );
    }
    if (lines.length === 0) {
      process.stdout.write("Nothing eval-related to remove.\n");
      return;
    }
    if (dryRun) {
      process.stdout.write("Would remove (dry run, nothing deleted):\n");
      for (const line of lines) process.stdout.write(`  ${line}\n`);
      return;
    }
    const removed = await removeEvalJunk(supabase, junk, demoClientId, since);
    process.stdout.write(
      `Removed ${removed.tenants} tenant(s), ${removed.contacts} contact(s), ` +
        `${removed.usageLog} usage row(s), ${removed.sheetOutbox} sheet row(s).\n`,
    );
  };

  run().catch((err: unknown) => {
    process.stderr.write(
      `eval:cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
