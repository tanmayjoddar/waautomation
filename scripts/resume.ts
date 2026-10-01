/**
 * Resume a handed-over chat: `npm run resume -- <phone>`.
 *
 * Sets bot_paused=false and status back to new for one DEMO-client contact,
 * so the worker answers them again. Demo client only: the contact is looked
 * up strictly inside the WA_PHONE_NUMBER_ID tenant, and the script refuses
 * when the phone belongs to nobody (or to another tenant, which it cannot see
 * because the lookup is scoped).
 */
import { pathToFileURL } from 'node:url';
import { loadEnvFromFile } from '../src/config.js';
import { createServiceClient } from '../src/db/supabase.js';

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const run = async (): Promise<void> => {
    const phone = process.argv.slice(2).find((a) => !a.startsWith('-'))?.replace(/^\+/, '').trim() ?? '';
    if (phone === '') {
      process.stderr.write('Usage: npm run resume -- <phone>  (digits, e.g. npm run resume -- 919812345678)\n');
      process.exit(1);
    }
    const config = loadEnvFromFile();
    if (config.whatsappDemo === null) {
      process.stderr.write('Demo WhatsApp config is missing: set WA_PHONE_NUMBER_ID and WA_TOKEN in .env first.\n');
      process.exit(1);
    }
    const supabase = createServiceClient(config);
    const { data: demo, error: demoError } = await supabase
      .from('clients')
      .select('id, business_name')
      .eq('phone_number_id', config.whatsappDemo.phoneNumberId)
      .maybeSingle();
    if (demoError) {
      process.stderr.write(`Cannot look up the demo client: ${demoError.message}\n`);
      process.exit(1);
    }
    if (!demo) {
      process.stderr.write('No client has WA_PHONE_NUMBER_ID. Run npm run seed first.\n');
      process.exit(1);
    }
    const demoId = (demo as { id: string }).id;
    const { data: updated, error } = await supabase
      .from('contacts')
      .update({ bot_paused: false, status: 'new' })
      .eq('client_id', demoId)
      .eq('phone', phone)
      .select('id,bot_paused,status');
    if (error) {
      process.stderr.write(`Resume failed: ${error.message}\n`);
      process.exit(1);
    }
    if ((updated ?? []).length === 0) {
      process.stderr.write(`No contact ${phone} on the demo client "${(demo as { business_name: string }).business_name}".\n`);
      process.exit(1);
    }
    process.stdout.write(`Resumed ${phone}: bot_paused=false, status=new. The worker will answer them again.\n`);
  };

  run().catch((err: unknown) => {
    process.stderr.write(`resume failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
