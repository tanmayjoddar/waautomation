/**
 * Operator alerts CLI: `npm run alerts` lists open alerts,
 * `npm run alerts -- ack <id>` acknowledges one.
 *
 * Handover (needs_staff contacts) and failed jobs show up here. Reads use the
 * service role because this is the operator's own terminal, not the dashboard
 * (dashboard users see only their client's rows via RLS instead).
 */
import { pathToFileURL } from "node:url";
import { loadEnvFromFile } from "../src/config.js";
import { createServiceClient } from "../src/db/supabase.js";
import {
  acknowledgeAlert,
  listOpenAlerts,
  type OpenAlert,
} from "../src/staff/alerts.js";

export function formatAlertRow(row: OpenAlert): string {
  const short = row.id.slice(0, 8);
  const age = Math.round(
    (Date.now() - Date.parse(row.created_at)) / 60_000,
  );
  const who = [row.business_name ?? row.client_id.slice(0, 8), row.contact_phone ?? null]
    .filter((part) => part !== null)
    .join(" / ");
  return `${short}  ${row.kind}  ${who}  ${row.reason}  (${age}m ago)`;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const run = async (): Promise<void> => {
    const config = loadEnvFromFile();
    const supabase = createServiceClient(config);
    const [command, arg] = process.argv.slice(2);

    if (command === undefined) {
      const rows = await listOpenAlerts(supabase);
      if (rows.length === 0) {
        process.stdout.write("No open alerts.\n");
        return;
      }
      for (const row of rows) process.stdout.write(`${formatAlertRow(row)}\n`);
      process.stdout.write(
        `\n${rows.length} open alert(s). Acknowledge one with: npm run alerts -- ack <id>\n`,
      );
      return;
    }

    if (command === "ack" && arg !== undefined) {
      const row = await acknowledgeAlert(supabase, arg);
      process.stdout.write(
        `Acknowledged ${row.id.slice(0, 8)} (${row.kind}).\n`,
      );
      return;
    }

    process.stderr.write("Usage:\n  npm run alerts\n  npm run alerts -- ack <id>\n");
    process.exit(1);
  };

  run().catch((err: unknown) => {
    process.stderr.write(
      `alerts failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
