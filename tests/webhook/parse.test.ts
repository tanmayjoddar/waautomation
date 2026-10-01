/**
 * Parser tests. The fixtures use the shape Meta documents, so a change in Meta's
 * payload shows up here rather than as an empty ingest summary.
 */
import { describe, expect, it } from 'vitest';
import { parseWebhookPayload } from '../../src/webhook/parse.js';

/** Wraps messages the way Meta delivers them. */
function payload(
  messages: unknown[],
  options: { phoneNumberId?: string | null; statuses?: unknown[]; extraChange?: boolean } = {},
): unknown {
  const { phoneNumberId = 'PN-1', statuses = [], extraChange = false } = options;
  const change: Record<string, unknown> = { field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550001111', phone_number_id: phoneNumberId }, ...(messages.length > 0 ? { messages } : {}), ...(statuses.length > 0 ? { statuses } : {}) } };
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA-1',
        changes: extraChange
          ? [
              change,
              { field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550001111', phone_number_id: 'PN-2' }, messages: [{ from: '15559992222', id: 'wamid.SECOND', timestamp: '10', type: 'text', text: { body: 'second business' } }] } },
            ]
          : [change],
      },
    ],
  };
}

const textMessage = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  from: '15551234567',
  id: 'wamid.TEXT1',
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'hello there' },
  ...overrides,
});

describe('parseWebhookPayload: envelope', () => {
  it('extracts phone_number_id and every message of a change', () => {
    const result = parseWebhookPayload(payload([textMessage()]));
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ phoneNumberId: 'PN-1', unroutable: false });
    expect(result.changes[0]?.messages).toHaveLength(1);
  });

  it('reads every entry', () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        { id: 'A', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN-A' }, messages: [textMessage({ id: 'wamid.A' })] } }] },
        { id: 'B', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN-B' }, messages: [textMessage({ id: 'wamid.B' })] } }] },
      ],
    };
    const result = parseWebhookPayload(body);
    expect(result.changes.map((c) => c.phoneNumberId)).toEqual(['PN-A', 'PN-B']);
    expect(result.changes.flatMap((c) => c.messages.map((m) => m.wamid))).toEqual(['wamid.A', 'wamid.B']);
  });

  it('reads every change of an entry', () => {
    const result = parseWebhookPayload(payload([textMessage({ id: 'wamid.ONE' })], { extraChange: true }));
    expect(result.changes).toHaveLength(2);
    expect(result.changes.map((c) => c.phoneNumberId)).toEqual(['PN-1', 'PN-2']);
  });

  it('flattens several messages sent in one webhook', () => {
    const result = parseWebhookPayload(payload([textMessage({ id: 'wamid.1' }), textMessage({ id: 'wamid.2' }), textMessage({ id: 'wamid.3' })]));
    expect(result.changes[0]?.messages.map((m) => m.wamid)).toEqual(['wamid.1', 'wamid.2', 'wamid.3']);
  });

  it('ignores an entry with no changes', () => {
    const result = parseWebhookPayload({ object: 'whatsapp_business_account', entry: [{ id: 'A' }, { id: 'B', changes: [] }] });
    expect(result.changes).toEqual([]);
  });

  it('treats a missing phone_number_id as unroutable rather than throwing', () => {
    const result = parseWebhookPayload(payload([textMessage()], { phoneNumberId: null }));
    expect(result.changes[0]).toMatchObject({ phoneNumberId: null, unroutable: true });
  });
});

describe('parseWebhookPayload: message types', () => {
  const single = (message: unknown) => parseWebhookPayload(payload([message])).changes[0]?.messages[0];

  it('text', () => {
    expect(single(textMessage())).toEqual({
      kind: 'text',
      wamid: 'wamid.TEXT1',
      from: '15551234567',
      at: '2023-11-14T22:13:20.000Z',
      text: 'hello there',
    });
  });

  it('audio and voice notes, with the media id for later download', () => {
    const message = single({
      from: '15551234567',
      id: 'wamid.AUDIO',
      timestamp: '1700000001',
      type: 'audio',
      audio: { id: 'MEDIA-123', mime_type: 'audio/ogg; codecs=opus' },
    });
    expect(message).toMatchObject({ kind: 'audio', mediaId: 'MEDIA-123', voice: true });
  });

  it('an audio message Meta explicitly marks as not a voice note', () => {
    const message = single({ from: '1', id: 'wamid.A2', timestamp: '1', type: 'audio', audio: { id: 'M2', voice: false } });
    expect(message).toMatchObject({ kind: 'audio', voice: false });
  });

  it('keeps the media id of an image even though images are unsupported', () => {
    const message = single({ from: '1', id: 'wamid.IMG', timestamp: '1', type: 'image', image: { id: 'MEDIA-9' } });
    expect(message).toMatchObject({ kind: 'unsupported', metaType: 'image' });
  });

  it('a template button: caption, machine payload and the message it answered', () => {
    const message = single({
      from: '15551234567',
      id: 'wamid.BTN',
      timestamp: '1700000002',
      type: 'button',
      button: { payload: 'CONFIRM', text: 'Confirm booking' },
      context: { id: 'wamid.PREVIOUS', forwarded: false, frequently_forwarded: false },
    });
    expect(message).toEqual({
      kind: 'button',
      wamid: 'wamid.BTN',
      from: '15551234567',
      at: '2023-11-14T22:13:22.000Z',
      text: 'Confirm booking',
      payload: 'CONFIRM',
      contextWamid: 'wamid.PREVIOUS',
    });
  });

  it('a button without a context', () => {
    const message = single({ from: '1', id: 'wamid.B2', timestamp: '1', type: 'button', button: { payload: 'P', text: 'T' } });
    expect(message).toMatchObject({ kind: 'button', contextWamid: null });
  });

  it('an interactive button reply', () => {
    const message = single({
      from: '15551234567',
      id: 'wamid.INT',
      timestamp: '1700000003',
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'bt-1', title: 'Yes' } },
    });
    expect(message).toMatchObject({ kind: 'interactive', interactiveType: 'button_reply', replyId: 'bt-1', text: 'Yes' });
  });

  it('an interactive list reply', () => {
    const message = single({
      from: '1',
      id: 'wamid.LIST',
      timestamp: '1',
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id: 'row-2', title: 'Haircut', description: '30 min' } },
    });
    expect(message).toMatchObject({ kind: 'interactive', interactiveType: 'list_reply', replyId: 'row-2', text: 'Haircut' });
  });

  it('an interactive flow reply, using the response since there is no title', () => {
    const message = single({ from: '1', id: 'wamid.FLOW', timestamp: '1', type: 'interactive', interactive: { type: 'flow_reply', flow_reply: { id: 'flow-1', response: '{"slot":"x"}' } } });
    expect(message).toMatchObject({ kind: 'interactive', interactiveType: 'flow_reply', replyId: 'flow-1', text: '{"slot":"x"}' });
  });

  it('unsupported: image', () => {
    expect(single({ from: '1', id: 'wamid.I', timestamp: '1', type: 'image', image: { id: 'm' } })).toMatchObject({ kind: 'unsupported', metaType: 'image' });
  });

  it('unsupported: location', () => {
    expect(single({ from: '1', id: 'wamid.L', timestamp: '1', type: 'location', location: { latitude: 1, longitude: 2 } })).toMatchObject({ kind: 'unsupported', metaType: 'location' });
  });

  it('unsupported: sticker', () => {
    expect(single({ from: '1', id: 'wamid.S', timestamp: '1', type: 'sticker' })).toMatchObject({ kind: 'unsupported', metaType: 'sticker' });
  });

  it('unsupported: an entirely unknown type', () => {
    expect(single({ from: '1', id: 'wamid.X', timestamp: '1', type: 'reaction', reaction: { message_id: 'z' } })).toMatchObject({ kind: 'unsupported', metaType: 'reaction' });
  });

  it('unsupported: a text message with no body', () => {
    expect(single({ from: '1', id: 'wamid.EMPTY', timestamp: '1', type: 'text' })).toMatchObject({ kind: 'unsupported', metaType: 'text' });
  });

  it('unsupported: an audio message with no media id', () => {
    expect(single({ from: '1', id: 'wamid.NOAUDIO', timestamp: '1', type: 'audio', audio: {} })).toMatchObject({ kind: 'unsupported', metaType: 'audio' });
  });

  it('unsupported: a message with no id at all', () => {
    const message = single({ from: '1', timestamp: '1', type: 'text', text: { body: 'x' } });
    expect(message).toMatchObject({ kind: 'unsupported', wamid: null, metaType: 'text' });
  });

  it('a message with no sender, even with an id', () => {
    const message = single({ id: 'wamid.NOFROM', timestamp: '1', type: 'text', text: { body: 'x' } });
    expect(message).toMatchObject({ kind: 'unsupported', wamid: null, from: null });
  });

  it('an unusable timestamp becomes the epoch rather than NaN', () => {
    expect(single({ from: '1', id: 'wamid.T', timestamp: 'not-a-date', type: 'text', text: { body: 'x' } })).toMatchObject({ at: '1970-01-01T00:00:00.000Z' });
  });

  it('a numeric timestamp is accepted', () => {
    expect(single({ from: '1', id: 'wamid.T2', timestamp: 1700000000, type: 'text', text: { body: 'x' } })).toMatchObject({ at: '2023-11-14T22:13:20.000Z' });
  });
});

describe('parseWebhookPayload: statuses', () => {
  const status = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'wamid.OUT1',
    status: 'delivered',
    timestamp: '1700000005',
    recipient_id: '15551234567',
    conversation: { id: 'CONV-1', origin: { type: 'service' } },
    pricing: { billable: true, pricing_model: 'CBP' },
    ...overrides,
  });

  it('reads a delivered status', () => {
    const result = parseWebhookPayload(payload([], { statuses: [status()] }));
    expect(result.changes[0]?.statuses).toEqual([
      { wamid: 'wamid.OUT1', status: 'delivered', at: '2023-11-14T22:13:25.000Z', errorCode: null, errorTitle: null },
    ]);
  });

  it('reads each status in the array', () => {
    const result = parseWebhookPayload(payload([], { statuses: [status({ id: 'wamid.O1', status: 'sent' }), status({ id: 'wamid.O2', status: 'delivered' })] }));
    expect(result.changes[0]?.statuses.map((s) => `${s.wamid}:${s.status}`)).toEqual(['wamid.O1:sent', 'wamid.O2:delivered']);
  });

  it('keeps the error code and title of a failed status', () => {
    const result = parseWebhookPayload(payload([], { statuses: [status({ status: 'failed', errors: [{ code: 131047, error_data: { details: 'Re-engagement message' }, title: 'Re-engagement message' }] })] }));
    expect(result.changes[0]?.statuses[0]).toMatchObject({ status: 'failed', errorCode: 131047, errorTitle: 'Re-engagement message' });
  });

  it('falls back to error_data.details when there is no title', () => {
    const result = parseWebhookPayload(payload([], { statuses: [status({ status: 'failed', errors: [{ code: 131047, error_data: { details: 'Rate limit hit' } }] })] }));
    expect(result.changes[0]?.statuses[0]).toMatchObject({ errorCode: 131047, errorTitle: 'Rate limit hit' });
  });

  it('reads a status whose error entry has no code', () => {
    const result = parseWebhookPayload(payload([], { statuses: [status({ status: 'failed', errors: [{ title: 'Something' }] })] }));
    expect(result.changes[0]?.statuses[0]).toMatchObject({ errorCode: null, errorTitle: 'Something' });
  });

  it('a status with no error code has null fields, not undefined', () => {
    const result = parseWebhookPayload(payload([], { statuses: [status()] }));
    expect(result.changes[0]?.statuses[0]?.errorCode).toBeNull();
    expect(result.changes[0]?.statuses[0]?.errorTitle).toBeNull();
  });

  it('drops a status with no id', () => {
    const result = parseWebhookPayload(payload([], { statuses: [{ status: 'delivered', timestamp: '1' }] }));
    expect(result.changes[0]?.statuses).toEqual([]);
  });

  it('reads a status with no metadata phone number as unroutable', () => {
    const result = parseWebhookPayload({ object: 'whatsapp_business_account', entry: [{ id: 'A', changes: [{ field: 'messages', value: { metadata: {}, statuses: [status()] } }] }] });
    expect(result.changes[0]).toMatchObject({ unroutable: true });
    expect(result.changes[0]?.statuses).toHaveLength(1);
  });

  it('handles a status-only webhook (no messages key at all)', () => {
    const result = parseWebhookPayload({ object: 'whatsapp_business_account', entry: [{ id: 'A', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN-1' }, statuses: [status()] } }] }] });
    expect(result.changes[0]?.messages).toEqual([]);
    expect(result.changes[0]?.statuses).toHaveLength(1);
  });

  it('handles messages and statuses in the same change', () => {
    const result = parseWebhookPayload(payload([textMessage()], { statuses: [status()] }));
    expect(result.changes[0]?.messages).toHaveLength(1);
    expect(result.changes[0]?.statuses).toHaveLength(1);
  });
});

describe('parseWebhookPayload: never throws', () => {
  const garbage: unknown[] = [null, undefined, 0, 42, '', 'text', true, [], {}, { entry: [] }, { entry: null }, { entry: 'x' }, { entry: [{ changes: 'x' }] }, { entry: [{ changes: [null] }] }, { entry: [{ changes: [{ value: null }] }] }, { entry: [{ changes: [{ value: { metadata: null, messages: null, statuses: null } }] }] }, { entry: [{ changes: [{ value: { metadata: {}, messages: [null, 5, 'x'] } }] }] }, { entry: [{ changes: [{ value: { metadata: {}, statuses: [null] } }] }] }];

  for (const [index, value] of garbage.entries()) {
    it(`survives input #${index}`, () => {
      const result = parseWebhookPayload(value);
      expect(Array.isArray(result.changes)).toBe(true);
    });
  }

  it('returns no changes for a completely empty object', () => {
    expect(parseWebhookPayload({}).changes).toEqual([]);
  });
});