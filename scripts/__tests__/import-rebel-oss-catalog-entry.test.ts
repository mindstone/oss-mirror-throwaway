/**
 * Tests for the 260417 prevention guard in scripts/import-rebel-oss-catalog-entry.ts.
 *
 * Covers:
 * - 7 unit tests on the pure validator in scripts/lib/validateCatalogImport.ts
 * - 1 CLI-integration test proving the guard is wired into the main() path AND
 *   fires BEFORE writeFileSync (catalog on disk is NOT modified when the guard throws).
 *
 * @see docs/plans/260422_bundledconfig_prevention_followups.md
 * @see docs-private/postmortems/260417_rebel_oss_bundledconfig_regression_postmortem.md
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, afterEach } from 'vitest';

import { buildCatalogEntry, upsertEntry } from '../import-rebel-oss-catalog-entry.js';
import {
  KNOWN_BUNDLED_LIKE_AUTH_TYPES,
  validateBundledConfigInvariant,
  validateEnvPlaceholderResolvability,
  validateLocalFileSandboxRequirements,
  type CatalogConnectorForValidation,
} from '../lib/validateCatalogImport.js';

const VALID_SOURCE = {
  manifestPath: '/tmp/fake/catalog-entry.json',
  packageSpec: '@mindstone-engineering/mcp-server-fake@0.1.0',
} as const;

function makeEntry(
  overrides: Partial<CatalogConnectorForValidation> = {},
): CatalogConnectorForValidation {
  return {
    id: 'bundled-fake',
    provider: 'rebel-oss',
    requiresSetup: true,
    setupFields: [{ id: 'apiKey', label: 'API Key', type: 'password' }],
    bundledConfig: {
      authType: 'api-key',
      serverName: 'Fake',
    },
    ...overrides,
  };
}

// ─── Unit tests — validateBundledConfigInvariant ──────────────────────────────

describe('validateBundledConfigInvariant (pure helper)', () => {
  it('throws when rebel-oss + requiresSetup + setupFields has no bundledConfig (primary 260417 regression)', () => {
    const entry = makeEntry({ bundledConfig: undefined });
    expect(() => validateBundledConfigInvariant(entry, VALID_SOURCE)).toThrow(
      /Missing or invalid: bundledConfig$/m,
    );
  });

  it('throws when bundledConfig is present but authType is missing', () => {
    const entry = makeEntry({
      bundledConfig: { serverName: 'Fake' }, // no authType
    });
    expect(() => validateBundledConfigInvariant(entry, VALID_SOURCE)).toThrow(
      /bundledConfig\.authType/,
    );
  });

  it('throws when bundledConfig is present but serverName is missing', () => {
    const entry = makeEntry({
      bundledConfig: { authType: 'api-key' }, // no serverName
    });
    expect(() => validateBundledConfigInvariant(entry, VALID_SOURCE)).toThrow(
      /bundledConfig\.serverName/,
    );
  });

  it('throws when bundledConfig.authType is an unsupported string value (typo guard)', () => {
    const entry = makeEntry({
      bundledConfig: { authType: 'bogus-type', serverName: 'Fake' },
    });
    expect(() => validateBundledConfigInvariant(entry, VALID_SOURCE)).toThrow(
      /unsupported value "bogus-type"/,
    );
  });

  it('throws when bundledConfig.authType is a truthy non-string value (type confusion guard)', () => {
    // Catches accidental JSON shapes like { authType: 123 } or { authType: { wrapper: 'x' } }
    // that bypassed the previous `typeof === 'string'` gate.
    const numericAuthType = makeEntry({
      bundledConfig: { authType: 42 as unknown as string, serverName: 'Fake' },
    });
    expect(() => validateBundledConfigInvariant(numericAuthType, VALID_SOURCE)).toThrow(
      /unsupported value 42/,
    );

    const objectAuthType = makeEntry({
      bundledConfig: { authType: { wrapper: 'api-key' } as unknown as string, serverName: 'Fake' },
    });
    expect(() => validateBundledConfigInvariant(objectAuthType, VALID_SOURCE)).toThrow(
      /unsupported value \{/,
    );
  });

  it('passes when all known authType values are used with complete bundledConfig', () => {
    for (const authType of KNOWN_BUNDLED_LIKE_AUTH_TYPES) {
      const entry = makeEntry({
        bundledConfig: { authType, serverName: 'Fake' },
      });
      expect(() => validateBundledConfigInvariant(entry, VALID_SOURCE)).not.toThrow();
    }
  });

  it('passes when rebel-oss connector does not require setup (invariant does not apply)', () => {
    const entry = makeEntry({
      requiresSetup: false,
      bundledConfig: undefined, // allowed since no setup needed
    });
    expect(() => validateBundledConfigInvariant(entry, VALID_SOURCE)).not.toThrow();
  });

  it('passes when provider is not rebel-oss (bundled/direct/community have their own invariants)', () => {
    for (const provider of ['bundled', 'direct', 'community']) {
      const entry = makeEntry({
        provider,
        bundledConfig: undefined,
      });
      expect(() => validateBundledConfigInvariant(entry, VALID_SOURCE)).not.toThrow();
    }
  });

  it('error message includes the connector id, manifest path, package spec, and source-of-truth pointer', () => {
    const entry = makeEntry({ bundledConfig: undefined });
    try {
      validateBundledConfigInvariant(entry, VALID_SOURCE);
      throw new Error('expected throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('bundled-fake'); // connector id
      expect(message).toContain('/tmp/fake/catalog-entry.json'); // manifest path
      expect(message).toContain('@mindstone-engineering/mcp-server-fake@0.1.0'); // package spec
      expect(message).toContain('src/shared/__tests__/connectorCatalog.test.ts'); // catalog-test pointer
      expect(message).toContain('260417'); // postmortem pointer
      // R-2: error message must direct maintainer to LOCAL catalog, not upstream manifest
      expect(message).toContain('local'); // "extend the bundledConfig block in the LOCAL resources/..."
      expect(message).not.toMatch(/add.*bundledConfig.*upstream/i);
    }
  });
});

describe('validateEnvPlaceholderResolvability', () => {
  it('passes a Runway-shaped entry with only system tokens', () => {
    expect(() =>
      validateEnvPlaceholderResolvability({
        id: 'bundled-runway',
        mcpConfig: {
          env: {
            MINDSTONE_REBEL_BRIDGE_STATE: '{{BRIDGE_STATE_PATH}}',
            X: '{{MCP_CONFIG_DIR}}',
          },
        },
      }),
    ).not.toThrow();
  });

  it('passes a Gamma-shaped entry with mixed system and setup-field tokens', () => {
    expect(() =>
      validateEnvPlaceholderResolvability({
        id: 'bundled-gamma',
        setupFields: [{ id: 'GAMMA_API_KEY' }],
        mcpConfig: {
          env: {
            GAMMA_API_KEY: '{{GAMMA_API_KEY}}',
            X: '{{MCP_CONFIG_DIR}}',
          },
        },
      }),
    ).not.toThrow();
  });

  it('throws when a token is not system / setup-field / provider-key', () => {
    expect(() =>
      validateEnvPlaceholderResolvability({
        id: 'bundled-mystery',
        mcpConfig: { env: { Y: '{{MYSTERY_TOKEN}}' } },
      }),
    ).toThrow(/bundled-mystery.*MYSTERY_TOKEN/);
  });

  it('tolerates entries without any env block', () => {
    expect(() =>
      validateEnvPlaceholderResolvability({
        id: 'bundled-empty',
        mcpConfig: {},
      }),
    ).not.toThrow();
  });
});

describe('validateLocalFileSandboxRequirements', () => {
  it('passes a Runway-shaped entry declaring both sandbox keys with exact placeholders', () => {
    expect(() =>
      validateLocalFileSandboxRequirements({
        id: 'bundled-runway',
        requiresLocalFileSandbox: true,
        mcpConfig: {
          env: {
            MCP_HOST_BRIDGE_STATE: '{{BRIDGE_STATE_PATH}}',
            RUNWAY_ALLOWED_ROOT: '{{ALLOWED_ROOTS_ANCESTOR}}',
            RUNWAY_DOWNLOAD_ROOT: '{{ALLOWED_ROOTS_ANCESTOR_DOWNLOADS}}',
          },
        },
      }),
    ).not.toThrow();
  });

  it('is a no-op when the flag is absent or false', () => {
    expect(() =>
      validateLocalFileSandboxRequirements({ id: 'bundled-x', mcpConfig: { env: {} } }),
    ).not.toThrow();
    expect(() =>
      validateLocalFileSandboxRequirements({
        id: 'bundled-y',
        requiresLocalFileSandbox: false,
        mcpConfig: { env: {} },
      }),
    ).not.toThrow();
  });

  it('throws when a flagged connector is missing a required sandbox key', () => {
    expect(() =>
      validateLocalFileSandboxRequirements({
        id: 'bundled-runway',
        requiresLocalFileSandbox: true,
        mcpConfig: {
          env: { RUNWAY_ALLOWED_ROOT: '{{ALLOWED_ROOTS_ANCESTOR}}' },
        },
      }),
    ).toThrow(/RUNWAY_DOWNLOAD_ROOT: missing/);
  });

  it('throws when a paired key drifts to the wrong placeholder', () => {
    expect(() =>
      validateLocalFileSandboxRequirements({
        id: 'bundled-runway',
        requiresLocalFileSandbox: true,
        mcpConfig: {
          env: {
            RUNWAY_ALLOWED_ROOT: '{{ALLOWED_ROOTS_ANCESTOR}}',
            // wrong placeholder: same as the primary instead of the downloads ancestor
            RUNWAY_DOWNLOAD_ROOT: '{{ALLOWED_ROOTS_ANCESTOR}}',
          },
        },
      }),
    ).toThrow(/RUNWAY_DOWNLOAD_ROOT: got .* \(expected/);
  });

  it('throws when a flagged connector has no env block at all', () => {
    expect(() =>
      validateLocalFileSandboxRequirements({
        id: 'bundled-runway',
        requiresLocalFileSandbox: true,
        mcpConfig: {},
      }),
    ).toThrow(/requiresLocalFileSandbox: true/);
  });
});

// ─── Unit tests — buildCatalogEntry + upsertEntry preserve-all-unspecified ────
// FOX-3319: the auto-sync workflow rebuilds catalog entries from upstream
// manifests, but manifests do not carry every catalog field (setupUrl,
// callbackUrl, platforms, accountIdentity, contributors, bundledConfig, ...).
// `buildCatalogEntry` must therefore leave manifest-absent fields unset, and
// `upsertEntry` must preserve every existing-entry field the new entry does
// not specify. The previous implementation unconditionally injected
// `accountIdentity: manifest.accountIdentity` (=> undefined when absent) and
// then dropped the existing value during replacement — the silent-drop bug.

interface ManifestForTest {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  maturity: string;
  verifiedSource: string;
  requiresSetup: boolean;
  setupFields?: Array<{ key: string; label: string; type: string; placeholder?: string }>;
  accountIdentity?: string;
  contributors?: Array<{ name: string; github: string }>;
}

describe('buildCatalogEntry — manifest-conditional fields', () => {
  const baseManifest: ManifestForTest = {
    id: 'bundled-fathom',
    name: 'Fathom',
    description: 'Fathom meeting transcripts',
    category: 'productivity',
    icon: 'video',
    maturity: 'stable',
    verifiedSource: 'https://github.com/mindstone/mcp-servers',
    requiresSetup: true,
  };

  it('omits accountIdentity when manifest does not carry it (preventing undefined-injection)', () => {
    const entry = buildCatalogEntry(baseManifest, '@mindstone/mcp-server-fathom', '0.2.3');
    expect('accountIdentity' in entry).toBe(false);
  });

  it('includes accountIdentity when manifest carries it', () => {
    const entry = buildCatalogEntry(
      { ...baseManifest, accountIdentity: 'email' },
      '@mindstone/mcp-server-fathom',
      '0.2.3',
    );
    expect(entry.accountIdentity).toBe('email');
  });

  it('omits setupFields when manifest does not carry them', () => {
    const entry = buildCatalogEntry(baseManifest, '@mindstone/mcp-server-fathom', '0.2.3');
    expect('setupFields' in entry).toBe(false);
  });

  it('omits contributors when manifest has an empty array', () => {
    const entry = buildCatalogEntry(
      { ...baseManifest, contributors: [] },
      '@mindstone/mcp-server-fathom',
      '0.2.3',
    );
    expect('contributors' in entry).toBe(false);
  });

  it('builds mcpConfig.args with scope-versioned spec', () => {
    const entry = buildCatalogEntry(baseManifest, '@mindstone/mcp-server-fathom', '0.2.3');
    expect(entry.mcpConfig.args).toEqual(['-y', '@mindstone/mcp-server-fathom@0.2.3']);
  });
});

describe('upsertEntry — preserve-all-unspecified shallow merge', () => {
  it('preserves load-bearing fields the manifest pipeline does not carry', () => {
    const existing = {
      id: 'bundled-fathom',
      name: 'Fathom',
      description: 'Fathom meeting transcripts',
      category: 'productivity',
      provider: 'rebel-oss',
      icon: 'video',
      setupFields: [
        { id: 'apiKey', label: 'API Key', type: 'password', envVar: 'FATHOM_API_KEY' },
      ],
      setupUrl: 'https://fathom.video/oauth/authorize',
      setupInstructions: 'Visit fathom.video to generate an API key',
      setupUrlBehavior: 'newTab',
      setupUrlButtonLabel: 'Connect Fathom',
      callbackUrl: 'rebel://oauth/fathom/callback',
      platforms: ['darwin', 'win32'],
      accountIdentity: 'email',
      contributors: [{ name: 'Alice', github: 'alice' }],
      bundledConfig: { authType: 'api-key', serverName: 'fathom' },
      tools: [{ name: 'list_meetings' }],
      popular: true,
      hidden: false,
      featured: true,
      verified: true,
      verifiedSource: 'https://github.com/mindstone/mcp-servers',
      requiresSetup: true,
      maturity: 'stable',
      mcpConfig: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@mindstone-engineering/mcp-server-fathom@0.2.2'],
        env: { FATHOM_API_KEY: '{{apiKey}}' },
      },
    };

    const manifest: ManifestForTest = {
      id: 'bundled-fathom',
      name: 'Fathom',
      description: 'Fathom meeting transcripts',
      category: 'productivity',
      icon: 'video',
      maturity: 'stable',
      verifiedSource: 'https://github.com/mindstone/mcp-servers',
      requiresSetup: true,
    };

    const newEntry = buildCatalogEntry(
      manifest,
      '@mindstone/mcp-server-fathom',
      '0.2.3',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const catalog = { version: 1, connectors: [existing as any] };
    const changed = upsertEntry(catalog, newEntry);

    expect(changed).toBe(true);
    const result = catalog.connectors[0];

    expect(result.setupFields[0].envVar).toBe('FATHOM_API_KEY');
    expect(result.setupUrl).toBe('https://fathom.video/oauth/authorize');
    expect(result.setupInstructions).toBe('Visit fathom.video to generate an API key');
    expect(result.setupUrlBehavior).toBe('newTab');
    expect(result.setupUrlButtonLabel).toBe('Connect Fathom');
    expect(result.callbackUrl).toBe('rebel://oauth/fathom/callback');
    expect(result.platforms).toEqual(['darwin', 'win32']);
    expect(result.accountIdentity).toBe('email');
    expect(result.contributors).toEqual([{ name: 'Alice', github: 'alice' }]);
    expect(result.bundledConfig).toEqual({ authType: 'api-key', serverName: 'fathom' });
    expect(result.tools).toEqual([{ name: 'list_meetings' }]);
    expect(result.popular).toBe(true);
    expect(result.hidden).toBe(false);
    expect(result.featured).toBe(true);
    expect(result.mcpConfig.env).toEqual({ FATHOM_API_KEY: '{{apiKey}}' });

    // Fields the new entry DOES specify must be replaced, not preserved.
    expect(result.mcpConfig.args).toEqual(['-y', '@mindstone/mcp-server-fathom@0.2.3']);
    expect(result.verifiedSource).toBe('https://github.com/mindstone/mcp-servers');
    expect(result.verified).toBe(true);
  });

  it('inserts a new entry when no matching id exists', () => {
    const catalog = { version: 1, connectors: [] };
    const entry = buildCatalogEntry(
      {
        id: 'bundled-newcomer',
        name: 'Newcomer',
        description: 'New connector',
        category: 'productivity',
        icon: 'sparkles',
        maturity: 'beta',
        verifiedSource: 'https://example.com',
        requiresSetup: false,
      },
      '@mindstone/mcp-server-newcomer',
      '0.1.0',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any;
    const changed = upsertEntry(catalog, entry);
    expect(changed).toBe(true);
    expect(catalog.connectors).toHaveLength(1);
    expect(catalog.connectors[0]).toBe(entry);
  });

  it('preserves existing mcpConfig.env when the new entry has no env', () => {
    const existing = {
      id: 'bundled-x',
      provider: 'rebel-oss',
      mcpConfig: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@mindstone-engineering/mcp-server-x@0.1.0'],
        env: { X_TOKEN: '{{token}}' },
      },
    };
    const newEntry = {
      id: 'bundled-x',
      provider: 'rebel-oss',
      mcpConfig: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@mindstone/mcp-server-x@0.1.1'],
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const catalog = { version: 1, connectors: [existing as any] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsertEntry(catalog, newEntry as any);
    expect(catalog.connectors[0].mcpConfig.env).toEqual({ X_TOKEN: '{{token}}' });
  });
});

// ─── CLI integration — guard fires before writeFileSync ───────────────────────

describe('CLI integration — guard wiring in import-rebel-oss-catalog-entry.ts main()', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('exits non-zero and does NOT modify the catalog when the invariant fails', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rebel-oss-catalog-guard-test-'));
    const manifestPath = join(tmpDir, 'catalog-entry.json');

    // Build a minimal manifest that the import script will accept but will
    // produce a new entry missing bundledConfig. (Upstream manifests never
    // carry bundledConfig; it's preserved from existing catalog or not at all.)
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          id: 'bundled-guard-test',
          name: 'Guard Test Fixture',
          description: 'Ephemeral fixture for the 260417 import guard CLI test',
          category: 'Test',
          icon: 'test',
          maturity: 'beta',
          verifiedSource: 'test',
          requiresSetup: true,
          setupFields: [{ key: 'apiKey', label: 'API Key', type: 'password' }],
        },
        null,
        2,
      ),
    );

    // Snapshot the real catalog BEFORE the run so we can assert it's unchanged.
    const projectRoot = join(__dirname, '..', '..');
    const catalogPath = join(projectRoot, 'resources', 'connector-catalog.json');
    const catalogBefore = readFileSync(catalogPath, 'utf8');

    const result = spawnSync(
      'npx',
      [
        'tsx',
        'scripts/import-rebel-oss-catalog-entry.ts',
        '--connector',
        'guard-test',
        '--package',
        '@mindstone-engineering/mcp-server-guard-test',
        '--version',
        '0.0.1',
        '--entry-path',
        manifestPath,
      ],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        // Belt-and-suspenders: force-kill the tsx process if it hangs,
        // independent of vitest's test wrapper timeout.
        timeout: 25_000,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invariant violation');
    expect(result.stderr).toContain('bundled-guard-test');
    expect(result.stderr).toContain('bundledConfig');

    // Critical: the catalog on disk must NOT have been modified.
    // Guard fires BEFORE writeFileSync.
    const catalogAfter = readFileSync(catalogPath, 'utf8');
    expect(catalogAfter).toBe(catalogBefore);
  }, 30_000);
});
