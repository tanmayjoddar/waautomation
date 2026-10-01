/**
 * Normalises a WhatsApp Cloud API webhook payload (spec 1.6 steps 3-4).
 *
 * Pure and total: nothing in here does I/O and nothing throws. Meta sends many
 * shapes (several entries, several changes, several messages in one payload,
 * statuses mixed in with messages) and occasionally sends something we do not
 * recognise at all. An unrecognised thing must become a logged "unsupported",
 * never a 500 that makes Meta retry the whole delivery forever.
 */

type Json = unknown;

const isRecord = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = (v: Json): Json[] => (Array.isArray(v) ? v : []);
const asString = (v: Json): string | null => (typeof v === 'string' && v !== '' ? v : null);
const asRecord = (v: Json): Record<string, Json> => (isRecord(v) ? v : {});

/** Meta timestamps are unix seconds as a string. Returns null when unusable. */
export function unixSecondsToIso(value: Json): string | null {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : null;
  if (raw === null) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export type NormalizedMessage =
  | { kind: 'text'; wamid: string; from: string; at: string; text: string }
  | { kind: 'audio'; wamid: string; from: string; at: string; mediaId: string; voice: boolean }
  | {
      kind: 'button';
      wamid: string;
      from: string;
      at: string;
      /** Button caption, e.g. "Confirm". */
      text: string;
      /** Machine payload the business attached to the button, e.g. "CONFIRM". */
      payload: string;
      /** wamid of the message the tap answered (a template reminder). */
      contextWamid: string | null;
    }
  | {
      kind: 'interactive';
      wamid: string;
      from: string;
      at: string;
      /** button_reply / list_reply title shown to the customer. */
      text: string;
      /** The id of the chosen button or list row. */
      replyId: string;
      /** What kind of reply it was, kept for logging. */
      interactiveType: string;
    }
  /** image, sticker, location, document, contacts, unknown, or missing id. */
  | { kind: 'unsupported'; wamid: string | null; from: string | null; at: string; metaType: string };

export type NormalizedStatus = {
  wamid: string;
  /** sent | delivered | read | failed, or anything Meta adds later. */
  status: string;
  at: string;
  errorCode: number | null;
  errorTitle: string | null;
};

export type NormalizedChange = {
  /** The routing key: metadata.phone_number_id -> clients.phone_number_id. */
  phoneNumberId: string | null;
  profileName: string | null;
  messages: NormalizedMessage[];
  statuses: NormalizedStatus[];
  /** value.errors[]: Meta telling us the delivery itself failed. */
  errors: { code: number | null; title: string | null }[];
  /** True when the change had no phone_number_id and is therefore unroutable. */
  unroutable: boolean;
};

export type NormalizedPayload = { changes: NormalizedChange[] };

const normalizeMessage = (raw: Json): NormalizedMessage | null => {
  if (!isRecord(raw)) return null;
  const wamid = asString(raw.id);
  const at = unixSecondsToIso(raw.timestamp) ?? new Date(0).toISOString();
  const from = asString(raw.from);
  const metaType = asString(raw.type) ?? 'unknown';

  // No id means we cannot dedupe it, so it is not worth storing at all.
  if (wamid === null || from === null) {
    return { kind: 'unsupported', wamid: null, from, at, metaType };
  }

  if (metaType === 'text') {
    const body = isRecord(raw.text) ? asString(raw.text.body) : null;
    return body === null
      ? { kind: 'unsupported', wamid, from, at, metaType }
      : { kind: 'text', wamid, from, at, text: body };
  }

  if (metaType === 'audio' || metaType === 'voice') {
    const audio = isRecord(raw.audio) ? raw.audio : {};
    const mediaId = asString(audio.id);
    return mediaId === null
      ? { kind: 'unsupported', wamid, from, at, metaType }
      : { kind: 'audio', wamid, from, at, mediaId, voice: audio.voice !== false };
  }

  if (metaType === 'button') {
    const button = isRecord(raw.button) ? raw.button : {};
    const context = isRecord(raw.context) ? raw.context : {};
    return {
      kind: 'button',
      wamid,
      from,
      at,
      text: asString(button.text) ?? '',
      payload: asString(button.payload) ?? '',
      contextWamid: asString(context.id),
    };
  }

  if (metaType === 'interactive') {
    const node = asRecord(raw.interactive);
    const interactiveType = asString(node.type) ?? 'unknown';
    const reply = isRecord(node.button_reply)
      ? node.button_reply
      : isRecord(node.list_reply)
        ? node.list_reply
        : // A flow reply has no title; `response` is what the flow returned.
          isRecord(node.flow_reply)
          ? node.flow_reply
          : {};
    const label = asString(reply.title) ?? (interactiveType === 'flow_reply' ? asString(reply.response) : null) ?? '';
    return {
      kind: 'interactive',
      wamid,
      from,
      at,
      text: label,
      replyId: asString(reply.id) ?? '',
      interactiveType,
    };
  }

  return { kind: 'unsupported', wamid, from, at, metaType };
};

const normalizeStatus = (raw: Json): NormalizedStatus | null => {
  if (!isRecord(raw)) return null;
  const wamid = asString(raw.id);
  const status = asString(raw.status);
  if (wamid === null || status === null) return null;
  // errors is an ARRAY (one entry per error Meta reports); isRecord() rejects
  // arrays, so it has to be unwrapped explicitly or failures lose their reason.
  const errors = asArray(raw.errors);
  const error = isRecord(errors[0]) ? errors[0] : undefined;
  const code = error !== undefined && typeof error.code === 'number' ? error.code : null;
  return {
    wamid,
    status,
    at: unixSecondsToIso(raw.timestamp) ?? new Date(0).toISOString(),
    errorCode: code,
    errorTitle: error !== undefined ? asString(error.title) ?? asString(asRecord(error.error_data).details) : null,
  };
};

const normalizeChange = (raw: Json): NormalizedChange => {
  const value = isRecord(raw) && isRecord(raw.value) ? raw.value : {};
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const contacts = asArray(value.contacts);
  const firstContact = isRecord(contacts[0]) ? contacts[0] : undefined;
  const profile = firstContact && isRecord(firstContact.profile) ? firstContact.profile : undefined;

  const messages = asArray(value.messages)
    .map(normalizeMessage)
    .filter((m): m is NormalizedMessage => m !== null);
  const statuses = asArray(value.statuses)
    .map(normalizeStatus)
    .filter((s): s is NormalizedStatus => s !== null);
  const errors = asArray(value.errors)
    .map((e) => (isRecord(e) ? { code: typeof e.code === 'number' ? e.code : null, title: asString(e.title) } : null))
    .filter((e): e is { code: number | null; title: string | null } => e !== null);

  return {
    phoneNumberId: asString(metadata.phone_number_id),
    profileName: asString(profile?.name),
    messages,
    statuses,
    errors,
    unroutable: asString(metadata.phone_number_id) === null,
  };
};

/** Walks entry[] -> changes[] -> { messages[], statuses[] }. */
export function parseWebhookPayload(payload: Json): NormalizedPayload {
  if (!isRecord(payload)) return { changes: [] };
  const changes = asArray(payload.entry)
    .flatMap((entry) => (isRecord(entry) ? asArray(entry.changes) : []))
    .map(normalizeChange);
  return { changes };
}