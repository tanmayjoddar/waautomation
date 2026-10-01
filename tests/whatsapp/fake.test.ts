/**
 * Fake WhatsApp client tests. Proves the fake that later slices' worker
 * tests will use: it records calls, hands out wamids that are unique even
 * across restarts, fails on demand, and recovers. No network, no database.
 */
import { describe, expect, it } from 'vitest';
import { WhatsAppApiError } from '../../src/whatsapp/client.js';
import { createFakeWhatsAppClient } from '../../src/whatsapp/fake.js';

describe('createFakeWhatsAppClient', () => {
  it('records sends and reads with unique wamids', async () => {
    const fake = createFakeWhatsAppClient();

    const first = await fake.sendText('919812345678', 'hello');
    const second = await fake.sendText('919812345679', 'hi');
    await fake.markReadAndType('wamid.IN.1');

    expect(first.wamid).toMatch(/^wamid\.FAKE\./);
    expect(second.wamid).not.toBe(first.wamid);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[0]).toMatchObject({ to: '919812345678', body: 'hello', wamid: first.wamid });
    expect(fake.reads).toEqual(['wamid.IN.1']);
  });

  it('wamids are unique across client instances (simulated server restart)', async () => {
    // The bug this guards: the counter restarted at wamid.FAKE.1 on every
    // server start while out rows persisted, so the second run's first send
    // died on the unique (client_id, wamid) constraint.
    const before = createFakeWhatsAppClient();
    const afterRestart = createFakeWhatsAppClient();

    const first = await before.sendText('919812345678', 'one');
    const second = await afterRestart.sendText('919812345678', 'two');

    expect(first.wamid).toMatch(/^wamid\.FAKE\./);
    expect(second.wamid).toMatch(/^wamid\.FAKE\./);
    expect(second.wamid).not.toBe(first.wamid);
  });

  it('failNextSendWith fails exactly one send, then recovers', async () => {
    const fake = createFakeWhatsAppClient();
    const boom = new WhatsAppApiError('sendText', 500, null, 2, 'boom');

    fake.failNextSendWith(boom);
    await expect(fake.sendText('919812345678', 'one')).rejects.toBe(boom);
    expect(fake.sent).toHaveLength(0);

    const ok = await fake.sendText('919812345678', 'two');
    expect(ok.wamid).toMatch(/^wamid\.FAKE\./);
    expect(fake.sent).toHaveLength(1);
  });

  it('failAllSendsWith fails every send until cleared', async () => {
    const fake = createFakeWhatsAppClient();
    fake.failAllSendsWith(new Error('Meta is down'));

    await expect(fake.sendText('919812345678', 'one')).rejects.toThrow('Meta is down');
    await expect(fake.sendText('919812345678', 'two')).rejects.toThrow('Meta is down');
    expect(fake.sent).toHaveLength(0);

    fake.failAllSendsWith(null);
    await fake.sendText('919812345678', 'three');
    expect(fake.sent).toHaveLength(1);
  });

  it('reset forgets calls and failures', async () => {
    const fake = createFakeWhatsAppClient();
    await fake.sendText('919812345678', 'one');
    await fake.markReadAndType('wamid.IN.1');
    fake.failAllSendsWith(new Error('stuck'));

    fake.reset();

    expect(fake.sent).toHaveLength(0);
    expect(fake.reads).toHaveLength(0);
    await fake.sendText('919812345678', 'two');
    expect(fake.sent).toHaveLength(1);
  });
});
