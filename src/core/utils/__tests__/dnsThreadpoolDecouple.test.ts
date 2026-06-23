import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CacheableLookup from 'cacheable-lookup';

const { infoLog, warnLog, errorLog, debugLog, setGlobalDispatcherSpy, agentArgs, agentControl } = vi.hoisted(() => ({
  infoLog: vi.fn(),
  warnLog: vi.fn(),
  errorLog: vi.fn(),
  debugLog: vi.fn(),
  setGlobalDispatcherSpy: vi.fn(),
  agentArgs: [] as unknown[],
  agentControl: { shouldThrow: false },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: infoLog,
    warn: warnLog,
    error: errorLog,
    debug: debugLog,
  }),
}));

// Mock undici so installGlobalUndiciDnsDecouple's Agent / setGlobalDispatcher
// wiring can be asserted without opening real sockets. The fake Agent must be
// declared INSIDE the hoisted factory (top-level vars aren't available to it).
vi.mock('undici', () => {
  class FakeAgent {
    options: unknown;
    constructor(options: unknown) {
      if (agentControl.shouldThrow) throw new Error('boom: agent construction failed');
      this.options = options;
      agentArgs.push(options);
    }
  }
  return {
    Agent: FakeAgent,
    setGlobalDispatcher: (d: unknown) => setGlobalDispatcherSpy(d),
  };
});

/** Returns the most-recently-constructed fake Agent instance. */
function lastFakeAgent(): { options: { connect?: { lookup?: unknown; autoSelectFamily?: unknown } } } {
  return setGlobalDispatcherSpy.mock.calls[setGlobalDispatcherSpy.mock.calls.length - 1][0] as {
    options: { connect?: { lookup?: unknown; autoSelectFamily?: unknown } };
  };
}

import {
  createLookupWithFallback,
  getSharedCacheableLookup,
  getDecoupledLookup,
} from '../dnsThreadpoolDecouple';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  agentArgs.length = 0;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  agentControl.shouldThrow = false;
});

describe('dnsThreadpoolDecouple — singleton + wiring', () => {
  it('getSharedCacheableLookup returns ONE shared CacheableLookup instance', () => {
    const a = getSharedCacheableLookup();
    const b = getSharedCacheableLookup();
    expect(a).toBeInstanceOf(CacheableLookup);
    expect(a).toBe(b);
  });

  it('getDecoupledLookup returns a stable, memoized wrapper fn (one ref for global + MCP agent)', () => {
    const lookup = getDecoupledLookup();
    expect(typeof lookup).toBe('function');
    // Memoized wrapper (createLookupWithFallback), NOT the raw cacheable .lookup —
    // the global dispatcher and the MCP Agent must share the same reference.
    expect(getDecoupledLookup()).toBe(lookup);
  });

  it('installGlobalUndiciDnsDecouple installs an Agent whose connect.lookup is the decoupled lookup when c-ares is opted in', async () => {
    vi.resetModules();
    process.env.REBEL_HTTP_RESOLVER = 'cares';
    const mod = await import('../dnsThreadpoolDecouple');

    mod.installGlobalUndiciDnsDecouple();

    expect(setGlobalDispatcherSpy).toHaveBeenCalledTimes(1);
    const dispatcher = lastFakeAgent();
    expect(dispatcher.options.connect?.lookup).toBe(mod.getDecoupledLookup());
    // autoSelectFamily enables undici happy-eyeballs (c-ares has no cross-family fallback).
    expect(dispatcher.options.connect?.autoSelectFamily).toBe(true);
    expect(mod.isCaresDnsEnabled()).toBe(true);
    expect(infoLog).toHaveBeenCalledWith(expect.stringContaining('using c-ares/cacheable-lookup'));
  });

  it('installGlobalUndiciDnsDecouple is idempotent (second call is a no-op)', async () => {
    vi.resetModules();
    process.env.REBEL_DNS_DECOUPLE = '1';
    const mod = await import('../dnsThreadpoolDecouple');

    mod.installGlobalUndiciDnsDecouple();
    mod.installGlobalUndiciDnsDecouple();
    mod.installGlobalUndiciDnsDecouple();

    expect(setGlobalDispatcherSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * Faithful proof of the dependency contract we rely on: cacheable-lookup
 * resolves via c-ares (resolve4/6) and FALLS BACK to dns.lookup for names c-ares
 * can't answer (ENOTFOUND/ENODATA). We construct CacheableLookup directly with an
 * injected fake resolver + fake lookup so we can drive each branch deterministically
 * — this is the behaviour our default-options instance (fallbackDuration left at
 * its 3600s default) depends on.
 */
describe('dnsThreadpoolDecouple — c-ares resolve + dns.lookup fallback contract', () => {
  type ResolveCb = (err: NodeJS.ErrnoException | null, addrs?: Array<{ address: string; ttl: number }>) => void;

  function makeFakeResolver(opts: {
    resolve4?: (host: string, options: unknown, cb: ResolveCb) => void;
    resolve6?: (host: string, options: unknown, cb: ResolveCb) => void;
  }) {
    return {
      resolve4: opts.resolve4 ?? ((_h: string, _o: unknown, cb: ResolveCb) => cb(null, [])),
      resolve6: opts.resolve6 ?? ((_h: string, _o: unknown, cb: ResolveCb) => cb(null, [])),
      setServers: () => {},
      getServers: () => ['127.0.0.1'],
    };
  }

  it('(i) resolves via c-ares resolve4 (off the libuv threadpool)', async () => {
    const resolve4 = vi.fn((_host: string, _options: unknown, cb: ResolveCb) =>
      cb(null, [{ address: '93.184.216.34', ttl: 300 }]),
    );
    const fallbackLookup = vi.fn();
    const cl = new CacheableLookup({
      resolver: makeFakeResolver({ resolve4 }) as never,
      lookup: fallbackLookup as never,
    });

    const entry = await cl.lookupAsync('example.com');

    expect(resolve4).toHaveBeenCalledWith('example.com', expect.anything(), expect.any(Function));
    expect(entry.address).toBe('93.184.216.34');
    expect(entry.family).toBe(4);
    // c-ares answered → fallback dns.lookup NOT used
    expect(fallbackLookup).not.toHaveBeenCalled();
  });

  it('(ii) falls back to dns.lookup when c-ares rejects ENOTFOUND (e.g. /etc/hosts, .local)', async () => {
    const enotfound = (_host: string, _options: unknown, cb: ResolveCb) => {
      const err = new Error('ENOTFOUND') as NodeJS.ErrnoException;
      err.code = 'ENOTFOUND';
      cb(err);
    };
    const resolve4 = vi.fn(enotfound);
    const resolve6 = vi.fn(enotfound);
    // Fallback is callback-form dns.lookup with { all: true }.
    const fallbackLookup = vi.fn(
      (_host: string, _options: unknown, cb: (e: Error | null, addrs: Array<{ address: string; family: number }>) => void) =>
        cb(null, [{ address: '127.0.0.1', family: 4 }]),
    );

    const cl = new CacheableLookup({
      resolver: makeFakeResolver({ resolve4, resolve6 }) as never,
      lookup: fallbackLookup as never,
    });

    const entry = await cl.lookupAsync('my-host.local');

    expect(resolve4).toHaveBeenCalled();
    expect(fallbackLookup).toHaveBeenCalled();
    expect(entry.address).toBe('127.0.0.1');
  });
});

/**
 * createLookupWithFallback adds the "never worse than today" guarantee on top of
 * cacheable-lookup: ANY c-ares error (SERVFAIL / timeout / malformed — which
 * cacheable-lookup does NOT auto-fall-back on) routes to dns.lookup. Driven with
 * fakes so each branch is deterministic.
 */
describe('createLookupWithFallback — c-ares with hard dns.lookup fallback', () => {
  type Cb = (err: NodeJS.ErrnoException | null, ...rest: unknown[]) => void;

  it('passes through a successful c-ares single-address result without falling back', () => {
    const cacheable = { lookup: (_h: string, _o: unknown, cb: Cb) => cb(null, '1.2.3.4', 4) };
    const sys = vi.fn();
    const cb = vi.fn();
    createLookupWithFallback(cacheable as never, sys as never)('example.com', {} as never, cb as never);
    expect(cb).toHaveBeenCalledWith(null, '1.2.3.4', 4);
    expect(sys).not.toHaveBeenCalled();
  });

  it('passes through the { all: true } array form (happy-eyeballs needs both families)', () => {
    const addrs = [
      { address: '1.2.3.4', family: 4 },
      { address: '::1', family: 6 },
    ];
    const cacheable = { lookup: (_h: string, _o: unknown, cb: Cb) => cb(null, addrs) };
    const sys = vi.fn();
    const cb = vi.fn();
    createLookupWithFallback(cacheable as never, sys as never)('example.com', { all: true } as never, cb as never);
    expect(cb).toHaveBeenCalledWith(null, addrs);
    expect(sys).not.toHaveBeenCalled();
  });

  it('falls back to dns.lookup on a non-empty c-ares error (SERVFAIL / timeout)', () => {
    const servfail = Object.assign(new Error('queryA ESERVFAIL'), { code: 'ESERVFAIL' });
    const cacheable = { lookup: (_h: string, _o: unknown, cb: Cb) => cb(servfail) };
    const sys = vi.fn((_h: string, _o: unknown, cb: Cb) => cb(null, '9.9.9.9', 4));
    const cb = vi.fn();
    createLookupWithFallback(cacheable as never, sys as never)('flaky.example.com', {} as never, cb as never);
    expect(sys).toHaveBeenCalledWith('flaky.example.com', expect.anything(), expect.any(Function));
    expect(cb).toHaveBeenCalledWith(null, '9.9.9.9', 4);
  });
});

/**
 * Safety rails for a GLOBAL HTTP-stack change: OS resolver by default, c-ares
 * opt-in, legacy kill-switch compatibility, and fail-open (a broken resolver
 * must never take down ALL outbound HTTP). Each test re-imports the module fresh
 * so the module-load-time env read + install guard are exercised cleanly.
 */
describe('dnsThreadpoolDecouple — resolver selector + fail-open', () => {
  async function loadFreshWithEnv(env: Record<string, string | undefined>) {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.REBEL_HTTP_RESOLVER;
    delete process.env.REBEL_DNS_DECOUPLE;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    setGlobalDispatcherSpy.mockClear();
    infoLog.mockClear();
    warnLog.mockClear();
    errorLog.mockClear();
    agentArgs.length = 0;
    return import('../dnsThreadpoolDecouple');
  }

  it('default env uses the OS resolver and does not install c-ares', async () => {
    const mod = await loadFreshWithEnv({});

    expect(mod.isCaresDnsEnabled()).toBe(false);
    mod.installGlobalUndiciDnsDecouple();

    expect(setGlobalDispatcherSpy).not.toHaveBeenCalled();
    expect(infoLog).toHaveBeenCalledWith(expect.stringContaining('OS resolver (getaddrinfo/dns.lookup)'));
  });

  it('REBEL_HTTP_RESOLVER=cares opts into c-ares', async () => {
    const mod = await loadFreshWithEnv({ REBEL_HTTP_RESOLVER: 'cares' });

    expect(mod.isCaresDnsEnabled()).toBe(true);
    mod.installGlobalUndiciDnsDecouple();

    expect(setGlobalDispatcherSpy).toHaveBeenCalledTimes(1);
  });

  it('REBEL_DNS_DECOUPLE=1 opts into c-ares', async () => {
    const mod = await loadFreshWithEnv({ REBEL_DNS_DECOUPLE: '1' });

    expect(mod.isCaresDnsEnabled()).toBe(true);
    mod.installGlobalUndiciDnsDecouple();

    expect(setGlobalDispatcherSpy).toHaveBeenCalledTimes(1);
  });

  it('REBEL_HTTP_RESOLVER=system forces the OS resolver (legacy kill-switch)', async () => {
    const mod = await loadFreshWithEnv({ REBEL_HTTP_RESOLVER: 'system' });

    expect(mod.isCaresDnsEnabled()).toBe(false);
    mod.installGlobalUndiciDnsDecouple();

    expect(setGlobalDispatcherSpy).not.toHaveBeenCalled();
    expect(infoLog).toHaveBeenCalledWith(expect.stringContaining('OS resolver'));
  });

  it('REBEL_DNS_DECOUPLE=0 forces the OS resolver (legacy kill-switch)', async () => {
    const mod = await loadFreshWithEnv({ REBEL_DNS_DECOUPLE: '0' });

    expect(mod.isCaresDnsEnabled()).toBe(false);
    mod.installGlobalUndiciDnsDecouple();

    expect(setGlobalDispatcherSpy).not.toHaveBeenCalled();
    expect(infoLog).toHaveBeenCalledWith(expect.stringContaining('OS resolver'));
  });

  it('kill-switch wins over c-ares opt-in when env vars conflict', async () => {
    const mod = await loadFreshWithEnv({
      REBEL_HTTP_RESOLVER: 'cares',
      REBEL_DNS_DECOUPLE: '0',
    });

    expect(mod.isCaresDnsEnabled()).toBe(false);
    mod.installGlobalUndiciDnsDecouple();

    expect(setGlobalDispatcherSpy).not.toHaveBeenCalled();
    expect(infoLog).toHaveBeenCalledWith(expect.stringContaining('OS resolver'));
  });

  it('REBEL_HTTP_RESOLVER=system wins over REBEL_DNS_DECOUPLE=1', async () => {
    const mod = await loadFreshWithEnv({
      REBEL_HTTP_RESOLVER: 'system',
      REBEL_DNS_DECOUPLE: '1',
    });

    expect(mod.isCaresDnsEnabled()).toBe(false);
    mod.installGlobalUndiciDnsDecouple();

    expect(setGlobalDispatcherSpy).not.toHaveBeenCalled();
  });

  it('fail-open: if Agent construction throws, it does NOT throw and logs the error', async () => {
    agentControl.shouldThrow = true;
    const mod = await loadFreshWithEnv({ REBEL_HTTP_RESOLVER: 'cares' });

    expect(() => mod.installGlobalUndiciDnsDecouple()).not.toThrow();
    expect(errorLog).toHaveBeenCalledTimes(1);
  });
});
