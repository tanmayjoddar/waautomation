/**
 * TEMPORARY Slice 3 echo. SLICE 4 DELETES THIS FILE.
 *
 * While there is no worker and no AI, an inbound text to the demo client gets
 * an immediate `"I got: <text>"` reply so the human can verify the whole loop
 * (webhook -> send -> "typing..." -> reply -> status webhooks) with their own
 * phone. It is deliberately dumb: text messages only, demo client only.
 *
 * Safety rules (all tested in tests/db/echo.test.ts):
 *  - behind ECHO_MODE=true (see createEchoHooks below);
 *  - fires only for the client whose phone_number_id is WA_PHONE_NUMBER_ID,
 *    resolved to a client id at startup, so it can never reach a real tenant;
 *  - fires only through ingest's onMessageStored hook, which runs solely for
 *    newly stored rows, so a duplicate delivery can never cause a second send;
 *  - never throws into ingest: a Meta or DB failure is logged and the reply
 *    job is still enqueued, so Slice 4's worker sees the message anyway.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import { findClientByPhoneNumberId, insertOutboundMessage } from '../db/supabase.js';
import type { MessageType } from '../db/types.js';
import { createWhatsAppClient, type WhatsAppClient } from '../whatsapp/client.js';
import type { IngestDeps } from '../webhook/ingest.js';

export type EchoDeps = {
  supabase: SupabaseClient;
  whatsapp: WhatsAppClient;
  logger: Logger;
  /** The ONLY client id that may receive echoes. */
  demoClientId: string;
};

export type StoredMessageInfo = {
  clientId: string;
  contactId: string;
  contactPhone: string;
  wamid: string;
  type: MessageType;
  text: string | null;
};

/** 'sent' | 'skipped:<reason>' | 'failed'. Never throws. */
export async function handleStoredMessageForEcho(
  deps: EchoDeps,
  info: StoredMessageInfo,
): Promise<string> {
  const { supabase, whatsapp, logger, demoClientId } = deps;

  if (info.type !== 'text' || info.text === null || info.text === '') {
    // Text only: the polite "I can read text and voice notes" reply for other
    // types belongs to Slice 4+, not to this temporary echo.
    return 'skipped:not-text';
  }
  if (info.clientId !== demoClientId) {
    // Must never happen (the hook is only wired for the demo tenant), but a
    // second check here means a wiring mistake fails closed, not open.
    logger.warn({ clientId: info.clientId }, 'echo asked for a non-demo client: refused');
    return 'skipped:not-demo-client';
  }

  try {
    // Spec 1.6: "typing..." first. A failure here must not stop the reply, so
    // it is caught separately from the send below.
    try {
      await whatsapp.markReadAndType(info.wamid);
    } catch (err) {
      logger.warn({ err, wamid: info.wamid }, 'echo typing indicator failed, sending anyway');
    }

    const { wamid } = await whatsapp.sendText(info.contactPhone, `I got: ${info.text}`);
    await insertOutboundMessage(supabase, {
      clientId: info.clientId,
      contactId: info.contactId,
      wamid,
      type: 'text',
      text: `I got: ${info.text}`,
    });
    // No phone, no message text in the log: wamids and ids only.
    logger.info({ clientId: info.clientId, contactId: info.contactId, wamid }, 'echo reply sent');
    return 'sent';
  } catch (err) {
    logger.error({ err, clientId: info.clientId, contactId: info.contactId }, 'echo reply failed');
    return 'failed';
  }
}

/**
 * Builds the ingest hooks for server.ts. Returns undefined (echo disabled)
 * unless ECHO_MODE=true AND the demo WhatsApp config AND the demo client all
 * exist. Every disable path logs why, so "no echo" is always explainable.
 */
export async function createEchoHooks(args: {
  config: AppConfig;
  logger: Logger;
  supabase: SupabaseClient;
}): Promise<IngestDeps['hooks'] | undefined> {
  const { config, logger, supabase } = args;

  if (!config.echoMode) {
    logger.debug({}, 'echo disabled: ECHO_MODE is not true');
    return undefined;
  }
  if (config.whatsappDemo === null || config.meta === null) {
    logger.warn({}, 'ECHO_MODE=true but the demo WhatsApp config is incomplete (needs WA_PHONE_NUMBER_ID, WA_TOKEN and the META_* group): echo disabled');
    return undefined;
  }

  const demo = await findClientByPhoneNumberId(supabase, config.whatsappDemo.phoneNumberId);
  if (demo === null) {
    logger.warn(
      { phoneNumberId: config.whatsappDemo.phoneNumberId },
      'ECHO_MODE=true but no client has that phone_number_id (run npm run seed): echo disabled',
    );
    return undefined;
  }

  const whatsapp = createWhatsAppClient({
    phoneNumberId: config.whatsappDemo.phoneNumberId,
    token: config.whatsappDemo.token,
    graphApiVersion: config.meta.graphApiVersion,
    logger,
  });
  const deps: EchoDeps = { supabase, whatsapp, logger, demoClientId: demo.id };
  logger.info({ clientId: demo.id }, 'echo enabled for the demo client only (temporary, Slice 4 removes it)');

  return {
    // The wrapper is the throw-guard: ingest must enqueue the reply job even
    // when Meta is down, so nothing thrown here may reach it.
    onMessageStored: async (info) => {
      try {
        await handleStoredMessageForEcho(deps, info);
      } catch (err) {
        logger.error({ err }, 'echo hook failed');
      }
    },
  };
}
