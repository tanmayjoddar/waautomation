import { describe, expect, it } from 'vitest';
import { createLogger, maskPhone } from '../src/logger.js';
import { collectingStream } from './helpers.js';

describe('maskPhone', () => {
  it('keeps the country prefix and the last two digits only', () => {
    expect(maskPhone('919812345678')).toBe('91' + '*'.repeat(8) + '78');
  });

  it('handles a leading + and very short values', () => {
    expect(maskPhone('+91981')).toBe('91*81');
    expect(maskPhone('98')).toBe('**');
  });
});

describe('createLogger redaction', () => {
  const logOnce = (fn: (logger: ReturnType<typeof createLogger>) => void): string => {
    const { stream, text } = collectingStream();
    fn(createLogger({ level: 'trace', destination: stream }));
    return text();
  };

  it('redacts tokens and API keys at any depth', () => {
    const out = logOnce((logger) => {
      logger.info({ token: 'EAAG-secret', nested: { apiKey: 'sk-secret' } }, 'whatsapp send');
    });
    expect(out).not.toContain('EAAG-secret');
    expect(out).not.toContain('sk-secret');
    expect(out).toContain('[redacted]');
  });

  it('redacts the service role key and a whole config object', () => {
    const out = logOnce((logger) => {
      logger.info({ config: { supabase: { serviceRoleKey: 'super-secret' } } }, 'boot');
    });
    expect(out).not.toContain('super-secret');
  });

  it('masks phone numbers in phone-named fields', () => {
    const out = logOnce((logger) => {
      logger.info({ phone: '919812345678' }, 'contact upsert');
    });
    expect(out).not.toContain('919812345678');
    expect(out).toContain('91' + '*'.repeat(8) + '78');
  });

  it('masks a phone number nested inside an inbound payload', () => {
    const out = logOnce((logger) => {
      logger.info({ message: { from: '919812345678', id: 'wamid.X' } }, 'inbound');
    });
    expect(out).not.toContain('919812345678');
    expect(out).toContain('wamid.X');
  });

  it('redacts phone-named fields even when the value is not a number', () => {
    const out = logOnce((logger) => {
      logger.info({ to: 'unknown' }, 'send');
    });
    expect(out).toContain('"to":"[redacted]"');
  });

  it('leaves harmless fields alone', () => {
    const out = logOnce((logger) => {
      logger.info({ port: 3000, env: 'test', wamid: 'wamid.OK' }, 'listening');
    });
    expect(out).toContain('"port":3000');
    expect(out).toContain('wamid.OK');
  });

  it('honours the configured level', () => {
    const { stream, text } = collectingStream();
    const logger = createLogger({ level: 'warn', destination: stream });
    logger.debug({ token: 'nope' }, 'should not appear');
    logger.warn('should appear');
    expect(text()).not.toContain('should not appear');
    expect(text()).toContain('should appear');
  });
});
