/**
 * Unit tests for scripts/dev-mcp-managed-install.ts.
 *
 * Covers the pure helpers: catalog lookup, shorthand resolution, source-path
 * resolution, override JSON shape, and the userData-path computation that
 * mirrors src/main/startup/ensureAppIdentity.ts.
 *
 * The install/uninstall subcommands are NOT exercised end-to-end here — that
 * would require spawning npm and producing a real tarball, which belongs in
 * a manual smoke checklist (see docs/project/MCP_DEV_LOCAL_OVERRIDE.md).
 * The service-level seam is fully covered by
 * src/main/services/__tests__/managedMcpInstallService.test.ts.
 */

import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CatalogSchema } from '../../src/shared/connectorCatalogSchema';
import { _internalsForTests } from '../dev-mcp-managed-install';

const {
  buildSanitizedFullOverride,
  findConnectorByShorthand,
  passesValidatorWhitelist,
  readPackagedConnectors,
  resolveConnectorSourcePath,
  resolveOverrideOutputPath,
  resolveUserDataPath,
  sanitizeForCatalogSchema,
} = _internalsForTests;

describe('dev-mcp-managed-install', () => {
  describe('readPackagedConnectors', () => {
    it('returns the rebel-oss @mindstone* entries pinned via npx -y <pkg@version>', async () => {
      const connectors = await readPackagedConnectors();
      // We expect at least a handful — Vanta, Replit SSH, Microsoft cohort, etc.
      // The catalog is the source of truth; assertion is "non-empty + valid shape".
      expect(connectors.length).toBeGreaterThan(0);
      for (const c of connectors) {
        expect(c.packageSpec).toMatch(
          /^@(mindstone|mindstone-engineering)\/mcp-server-[a-z0-9-]+@\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/,
        );
        expect(c.catalogId).toBeTruthy();
      }
    });

    it('includes bundled-vanta (regression guard for known rebel-oss entry)', async () => {
      const connectors = await readPackagedConnectors();
      const vanta = connectors.find((c) => c.catalogId === 'bundled-vanta');
      expect(vanta, 'bundled-vanta should be in the catalog').toBeDefined();
      expect(vanta?.packageSpec).toMatch(/^@mindstone\/mcp-server-vanta@/);
    });
  });

  describe('findConnectorByShorthand', () => {
    const fixture = [
      { catalogId: 'bundled-hubspot', packageSpec: '@mindstone/mcp-server-hubspot@0.1.2' },
      { catalogId: 'bundled-vanta', packageSpec: '@mindstone/mcp-server-vanta@0.1.0' },
      { catalogId: 'bundled-microsoft-mail', packageSpec: '@mindstone/mcp-server-microsoft-mail@0.1.0' },
      { catalogId: 'bundled-microsoft-calendar', packageSpec: '@mindstone/mcp-server-microsoft-calendar@0.1.0' },
    ];

    it('matches by exact catalogId', () => {
      const hit = findConnectorByShorthand(fixture, 'bundled-hubspot');
      expect(hit?.packageSpec).toBe('@mindstone/mcp-server-hubspot@0.1.2');
    });

    it('matches by short package suffix (folder-name convention from publish-mcp-to-registry.sh)', () => {
      const hit = findConnectorByShorthand(fixture, 'hubspot');
      expect(hit?.catalogId).toBe('bundled-hubspot');
    });

    it('matches with the bundled- prefix added implicitly', () => {
      const hit = findConnectorByShorthand(fixture, 'vanta');
      expect(hit?.catalogId).toBe('bundled-vanta');
    });

    it('returns null for an unknown shorthand', () => {
      expect(findConnectorByShorthand(fixture, 'made-up-connector')).toBeNull();
    });

    it('throws on ambiguous shorthand (two connectors that share a tail)', () => {
      const ambiguous = [
        { catalogId: 'bundled-foo', packageSpec: '@mindstone/mcp-server-foo@0.1.0' },
        { catalogId: 'alt-foo', packageSpec: '@mindstone-engineering/mcp-server-foo@0.2.0' },
      ];
      expect(() => findConnectorByShorthand(ambiguous, 'foo')).toThrow(/Ambiguous/);
    });
  });

  describe('resolveConnectorSourcePath', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    let originalEnv: string | undefined;

    beforeEach(() => {
      originalEnv = process.env.MCP_SERVERS_REPO;
    });
    afterEach(() => {
      if (originalEnv === undefined) delete process.env.MCP_SERVERS_REPO;
      else process.env.MCP_SERVERS_REPO = originalEnv;
    });

    it('returns the override path absolute-resolved when --source is given', () => {
      const resolved = resolveConnectorSourcePath('hubspot', '/tmp/my-custom-source');
      expect(resolved).toBe(path.resolve('/tmp/my-custom-source'));
    });

    it('defaults to <repo>/mcp-servers (submodule) when present, else <repo>/../mcp-servers (sibling), when no env or flag is given', () => {
      // Track A of the OSS release automation plan adds mcp-servers as a
      // submodule. After predev runs, <repo>/mcp-servers exists and the
      // resolver should prefer it. When the submodule isn't checked out
      // (e.g. on a fresh clone where predev hasn't run yet), the resolver
      // falls back to the legacy sibling layout.
      delete process.env.MCP_SERVERS_REPO;
      const resolved = resolveConnectorSourcePath('hubspot');
      const submodulePath = path.resolve(repoRoot, 'mcp-servers', 'connectors', 'hubspot');
      const siblingPath = path.resolve(repoRoot, '..', 'mcp-servers', 'connectors', 'hubspot');
      // One of these must hold depending on whether the submodule is checked out.
      expect([submodulePath, siblingPath]).toContain(resolved);
    });

    it('uses MCP_SERVERS_REPO env var when set (matches publish-mcp-to-registry.sh convention)', () => {
      process.env.MCP_SERVERS_REPO = '/Users/dev/work/mcp-servers';
      const resolved = resolveConnectorSourcePath('vanta');
      expect(resolved).toBe('/Users/dev/work/mcp-servers/connectors/vanta');
    });
  });

  describe('resolveUserDataPath', () => {
    it('produces a path ending in /mindstone-rebel (matching ensureAppIdentity.ts)', () => {
      // The exact platform-specific prefix depends on the test runner's
      // platform, but the suffix is invariant across all three OSes.
      const resolved = resolveUserDataPath();
      expect(resolved.endsWith(path.join('mindstone-rebel'))).toBe(true);
      // And the parent dir must exist as a real OS appData folder (no leading ..).
      expect(path.isAbsolute(resolved)).toBe(true);
    });

    it('on darwin, lands under ~/Library/Application Support', () => {
      if (process.platform !== 'darwin') return;
      const resolved = resolveUserDataPath();
      expect(resolved).toBe(path.join(os.homedir(), 'Library', 'Application Support', 'mindstone-rebel'));
    });
  });

  describe('passesValidatorWhitelist', () => {
    it('keeps connectors with no mcpConfig.command (OAuth/HTTP direct)', () => {
      expect(passesValidatorWhitelist({}).ok).toBe(true);
      expect(passesValidatorWhitelist({ mcpConfig: {} }).ok).toBe(true);
    });

    it('keeps npx + ["-y", <whitelisted-pkg>@x.y.z]', () => {
      const r = passesValidatorWhitelist({
        mcpConfig: { command: 'npx', args: ['-y', '@mindstone/mcp-server-hubspot@0.2.0'] },
      });
      expect(r.ok).toBe(true);
    });

    it('drops npx with unwhitelisted package (e.g. fathom)', () => {
      const r = passesValidatorWhitelist({
        mcpConfig: { command: 'npx', args: ['-y', '@mindstone/mcp-server-fathom@0.2.3'] },
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/whitelist/);
    });

    it('drops npx with bad args shape', () => {
      const r = passesValidatorWhitelist({
        mcpConfig: { command: 'npx', args: ['-y', '@mindstone/mcp-server-hubspot@0.2.0', 'extra'] },
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/wrong shape/);
    });

    it('drops `node` command (wrapper cannot synthesize absolute managed-mcps path)', () => {
      const r = passesValidatorWhitelist({ mcpConfig: { command: 'node', args: ['/x/y'] } });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/not allowed/);
    });

    it('drops unknown commands like uvx', () => {
      const r = passesValidatorWhitelist({ mcpConfig: { command: 'uvx', args: [] } });
      expect(r.ok).toBe(false);
    });
  });

  describe('sanitizeForCatalogSchema', () => {
    it('passes through tool annotations (now accepted by CatalogSchema as of 260525_test-failures-sweep extended Stage 1)', () => {
      const input = {
        version: 1,
        connectors: [
          {
            id: 'x',
            name: 'X',
            description: 'd',
            category: 'c',
            icon: 'i',
            provider: 'rebel-oss',
            tools: [{ name: 't', annotations: { readOnly: true } }],
          },
        ],
      };
      const report = { droppedConnectors: [], strippedFields: [] };
      const out = sanitizeForCatalogSchema(input, report);
      const parsed = CatalogSchema.safeParse(out);
      expect(parsed.success).toBe(true);
      // After Stage 1 widening, `annotations` is a legitimate field; the sanitizer no longer strips it.
      expect(report.strippedFields.some((s) => s.path.endsWith('annotations'))).toBe(false);
      // And the field survives the round-trip through the sanitizer.
      const outConn = (out as { connectors: Array<{ tools?: Array<{ annotations?: unknown }> }> }).connectors[0];
      expect(outConn.tools?.[0]?.annotations).toEqual({ readOnly: true });
    });

    it("coerces unknown maturity values (e.g. 'experimental') to 'beta' (defensive against future schema-vs-catalog drift)", () => {
      // Note: 'preview' was the original example here, but as of the merge that
      // brought in `bundled-opus-video-clip` 'preview' is a first-class enum
      // member — sanitization is not needed for it. The coercion code path is
      // still exercised against any FUTURE unknown maturity value (e.g.
      // 'experimental'), so this test preserves coverage of that defensive
      // sanitization without depending on a value that may stop being unknown.
      const input = {
        version: 1,
        connectors: [
          {
            id: 'x',
            name: 'X',
            description: 'd',
            category: 'c',
            icon: 'i',
            provider: 'rebel-oss',
            maturity: 'experimental',
          },
        ],
      };
      const report = { droppedConnectors: [], strippedFields: [] };
      const out = sanitizeForCatalogSchema(input, report) as { connectors: Array<{ maturity?: string }> };
      expect(out.connectors[0].maturity).toBe('beta');
      expect(CatalogSchema.safeParse(out).success).toBe(true);
    });

    it('throws when sanitization cannot converge (defensive against future schema changes)', () => {
      // Missing required `name` is an issue the sanitizer doesn't know how to
      // fix — it should fail loudly rather than silently mutate the catalog
      // into an unexpected shape.
      const input = {
        version: 1,
        connectors: [{ id: 'x', description: 'd', category: 'c', icon: 'i', provider: 'rebel-oss' }],
      };
      const report = { droppedConnectors: [], strippedFields: [] };
      expect(() => sanitizeForCatalogSchema(input, report)).toThrow(/could not converge/);
    });
  });

  describe('buildSanitizedFullOverride (integration with real bundled catalog)', () => {
    it('produces a CatalogSchema-valid override with the target connector args swapped', async () => {
      const { catalog, report } = await buildSanitizedFullOverride(
        'bundled-hubspot',
        '@mindstone/mcp-server-hubspot@0.2.0',
      );
      const parsed = CatalogSchema.safeParse(catalog);
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);

      const conns = (catalog as { connectors: Array<{ id: string; mcpConfig?: { args?: string[] } }> }).connectors;
      const h = conns.find((c) => c.id === 'bundled-hubspot');
      expect(h?.mcpConfig?.args).toEqual(['-y', '@mindstone/mcp-server-hubspot@0.2.0']);

      // Sanity: the bundled catalog has at least a few dropped connectors
      // (Fathom etc. that aren't in the ALLOWED_NPX_PACKAGE_RE whitelist).
      expect(report.droppedConnectors.length).toBeGreaterThan(0);
      // After Stage 1 widening (260525_test-failures-sweep extended sweep), the bundled
      // catalog matches CatalogSchema as-is; the sanitizer's field-stripping path is exercised
      // by the synthetic unit tests above, not by the real bundled catalog.
      expect(report.strippedFields.length).toBe(0);
    });

    it('throws clearly when the target connector is itself filtered out (whitelist drift safety)', async () => {
      // bundled-fathom is in the catalog but NOT in ALLOWED_NPX_PACKAGE_RE,
      // so the filter drops it BEFORE we can swap its args. The wrapper
      // should fail loudly here rather than silently produce an override
      // missing the target.
      await expect(
        buildSanitizedFullOverride('bundled-fathom', '@mindstone/mcp-server-fathom@0.99.0'),
      ).rejects.toThrow(/not present in override/);
    });
  });

  describe('resolveOverrideOutputPath', () => {
    it('writes under <userData>/mcp/dev-overrides/<connectorId>.json (persistent + per-connector)', () => {
      const p = resolveOverrideOutputPath('/Users/you/Library/Application Support/mindstone-rebel', 'bundled-hubspot');
      expect(p).toBe(
        path.join(
          '/Users/you/Library/Application Support/mindstone-rebel',
          'mcp',
          'dev-overrides',
          'bundled-hubspot.json',
        ),
      );
    });
  });
});
