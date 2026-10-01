/**
 * Webhook ingest (spec 1.6 steps 3-4). Runs AFTER the 200 has been sent, because
 * Meta retries anything that takes too long and a retry is a duplicate delivery
 * we then have to ignore.
 *
 * The pipeline per change:
 *   resolve the tenant from metadata.phone_number_id -> unknown id is logged and
 *   ignored (spec: an unknown id is not an error, it is another business's number
 *   on a shared WABA);
 *   statuses[] -> messages.status by wamid;
 *   messages[] -> dedupe by (client_id, wamid), store, then hand off.
 *
 * Nothing here logs a phone number or message text. The logger would mask a
 * phone, but a customer's words are not something to log at all, so the fields
 * below deliberately carry ids, types and counts only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import {
  enqueueReplyJob,
  findClientByPhoneNumberId,
  findOrCreateContact,
  insertInboundMessage,
  messageAlreadyStored,
  queueSheetContact,
  updateMessageStatus,
} from '../db/supabase.js';
import type { MessageType } from '../db/types.js';
import { parseWebhookPayload, type NormalizedChange, type NormalizedMessage } from './parse.js';

export type IngestDeps = {
  supabase: SupabaseClient;
  logger: Logger;
  /** Seconds of debounce for the reply job. */
  debounceSeconds: number;
  /**
   * Hooks for later slices, all no-ops here. Slice 3 sends "typing..." and the
   * temporary echo, Slice 7 runs the booking confirmation handler, Slice 4/8
   * own the worker.
   *
   * onMessageStored fires ONLY for a newly stored message: both duplicate
   * paths return before it, so a Meta retry can never trigger a second send.
   * The contact phone and text travel in the arguments (never in a log line);
   * the Slice 3 echo needs the phone to reply to and the text to echo.
   */
  hooks?: {
    /** Spec 1.6: mark read + show typing as soon as the message lands. */
    onMessageStored?: (info: {
      clientId: string;
      contactId: string;
      contactPhone: string;
      wamid: string;
      type: MessageType;
      text: string | null;
    }) => void | Promise<void>;
    /** Spec 1.6: one polite reply for a type we cannot read. */
    onUnsupportedType?: (info: { clientId: string; wamid: string | null }) => void | Promise<void>;
  };
};

export type IngestSummary = {
  changes: number;
  unroutable: number;
  unknownPhoneNumberId: number;
  statusesApplied: number;
  statusesUnknown: number;
  stored: number;
  duplicates: number;
  unsupported: number;
  paused: number;
  jobsEnqueued: number;
  errors: number;
};

const emptySummary = (): IngestSummary => ({
  changes: 0,
  unroutable: 0,
  unknownPhoneNumberId: 0,
  statusesApplied: 0,
  statusesUnknown: 0,
  stored: 0,
  duplicates: 0,
  unsupported: 0,
  paused: 0,
  jobsEnqueued: 0,
  errors: 0,
});

/** DB type for a normalised message. Anything we cannot read is stored as `other`. */
const toMessageType = (message: NormalizedMessage): MessageType => {
  switch (message.kind) {
    case 'text':
      return 'text';
    case 'audio':
      return 'audio';
    case 'interactive':
      return 'interactive';
    // A template quick-reply tap is stored as 'template': it is an answer to a
    // message this business sent, and Slice 7 looks for exactly that.
    case 'button':
      return 'template';
    default:
      return 'other';
  }
};

/** The text we keep. Never logged. */
const toStoredText = (message: NormalizedMessage): string | null => {
  switch (message.kind) {
    case 'text':
      return message.text;
    case 'button':
      // "Confirm" plus the machine payload, so the booking handler can match
      // CONFIRM/CANCEL without another Meta call.
      return message.payload === '' ? message.text : `${message.payload}: ${message.text}`.trim();
    case 'interactive':
      return message.replyId === '' ? message.text : `${message.replyId}: ${message.text}`.trim();
    default:
      return null;
  }
};

async function handleStatus(
  deps: IngestDeps,
  clientId: string,
  status: { wamid: string; status: string; errorCode: number | null; errorTitle: string | null },
  summary: IngestSummary,
): Promise<void> {
  const applied = await updateMessageStatus(deps.supabase, clientId, status.wamid, status.status);
  if (!applied) {
    // Normal for a status for a message sent before the retention window, or for
    // a message we never stored. Logged with the wamid only.
    summary.statusesUnknown += 1;
    deps.logger.debug({ clientId, wamid: status.wamid, status: status.status }, 'status for an unknown wamid');
    return;
  }
  summary.statusesApplied += 1;
  if (status.errorCode !== null) {
    deps.logger.warn(
      { clientId, wamid: status.wamid, status: status.status, errorCode: status.errorCode, errorTitle: status.errorTitle },
      'message delivery failed',
    );
  } else {
    deps.logger.debug({ clientId, wamid: status.wamid, status: status.status }, 'message status updated');
  }
}

async function handleMessage(
  deps: IngestDeps,
  clientId: string,
  contactPhone: string,
  profileName: string | null,
  message: NormalizedMessage,
  summary: IngestSummary,
): Promise<void> {
  const type = toMessageType(message);

  // A message with no id cannot be deduped and must not be stored.
  if (message.wamid === null || message.from === null) {
    summary.unsupported += 1;
    deps.logger.warn({ clientId, metaType: message.kind }, 'ignoring a message with no id');
    return;
  }

  // Fast path for the common case: Meta retried a delivery we already handled.
  // Returns before any write, so a duplicate touches nothing at all.
  if (await messageAlreadyStored(deps.supabase, clientId, message.wamid)) {
    summary.duplicates += 1;
    deps.logger.debug({ clientId, wamid: message.wamid }, 'duplicate delivery ignored');
    return;
  }

  const { contact, created } = await findOrCreateContact(deps.supabase, clientId, contactPhone, {
    name: profileName,
    last_inbound_at: message.at,
  });

  const storedText = toStoredText(message);
  const stored = await insertInboundMessage(deps.supabase, {
    clientId,
    contactId: contact.id,
    wamid: message.wamid,
    type,
    text: storedText,
    mediaId: message.kind === 'audio' ? message.mediaId : null,
    at: message.at,
  });

  if (stored === null) {
    // Lost a race against a concurrent delivery of the same wamid: the unique
    // constraint decided, and nothing else may happen (spec 1.6 step 4).
    summary.duplicates += 1;
    deps.logger.debug({ clientId, wamid: message.wamid }, 'duplicate delivery ignored');
    return;
  }

  summary.stored += 1;
  deps.logger.info({ clientId, contactId: contact.id, wamid: message.wamid, type }, 'inbound message stored');

  if (created) {
    await queueSheetContact(deps.supabase, clientId, contact.id);
    deps.logger.info({ clientId, contactId: contact.id }, 'new contact queued for the sheet');
  }

  // Fire and forget: the customer should see "typing..." before we queue any work.
  // The hook runs only here, after a genuinely new row: duplicates returned
  // above, so they can never cause a second send.
  await deps.hooks?.onMessageStored?.({
    clientId,
    contactId: contact.id,
    contactPhone,
    wamid: message.wamid,
    type,
    text: storedText,
  });

  if (message.kind === 'unsupported') {
    summary.unsupported += 1;
    deps.logger.info({ clientId, wamid: message.wamid, metaType: message.metaType }, 'unsupported message type');
    await deps.hooks?.onUnsupportedType?.({ clientId, wamid: message.wamid });
    return;
  }

  // Spec 1.6: the confirmation handler runs before this check and even while
  // paused (Slice 7 hooks in above onMessageStored). Then: a paused contact is a
  // human's job, so no reply job.
  if (contact.bot_paused) {
    summary.paused += 1;
    deps.logger.info({ clientId, contactId: contact.id }, 'contact is paused: no reply job');
    return;
  }

  await enqueueReplyJob(deps.supabase, clientId, contact.id, deps.debounceSeconds);
  summary.jobsEnqueued += 1;
}

async function handleChange(deps: IngestDeps, change: NormalizedChange, summary: IngestSummary): Promise<void> {
  summary.changes += 1;

  if (change.unroutable || change.phoneNumberId === null) {
    summary.unroutable += 1;
    deps.logger.warn({}, 'webhook change without a phone_number_id: ignored');
    return;
  }

  const client = await findClientByPhoneNumberId(deps.supabase, change.phoneNumberId);
  if (client === null) {
    // Another business shares this WABA. Spec: log and ignore, never create a
    // tenant from an inbound payload.
    summary.unknownPhoneNumberId += 1;
    deps.logger.warn({ phoneNumberId: change.phoneNumberId }, 'unknown phone_number_id: ignored');
    return;
  }

  const clientId = client.id;
  if (!client.active) {
    deps.logger.info({ clientId }, 'client is inactive: webhook ignored');
    return;
  }

  for (const error of change.errors) {
    summary.errors += 1;
    deps.logger.warn({ clientId, code: error.code, title: error.title }, 'Meta reported a webhook error');
  }

  for (const status of change.statuses) {
    await handleStatus(deps, clientId, status, summary);
  }

  for (const message of change.messages) {
    // Meta sends the sender in both places; `from` on the message is the one that
    // identifies the contact.
    const phone = message.from;
    if (phone === null) {
      summary.unsupported += 1;
      deps.logger.warn({ clientId }, 'message without a sender: ignored');
      continue;
    }
    await handleMessage(deps, clientId, phone, change.profileName, message, summary);
  }
}

/** Processes one whole delivery. Never throws: a failure here must not 500. */
export async function ingestWebhookPayload(deps: IngestDeps, payload: unknown): Promise<IngestSummary> {
  const summary = emptySummary();
  const { changes } = parseWebhookPayload(payload);

  for (const change of changes) {
    try {
      await handleChange(deps, change, summary);
    } catch (error) {
      // One bad change must not abandon the rest of the delivery.
      summary.errors += 1;
      deps.logger.error({ err: error }, 'webhook change failed');
    }
  }

  deps.logger.info(summary, 'webhook delivery processed');
  return summary;
}