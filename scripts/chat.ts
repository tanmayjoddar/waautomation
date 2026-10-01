/**
 * Interactive console chat (Slice 3): talk to the bot as a fake customer of
 * the demo client, without Meta delivery.
 *
 *   npm run chat
 *
 * Each line you type runs the REAL ingest pipeline (contact upsert, dedupe,
 * message store, reply job enqueue, echo hooks) against the demo tenant, with
 * a fake WhatsApp client standing in for Meta: the reply prints here and the
 * out row is saved with a fake wamid. The debounce is skipped (delay 0), so
 * the reply comes back immediately instead of waiting for a worker.
 *
 * The fake customer is one fixed contact. Its rows live in the demo tenant
 * while you chat (open Table Editor mid-session to inspect them) and are
 * deleted on exit: the contact cascades to messages/jobs, and the contact's
 * sheet_outbox rows (no foreign key) are removed explicitly first.
 */
import { pathToFileURL } from 'node:url';
import * as readline from 'node:readline';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import { loadEnvFromFile, type AppConfig } from '../src/config.js';
import { createServiceClient } from '../src/db/supabase.js';
import { createLogger } from '../src/logger.js';
import { handleStoredMessageForEcho, type EchoDeps } from '../src/services/echo.js';
import { consoleClient } from '../src/whatsapp/sendMode.js';
import { createFakeWhatsAppClient } from '../src/whatsapp/fake.js';
import { ingestWebhookPayload, type IngestSummary } from '../src/webhook/ingest.js';

/** Fixed fake customer number (E.164 digits). Never a real phone. */
export const CHAT_CONTACT_PHONE = '15550001111';
const CHAT_PROFILE_NAME = 'Chat Tester';

export type ChatDeps = {
  supabase: SupabaseClient;
  logger: Logger;
  demoClientId: string;
  demoPhoneNumberId: string;
  contactPhone?: string;
  /** Prints lines to the human. Defaults to process.stdout. */
  out?: { write(chunk: string): void };
};

export type ChatReply = { summary: IngestSummary; replies: string[] };

let chatCounter = 0;

/**
 * One chat turn: stores the typed text through the real pipeline and returns
 * whatever replies the (fake) sends produced. Exported for tests.
 */
export async function chatOnce(deps: ChatDeps, text: string): Promise<ChatReply> {
  const phone = deps.contactPhone ?? CHAT_CONTACT_PHONE;
  const out = deps.out ?? process.stdout;
  chatCounter += 1;
  const wamid = `wamid.CHAT.${Date.now().toString(36)}.${chatCounter}`;

  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA-CHAT',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: deps.demoPhoneNumberId },
              contacts: [{ profile: { name: CHAT_PROFILE_NAME }, wa_id: phone }],
              messages: [
                {
                  from: phone,
                  id: wamid,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const sender = consoleClient(createFakeWhatsAppClient(), out);
  const echo: EchoDeps = {
    supabase: deps.supabase,
    whatsapp: sender,
    logger: deps.logger,
    demoClientId: deps.demoClientId,
  };
  // Debounce skipped: delay 0 puts the job due now instead of waiting for a
  // worker that does not exist yet (Slice 4 owns the worker).
  const summary = await ingestWebhookPayload(
    {
      supabase: deps.supabase,
      logger: deps.logger,
      debounceSeconds: 0,
      hooks: {
        onMessageStored: async (info) => {
          await handleStoredMessageForEcho(echo, info);
        },
      },
    },
    payload,
  );
  return { summary, replies: sender.fake.sent.map((s) => s.body) };
}

/** Removes everything this script wrote: the chat contact and its orphans. */
export async function cleanupChatRows(
  supabase: SupabaseClient,
  clientId: string,
  contactPhone: string = CHAT_CONTACT_PHONE,
): Promise<{ contacts: number; sheetOutbox: number }> {
  const { data: contacts, error } = await supabase.from('contacts').select('id').eq('client_id', clientId).eq('phone', contactPhone);
  if (error) throw new Error(`cannot list chat contacts: ${error.message}`);
  const ids = (contacts ?? []).map((c) => c.id as string);
  if (ids.length === 0) return { contacts: 0, sheetOutbox: 0 };

  // sheet_outbox.entity_id has no foreign key: delete explicitly first.
  const { data: outbox, error: outboxError } = await supabase
    .from('sheet_outbox')
    .delete()
    .eq('client_id', clientId)
    .eq('entity', 'contact')
    .in('entity_id', ids)
    .select('id');
  if (outboxError) throw new Error(`cannot delete chat sheet_outbox rows: ${outboxError.message}`);

  const { data: removed, error: contactError } = await supabase.from('contacts').delete().in('id', ids).select('id');
  if (contactError) throw new Error(`cannot delete chat contacts: ${contactError.message}`);
  return { contacts: removed?.length ?? 0, sheetOutbox: outbox?.length ?? 0 };
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// Only run when executed directly, not when imported by a test.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const run = async (): Promise<void> => {
    const config: AppConfig = loadEnvFromFile();
    if (config.whatsappDemo === null) {
      fail('Demo WhatsApp config is missing: set WA_PHONE_NUMBER_ID and WA_TOKEN in .env first.');
    }
    const logger = createLogger({ level: config.logLevel });
    const supabase = createServiceClient(config);
    const { data: demo, error } = await supabase
      .from('clients')
      .select('id, business_name')
      .eq('phone_number_id', (config.whatsappDemo as { phoneNumberId: string }).phoneNumberId)
      .maybeSingle();
    if (error) fail(`Cannot look up the demo client: ${error.message}`);
    if (!demo) fail('No client has WA_PHONE_NUMBER_ID. Run npm run seed first.');

    const demoId = (demo as { id: string }).id;
    const demoName = (demo as { business_name: string }).business_name;
    process.stdout.write(`Chatting with "${demoName}" as a fake customer (SEND_MODE is irrelevant here: sends never reach Meta).\n`);
    process.stdout.write(`Rows live in the demo tenant while you chat; they are deleted on exit. Type /quit to leave.\n`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
    let closed = false;
    const cleanup = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        const removed = await cleanupChatRows(supabase, demoId);
        process.stdout.write(`\nCleaned up ${removed.contacts} chat contact(s) and ${removed.sheetOutbox} sheet row(s).\n`);
      } catch (err) {
        process.stderr.write(`\nCleanup failed (rows may remain - delete the ${CHAT_CONTACT_PHONE} contact by hand): ${err instanceof Error ? err.message : String(err)}\n`);
      }
      process.exit(0);
    };
    rl.on('close', () => void cleanup());
    rl.on('SIGINT', () => void cleanup());
    rl.prompt();

    for await (const line of rl) {
      const text = line.trim();
      if (text === '' || text === '/quit') {
        if (text === '/quit') rl.close();
        else rl.prompt();
        continue;
      }
      try {
        const { summary, replies } = await chatOnce(
          { supabase, logger, demoClientId: demoId, demoPhoneNumberId: (config.whatsappDemo as { phoneNumberId: string }).phoneNumberId },
          text,
        );
        if (replies.length === 0) {
          process.stdout.write(`bot> (no reply - stored:${summary.stored} jobs:${summary.jobsEnqueued})\n`);
        } else {
          for (const reply of replies) process.stdout.write(`bot> ${reply}\n`);
        }
      } catch (err) {
        process.stderr.write(`chat turn failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      rl.prompt();
    }
  };

  run().catch((err: unknown) => {
    process.stderr.write(`chat failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
