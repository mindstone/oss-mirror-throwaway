import { describe, expect, it, vi, afterEach } from 'vitest';
import { isCloudVersionCurrent, extractLatestProdTag, extractCommitFromTag, repairMachineEnvToken, fetchLatestTag, getCloudUpdateChannel, setFlyApiTokenSecret, setSentryDsnSecret, repairFlyApiTokenSecretEager } from '../cloudUpdateService';

describe('isCloudVersionCurrent', () => {
  it('returns true when running version exactly matches the prod tag commit', () => {
    expect(isCloudVersionCurrent('abc1234', 'prod-abc1234')).toBe(true);
  });

  it('returns true when running version is reported as the full prod tag', () => {
    expect(isCloudVersionCurrent('prod-abc1234', 'prod-abc1234')).toBe(true);
  });

  it('returns true when running version is a longer hash that starts with the target commit', () => {
    expect(isCloudVersionCurrent('abc1234def5678', 'prod-abc1234')).toBe(true);
  });

  it('is case-insensitive for running and target versions', () => {
    expect(isCloudVersionCurrent('ABC1234', 'prod-abc1234')).toBe(true);
    expect(isCloudVersionCurrent('prod-ABC1234', 'prod-abc1234')).toBe(true);
  });

  it('returns false when versions do not match', () => {
    expect(isCloudVersionCurrent('def5678', 'prod-abc1234')).toBe(false);
  });

  it('returns false when running version is empty or unknown', () => {
    expect(isCloudVersionCurrent(undefined, 'prod-abc1234')).toBe(false);
    expect(isCloudVersionCurrent('', 'prod-abc1234')).toBe(false);
    expect(isCloudVersionCurrent('unknown', 'prod-abc1234')).toBe(false);
  });

  it('returns false when the latest tag is not a prod-* tag', () => {
    expect(isCloudVersionCurrent('abc1234', 'latest')).toBe(false);
  });

  it('returns true when running version matches a dev-* tag commit', () => {
    expect(isCloudVersionCurrent('abc1234', 'dev-abc1234')).toBe(true);
  });

  it('returns true when running version is the full dev tag', () => {
    expect(isCloudVersionCurrent('dev-abc1234', 'dev-abc1234')).toBe(true);
  });

  it('returns true for dev-* tag with longer running hash', () => {
    expect(isCloudVersionCurrent('abc1234def5678', 'dev-abc1234')).toBe(true);
  });

  it('returns false for dev-* tag when versions do not match', () => {
    expect(isCloudVersionCurrent('def5678', 'dev-abc1234')).toBe(false);
  });
});

describe('extractCommitFromTag', () => {
  it('extracts commit from prod-* tag', () => {
    expect(extractCommitFromTag('prod-abc1234')).toBe('abc1234');
  });

  it('extracts commit from dev-* tag', () => {
    expect(extractCommitFromTag('dev-abc1234')).toBe('abc1234');
  });

  it('is case-insensitive', () => {
    expect(extractCommitFromTag('PROD-ABC1234')).toBe('abc1234');
    expect(extractCommitFromTag('DEV-ABC1234')).toBe('abc1234');
  });

  it('returns null for non-channel tags', () => {
    expect(extractCommitFromTag('latest')).toBeNull();
    expect(extractCommitFromTag('abc1234')).toBeNull();
    expect(extractCommitFromTag('')).toBeNull();
  });

  it('returns the suffix for *-latest tags', () => {
    expect(extractCommitFromTag('prod-latest')).toBe('latest');
    expect(extractCommitFromTag('dev-latest')).toBe('latest');
  });
});

describe('extractLatestProdTag', () => {
  it('extracts the SHA-based prod tag from the entry containing prod-latest', () => {
    const versions = [
      { metadata: { container: { tags: ['prod-abc1234', 'prod-latest'] } } },
      { metadata: { container: { tags: ['prod-older'] } } },
    ];
    expect(extractLatestProdTag(versions)).toBe('prod-abc1234');
  });

  it('returns null for an empty array', () => {
    expect(extractLatestProdTag([])).toBeNull();
  });

  it('returns null when no entry has prod-latest tag', () => {
    const versions = [
      { metadata: { container: { tags: ['prod-abc1234'] } } },
      { metadata: { container: { tags: ['dev-def5678', 'dev-latest'] } } },
    ];
    expect(extractLatestProdTag(versions)).toBeNull();
  });

  it('returns null when entry has prod-latest but no SHA tag', () => {
    const versions = [
      { metadata: { container: { tags: ['prod-latest'] } } },
    ];
    expect(extractLatestProdTag(versions)).toBeNull();
  });

  it('handles entries with missing metadata gracefully', () => {
    const versions = [
      {},
      { metadata: {} },
      { metadata: { container: {} } },
      { metadata: { container: { tags: ['prod-abc1234', 'prod-latest'] } } },
    ];
    expect(extractLatestProdTag(versions)).toBe('prod-abc1234');
  });

  it('picks the first entry with prod-latest when multiple exist', () => {
    const versions = [
      { metadata: { container: { tags: ['prod-first', 'prod-latest'] } } },
      { metadata: { container: { tags: ['prod-second', 'prod-latest'] } } },
    ];
    expect(extractLatestProdTag(versions)).toBe('prod-first');
  });

  it('ignores dev tags in the same entry', () => {
    const versions = [
      { metadata: { container: { tags: ['dev-abc1234', 'prod-def5678', 'prod-latest', 'latest'] } } },
    ];
    expect(extractLatestProdTag(versions)).toBe('prod-def5678');
  });
});

// ---------------------------------------------------------------------------
// repairMachineEnvToken
// ---------------------------------------------------------------------------

describe('repairMachineEnvToken', () => {
  const originalFetch = globalThis.fetch;
  const TOKEN = 'fly-pat-test';
  const APP = 'rebel-cloud-test';
  const MACHINE = 'machine-123';
  const LOCAL_TOKEN = 'local-bridge-token';
  const CLOUD_URL = 'https://rebel-cloud-test.fly.dev';

  function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    vi.stubGlobal('fetch', vi.fn(handler));
  }

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('returns alreadyCorrect when config.env token matches local token', async () => {
    mockFetch((url) => {
      if (url.includes(`/machines/${MACHINE}`) && !url.includes('/wait')) {
        return new Response(JSON.stringify({
          config: { env: { REBEL_CLOUD_TOKEN: LOCAL_TOKEN } },
          version: 1,
        }));
      }
      return new Response('{}');
    });

    const result = await repairMachineEnvToken({
      flyApiToken: TOKEN, flyAppName: APP, flyMachineId: MACHINE,
      localToken: LOCAL_TOKEN, cloudUrl: CLOUD_URL,
    });
    expect(result.success).toBe(true);
    expect(result.alreadyCorrect).toBe(true);
  });

  it('returns conflict when remote token differs and force is not set', async () => {
    mockFetch((url) => {
      if (url.includes(`/machines/${MACHINE}`) && !url.includes('/wait')) {
        return new Response(JSON.stringify({
          config: { env: { REBEL_CLOUD_TOKEN: 'other-device-token' } },
          version: 1,
        }));
      }
      return new Response('{}');
    });

    const result = await repairMachineEnvToken({
      flyApiToken: TOKEN, flyAppName: APP, flyMachineId: MACHINE,
      localToken: LOCAL_TOKEN, cloudUrl: CLOUD_URL,
    });
    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
  });

  it('writes token when absent from config.env', async () => {
    let postPayload: Record<string, unknown> | null = null;
    mockFetch((url, init) => {
      if (url.includes(`/machines/${MACHINE}`) && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({
          config: { env: { PORT: '8080' } },
          version: 5,
        }));
      }
      if (url.includes(`/machines/${MACHINE}`) && init?.method === 'POST') {
        postPayload = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ id: MACHINE }));
      }
      // Auth poll - return ok immediately
      if (url.includes('/api/settings')) {
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response('{}');
    });

    const result = await repairMachineEnvToken({
      flyApiToken: TOKEN, flyAppName: APP, flyMachineId: MACHINE,
      localToken: LOCAL_TOKEN, cloudUrl: CLOUD_URL,
    });
    expect(result.success).toBe(true);
    expect(result.restarted).toBe(true);
    // Verify the POST included the token in env
    const config = (postPayload as any)?.config as Record<string, unknown>;
    const env = config?.env as Record<string, string>;
    expect(env?.REBEL_CLOUD_TOKEN).toBe(LOCAL_TOKEN);
    expect(env?.PORT).toBe('8080'); // preserved existing env
  });

  it('overwrites conflicting token when force is true', async () => {
    mockFetch((url, init) => {
      if (url.includes(`/machines/${MACHINE}`) && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({
          config: { env: { REBEL_CLOUD_TOKEN: 'other-token' } },
          version: 3,
        }));
      }
      if (url.includes(`/machines/${MACHINE}`) && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: MACHINE }));
      }
      if (url.includes('/api/settings')) {
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response('{}');
    });

    const result = await repairMachineEnvToken({
      flyApiToken: TOKEN, flyAppName: APP, flyMachineId: MACHINE,
      localToken: LOCAL_TOKEN, cloudUrl: CLOUD_URL, force: true,
    });
    expect(result.success).toBe(true);
    expect(result.restarted).toBe(true);
  });

  it('returns error when machine fetch fails', async () => {
    mockFetch(() => new Response('not found', { status: 404 }));

    const result = await repairMachineEnvToken({
      flyApiToken: TOKEN, flyAppName: APP, flyMachineId: MACHINE,
      localToken: LOCAL_TOKEN, cloudUrl: CLOUD_URL,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('404');
  });
});

// ---------------------------------------------------------------------------
// fetchLatestTag — OCI manifest resolution
// ---------------------------------------------------------------------------

describe('fetchLatestTag', () => {
  const originalFetch = globalThis.fetch;
  const FULL_SHA = 'abc1234def5678901234567890abcdef12345678';

  function makeOciManifest(configDigest: string) {
    return { config: { digest: configDigest, mediaType: 'application/vnd.oci.image.config.v1+json' } };
  }

  // docker/metadata-action sets `org.opencontainers.image.version` to the exact
  // primary tag (e.g. "dev-e79a95f2") and `org.opencontainers.image.revision` to
  // the full 40-char git SHA. The version label is the authoritative source for
  // the abbreviated tag; revision is only present as a (length-ambiguous) fallback.
  function makeImageConfig(labels: { version?: string; revision?: string }) {
    const Labels: Record<string, string> = {};
    if (labels.version) Labels['org.opencontainers.image.version'] = labels.version;
    if (labels.revision) Labels['org.opencontainers.image.revision'] = labels.revision;
    return { config: { Labels } };
  }

  function makeManifestList(digests: string[]) {
    return { manifests: digests.map(d => ({ digest: d, mediaType: 'application/vnd.oci.image.manifest.v1+json' })) };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('resolves the stable tag from the version label and re-applies the prod prefix', async () => {
    // On `main`, the version label is the branch tag (`main-<sha>`), but the
    // stable channel expects a `prod-<sha>` tag — which CI also pushes from the
    // same SHA. The resolver must re-prefix, not echo the branch tag.
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ token: 'anon-token' }));
      }
      if (url.includes('/manifests/prod-latest')) {
        return new Response(JSON.stringify(makeOciManifest('sha256:config-digest')));
      }
      if (url.includes('/blobs/sha256:config-digest')) {
        return new Response(JSON.stringify(makeImageConfig({ version: 'main-abc1234', revision: FULL_SHA })));
      }
      return new Response('not found', { status: 404 });
    }));

    const result = await fetchLatestTag('stable');
    expect(result.tag).toBe('prod-abc1234');
    expect(result.error).toBeUndefined();
  });

  it('handles manifest list by following the first platform', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ token: 'anon-token' }));
      }
      if (url.includes('/manifests/dev-latest')) {
        return new Response(JSON.stringify(makeManifestList(['sha256:platform-digest'])));
      }
      if (url.includes('/manifests/sha256:platform-digest')) {
        return new Response(JSON.stringify(makeOciManifest('sha256:config-digest')));
      }
      if (url.includes('/blobs/sha256:config-digest')) {
        return new Response(JSON.stringify(makeImageConfig({ version: 'dev-abc1234', revision: FULL_SHA })));
      }
      return new Response('not found', { status: 404 });
    }));

    const result = await fetchLatestTag('beta');
    expect(result.tag).toBe('dev-abc1234');
  });

  it('uses the exact abbreviation from the version label (8-char SHA) and does NOT truncate to 7', async () => {
    // Regression for docs-private/investigations/260531_cloud_self_update_sha_length_mismatch.md:
    // CI tagged the image `dev-e79a95f2` (8-char `git rev-parse --short`), but the
    // resolver reconstructed `dev-e79a95f` (7-char slice of the revision), which 404s.
    const eightCharSha = 'e79a95f2';
    const fullRevision = 'e79a95f22eddeccb4d31c2058fd1795aeebb26ce';
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ token: 'anon-token' }));
      }
      if (url.includes('/manifests/dev-latest')) {
        return new Response(JSON.stringify(makeOciManifest('sha256:config-digest')));
      }
      if (url.includes('/blobs/sha256:config-digest')) {
        return new Response(JSON.stringify(makeImageConfig({ version: `dev-${eightCharSha}`, revision: fullRevision })));
      }
      return new Response('not found', { status: 404 });
    }));

    const result = await fetchLatestTag('beta');
    expect(result.tag).toBe('dev-e79a95f2');
    expect(result.tag).not.toBe('dev-e79a95f');
  });

  it('falls back to the tag list when only a revision label is present (length is ambiguous)', async () => {
    // Without the version label we cannot know the abbreviation length CI used,
    // so we must not reconstruct from a fixed slice — defer to the tag list which
    // only returns tags that actually exist.
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ token: 'anon-token' }));
      }
      if (url.includes('/manifests/dev-latest')) {
        return new Response(JSON.stringify(makeOciManifest('sha256:config-digest')));
      }
      if (url.includes('/blobs/sha256:config-digest')) {
        return new Response(JSON.stringify(makeImageConfig({ revision: FULL_SHA })));
      }
      if (url.includes('/tags/list')) {
        return new Response(JSON.stringify({ tags: ['dev-aaa1111', 'dev-bbb2222', 'dev-latest'] }));
      }
      return new Response('not found', { status: 404 });
    }));

    const result = await fetchLatestTag('beta');
    expect(result.tag).toBe('dev-bbb2222');
  });

  it('returns rateLimited when GHCR returns 429', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ token: 'anon-token' }));
      }
      return new Response('rate limited', { status: 429 });
    }));

    const result = await fetchLatestTag('stable');
    expect(result.rateLimited).toBe(true);
  });

  it('falls back to tag list when manifest has no revision label', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ token: 'anon-token' }));
      }
      if (url.includes('/manifests/prod-latest')) {
        return new Response(JSON.stringify(makeOciManifest('sha256:config-digest')));
      }
      if (url.includes('/blobs/sha256:config-digest')) {
        // Config with no revision label
        return new Response(JSON.stringify({ config: { Labels: {} } }));
      }
      if (url.includes('/tags/list')) {
        return new Response(JSON.stringify({ tags: ['prod-aaa1111', 'prod-bbb2222', 'prod-latest'] }));
      }
      return new Response('not found', { status: 404 });
    }));

    const result = await fetchLatestTag('stable');
    // Falls back to alphabetical sort (the known-imperfect fallback)
    expect(result.tag).toBe('prod-bbb2222');
  });

  it('returns error when token fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Response('fail', { status: 500 })));

    const result = await fetchLatestTag('stable');
    expect(result.error).toBeDefined();
    expect(result.error).toContain('500');
  });

  it('surfaces rate-limit when GHCR token endpoint returns 429', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/token')) {
        return new Response('rate limited', { status: 429 });
      }
      return new Response('{}');
    }));

    const result = await fetchLatestTag('stable');
    expect(result.error).toMatch(/rate-limited/i);
  });

  it('surfaces rate-limit when GHCR token endpoint returns 403', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/token')) {
        return new Response('forbidden', { status: 403 });
      }
      return new Response('{}');
    }));

    const result = await fetchLatestTag('stable');
    expect(result.error).toMatch(/rate-limited/i);
  });

  it('surfaces timeout when token fetch is aborted', async () => {
    vi.stubGlobal('fetch', vi.fn(() => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      return Promise.reject(err);
    }));

    const result = await fetchLatestTag('stable');
    expect(result.error).toMatch(/timed out/i);
  });

  it('surfaces missing-token-field when GHCR returns empty body', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/token')) {
        return new Response(JSON.stringify({}));
      }
      return new Response('{}');
    }));

    const result = await fetchLatestTag('stable');
    expect(result.error).toMatch(/missing the token field/i);
  });
});

describe('getCloudUpdateChannel', () => {
  it('maps stable build to stable cloud channel', () => {
    expect(getCloudUpdateChannel('stable')).toBe('stable');
  });

  it('maps beta build to beta cloud channel', () => {
    expect(getCloudUpdateChannel('beta')).toBe('beta');
  });

  it('maps dev build to beta cloud channel', () => {
    expect(getCloudUpdateChannel('dev')).toBe('beta');
  });
});

// ---------------------------------------------------------------------------
// setFlyApiTokenSecret + repairFlyApiTokenSecretEager — bootstrap path
// for the cloud-side self-update scheduler on legacy instances.
// ---------------------------------------------------------------------------

describe('setFlyApiTokenSecret', () => {
  const originalFetch = globalThis.fetch;
  const TOKEN = 'fly-pat-test';
  const APP = 'rebel-cloud-test';

  function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    vi.stubGlobal('fetch', vi.fn(handler));
  }

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('writes FLY_API_TOKEN as a Fly secret via the GraphQL setSecrets mutation', async () => {
    let graphqlPayload: Record<string, unknown> | null = null;
    mockFetch((url, init) => {
      if (url.includes('api.fly.io/graphql')) {
        graphqlPayload = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ data: { setSecrets: { app: { name: APP } } } }));
      }
      return new Response('{}', { status: 404 });
    });

    const result = await setFlyApiTokenSecret({ flyApiToken: TOKEN, flyAppName: APP });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    const variables = (graphqlPayload as any)?.variables as { input: { appId: string; secrets: Array<{ key: string; value: string }> } };
    expect(variables.input.appId).toBe(APP);
    expect(variables.input.secrets).toEqual([{ key: 'FLY_API_TOKEN', value: TOKEN }]);
  });

  it('returns failure when the GraphQL mutation responds with errors', async () => {
    mockFetch(() => new Response(JSON.stringify({
      errors: [{ message: 'permission denied: token cannot set secrets' }],
    })));

    const result = await setFlyApiTokenSecret({ flyApiToken: TOKEN, flyAppName: APP });
    expect(result.success).toBe(false);
    expect(result.error).toContain('permission denied');
  });

  it('returns failure when the GraphQL request itself fails', async () => {
    mockFetch(() => new Response('Internal Server Error', { status: 500 }));

    const result = await setFlyApiTokenSecret({ flyApiToken: TOKEN, flyAppName: APP });
    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
  });
});

describe('setSentryDsnSecret', () => {
  const originalFetch = globalThis.fetch;
  const TOKEN = 'fly-pat-test';
  const APP = 'rebel-cloud-test';
  const DSN = 'https://public@example.invalid/1';

  function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    vi.stubGlobal('fetch', vi.fn(handler));
  }

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('writes SENTRY_DSN as a Fly secret via the GraphQL setSecrets mutation', async () => {
    let graphqlPayload: Record<string, unknown> | null = null;
    mockFetch((url, init) => {
      if (url.includes('api.fly.io/graphql')) {
        graphqlPayload = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ data: { setSecrets: { app: { name: APP } } } }));
      }
      return new Response('{}', { status: 404 });
    });

    const result = await setSentryDsnSecret({ flyApiToken: TOKEN, flyAppName: APP, sentryDsn: DSN });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    const variables = (graphqlPayload as any)?.variables as { input: { appId: string; secrets: Array<{ key: string; value: string }> } };
    expect(variables.input.appId).toBe(APP);
    expect(variables.input.secrets).toEqual([{ key: 'SENTRY_DSN', value: DSN }]);
  });

  it('returns failure when the GraphQL mutation responds with errors', async () => {
    mockFetch(() => new Response(JSON.stringify({
      errors: [{ message: 'permission denied: token cannot set secrets' }],
    })));

    const result = await setSentryDsnSecret({ flyApiToken: TOKEN, flyAppName: APP, sentryDsn: DSN });
    expect(result.success).toBe(false);
    expect(result.error).toContain('permission denied');
  });

  it('returns failure when the GraphQL request itself fails', async () => {
    mockFetch(() => new Response('Internal Server Error', { status: 500 }));

    const result = await setSentryDsnSecret({ flyApiToken: TOKEN, flyAppName: APP, sentryDsn: DSN });
    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
  });
});

describe('repairFlyApiTokenSecretEager', () => {
  const originalFetch = globalThis.fetch;
  const TOKEN = 'fly-pat-test';
  const APP = 'rebel-cloud-test';
  const MACHINE = 'machine-123';

  function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    vi.stubGlobal('fetch', vi.fn(handler));
  }

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('writes the secret then restarts the machine', async () => {
    const calls: { url: string; method?: string }[] = [];
    mockFetch((url, init) => {
      calls.push({ url, method: init?.method });
      if (url.includes('api.fly.io/graphql')) {
        return new Response(JSON.stringify({ data: { setSecrets: { app: { name: APP } } } }));
      }
      if (url.includes(`/machines/${MACHINE}/restart`)) {
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response('{}', { status: 404 });
    });

    const result = await repairFlyApiTokenSecretEager({
      flyApiToken: TOKEN, flyAppName: APP, flyMachineId: MACHINE,
    });

    expect(result.success).toBe(true);
    expect(result.restarted).toBe(true);
    // GraphQL call must precede the restart call
    const graphqlIdx = calls.findIndex((c) => c.url.includes('api.fly.io/graphql'));
    const restartIdx = calls.findIndex((c) => c.url.includes('/restart'));
    expect(graphqlIdx).toBeGreaterThanOrEqual(0);
    expect(restartIdx).toBeGreaterThan(graphqlIdx);
  });

  it('returns failure without restarting when setSecrets fails', async () => {
    let restartCalled = false;
    mockFetch((url) => {
      if (url.includes('api.fly.io/graphql')) {
        return new Response(JSON.stringify({ errors: [{ message: 'unauthorized' }] }));
      }
      if (url.includes('/restart')) {
        restartCalled = true;
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response('{}', { status: 404 });
    });

    const result = await repairFlyApiTokenSecretEager({
      flyApiToken: TOKEN, flyAppName: APP, flyMachineId: MACHINE,
    });

    expect(result.success).toBe(false);
    expect(result.restarted).toBeUndefined();
    expect(restartCalled).toBe(false);
  });

  it('returns failure when restart fails after secret was set', async () => {
    mockFetch((url) => {
      if (url.includes('api.fly.io/graphql')) {
        return new Response(JSON.stringify({ data: { setSecrets: { app: { name: APP } } } }));
      }
      if (url.includes('/restart')) {
        return new Response('machine not found', { status: 404 });
      }
      return new Response('{}', { status: 404 });
    });

    const result = await repairFlyApiTokenSecretEager({
      flyApiToken: TOKEN, flyAppName: APP, flyMachineId: MACHINE,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('404');
  });

  it('treats HTTP 409 from restart as success (machine already restarting)', async () => {
    mockFetch((url) => {
      if (url.includes('api.fly.io/graphql')) {
        return new Response(JSON.stringify({ data: { setSecrets: { app: { name: APP } } } }));
      }
      if (url.includes('/restart')) {
        return new Response('already restarting', { status: 409 });
      }
      return new Response('{}', { status: 404 });
    });

    const result = await repairFlyApiTokenSecretEager({
      flyApiToken: TOKEN, flyAppName: APP, flyMachineId: MACHINE,
    });

    expect(result.success).toBe(true);
    expect(result.restarted).toBe(true);
  });
});
