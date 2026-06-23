/**
 * Stage B1 — the analytics privacy contract is enforced by the redaction layer:
 * forbidden property keys are dropped, ids are hashed, and emails never survive
 * as track() properties.
 */

import {
  redactAnalyticsProperties,
  isForbiddenAnalyticsKey,
  hashId,
} from '../redaction';

describe('isForbiddenAnalyticsKey', () => {
  it.each([
    'url',
    'email',
    'cloudUrl',
    'cloud_url',
    'messageBody',
    'content',
    'transcript',
    'filePath',
    'file_path',
    'prompt',
    'body',
  ])('forbids %s', (key) => {
    expect(isForbiddenAnalyticsKey(key)).toBe(true);
  });

  it.each(['client_surface', 'surface', 'screen', 'durationMs', 'count', 'thread'])(
    'permits %s',
    (key) => {
      expect(isForbiddenAnalyticsKey(key)).toBe(false);
    },
  );
});

describe('redactAnalyticsProperties', () => {
  it('drops forbidden keys outright', () => {
    const out = redactAnalyticsProperties({
      client_surface: 'mobile',
      url: 'https://secret.example/thing',
      email: 'worker@example.com',
      messageContent: 'top secret message body',
      filePath: '/Users/worker/notes.txt',
      screen: 'home',
    });
    expect(out).not.toHaveProperty('url');
    expect(out).not.toHaveProperty('email');
    expect(out).not.toHaveProperty('messageContent');
    expect(out).not.toHaveProperty('filePath');
    expect(out).toMatchObject({ client_surface: 'mobile', screen: 'home' });
  });

  it('drops forbidden keys recursively at any depth (F1)', () => {
    const out = redactAnalyticsProperties({
      client_surface: 'mobile',
      metadata: {
        message: 'raw content body',
        prompt: 'a secret prompt',
        screen: 'home',
      },
      context: {
        body: 'raw request body',
        nested: {
          transcript: 'raw transcript content',
          keep: 'ok',
          deeper: { prompt: 'deep prompt', count: 3 },
        },
      },
      items: [
        { content: 'drop me', label: 'keep me' },
        { url: 'https://secret.example', ok: true },
      ],
    });

    // Top-level survivors retained.
    expect(out.client_surface).toBe('mobile');

    // Nested forbidden keys removed, nested safe keys retained.
    const metadata = out.metadata as Record<string, unknown>;
    expect(metadata).not.toHaveProperty('message');
    expect(metadata).not.toHaveProperty('prompt');
    expect(metadata.screen).toBe('home');

    const context = out.context as Record<string, unknown>;
    expect(context).not.toHaveProperty('body');
    const nested = context.nested as Record<string, unknown>;
    expect(nested).not.toHaveProperty('transcript');
    expect(nested.keep).toBe('ok');
    const deeper = nested.deeper as Record<string, unknown>;
    expect(deeper).not.toHaveProperty('prompt');
    expect(deeper.count).toBe(3);

    // Forbidden keys inside array elements are also dropped.
    const items = out.items as Array<Record<string, unknown>>;
    expect(items[0]).not.toHaveProperty('content');
    expect(items[0].label).toBe('keep me');
    expect(items[1]).not.toHaveProperty('url');
    expect(items[1].ok).toBe(true);

    // Belt-and-braces: no forbidden content string survives anywhere.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('raw content body');
    expect(serialized).not.toContain('a secret prompt');
    expect(serialized).not.toContain('raw request body');
    expect(serialized).not.toContain('raw transcript content');
    expect(serialized).not.toContain('deep prompt');
    expect(serialized).not.toContain('secret.example');
  });

  it('hashes cloudUrl and sessionId into stable non-reversible tokens', () => {
    const out = redactAnalyticsProperties({
      cloudUrl: 'https://abc.fly.dev',
      sessionId: 'mobile-1700000000-abc',
    });
    expect(out).not.toHaveProperty('cloudUrl');
    expect(out).not.toHaveProperty('sessionId');
    expect(out.cloudUrlHash).toBe(hashId('https://abc.fly.dev'));
    expect(out.sessionIdHash).toBe(hashId('mobile-1700000000-abc'));
    expect(String(out.cloudUrlHash)).not.toContain('fly.dev');
  });

  it('runs the shared deep scrub over surviving nested string values', () => {
    const out = redactAnalyticsProperties({
      note: 'reach me at worker@example.com',
    });
    // EMAIL_ADDRESS_REGEX redaction comes from the shared redactObjectDeep.
    expect(String(out.note)).not.toContain('worker@example.com');
  });

  it('never mutates the input object', () => {
    const input = { client_surface: 'mobile', url: 'https://x' };
    const snapshot = { ...input };
    redactAnalyticsProperties(input);
    expect(input).toEqual(snapshot);
  });

  it('produces a stable hash for the same input', () => {
    expect(hashId('same')).toBe(hashId('same'));
    expect(hashId('a')).not.toBe(hashId('b'));
  });
});
