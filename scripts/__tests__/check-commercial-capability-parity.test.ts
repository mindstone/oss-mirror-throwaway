/**
 * Tests for the parameterized commercial-capability parity guard
 * (scripts/check-commercial-capability-parity.ts, rec cca89241502c9db7).
 *
 * Per capability: PASS on the current tree, FAIL on a simulated removed
 * desktop registration, FAIL on a simulated emptied/stubbed commercial
 * implementation, FAIL when the OSS stub gains the real capability. Mutations
 * are applied to the REAL on-disk sources via `mustReplace` (throws if the
 * pattern no longer matches), so the negative tests cannot go vacuously green
 * when the underlying files drift.
 *
 * No secret values appear here: mutations target identifiers/shapes only and
 * the synthetic OAuth provider fixture uses empty strings.
 */
import { describe, expect, it } from 'vitest';

import {
  BOOTSTRAP_CONTRACT_FILE,
  checkAuthConfigRefresh,
  checkAuthHealthCheck,
  checkAuthProvider,
  checkBootstrapSurfaceCoverage,
  checkContributionRelay,
  checkCurrentUserProvider,
  checkMeetingBotBackendConfig,
  checkOAuthCredentials,
  COMMERCIAL_CAPABILITIES,
  readParitySourcesFromDisk,
  type ParitySources,
} from '../check-commercial-capability-parity';
import { STEPS } from '../run-validate-fast';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const disk = readParitySourcesFromDisk(REPO_ROOT);

// In an OSS checkout the commercial tree is stripped; commercial-side negative
// tests only make sense when it is present (matches the guard's own skip).
const commercialPresent = disk.commercialBootstrap !== null && disk.commercialOAuthProvider !== null;

/** Apply a mutation that MUST change the source — throws if the pattern stopped matching. */
function mustReplace(source: string | null, pattern: string | RegExp, replacement: string): string {
  if (source === null) throw new Error('mustReplace: source is null');
  const mutated = source.replace(pattern, replacement);
  if (mutated === source) {
    throw new Error(`mustReplace: pattern did not match (guard fixture drifted): ${String(pattern)}`);
  }
  return mutated;
}

function withMutation(overrides: Partial<ParitySources>): ParitySources {
  return { ...disk, ...overrides };
}

describe('check-commercial-capability-parity', () => {
  describe('current tree (FP-check: all capabilities must pass clean)', () => {
    for (const capability of COMMERCIAL_CAPABILITIES) {
      it(`${capability.id} passes on the current tree`, () => {
        expect(capability.check(disk)).toEqual([]);
      });
      it(`${capability.id} is error-gated (passed the 260610 FP-check)`, () => {
        expect(capability.enforcement).toBe('error');
      });
    }

    it('surface-coverage passes on the current PrivateMindstoneBootstrap contract', () => {
      const contract = readFileSync(path.join(REPO_ROOT, BOOTSTRAP_CONTRACT_FILE), 'utf8');
      expect(checkBootstrapSurfaceCoverage(contract)).toEqual([]);
    });
  });

  describe('oauth-credentials (original guard, assertions preserved)', () => {
    it('fails when the desktop registration call is removed', () => {
      const mutated = withMutation({
        desktopMain: mustReplace(disk.desktopMain, 'setOAuthCredentialsProvider(LIVE_OAUTH_CREDENTIALS_PROVIDER)', 'void 0'),
      });
      expect(checkOAuthCredentials(mutated).join('\n')).toContain('setOAuthCredentialsProvider');
    });

    it('fails when the OSS stub gains a credential literal', () => {
      const mutated = withMutation({
        stubOAuthProvider:
          disk.stubOAuthProvider + "\nconst LEAKED = { google: { clientId: 'not-a-real-id' } };\n",
      });
      expect(checkOAuthCredentials(mutated).join('\n')).toContain('must not contain credential literals');
    });

    it('fails on an emptied commercial provider (synthetic fixture, empty literals only)', () => {
      // Shape-only fixture: all connectors present but blank — the exact "scrub stubbed
      // the values" failure. No secrets involved.
      const empty = "{ clientId: '', clientSecret: '' }";
      const syntheticProvider = `
        const CREDENTIALS = {
          google: ${empty}, slack: ${empty}, hubspot: ${empty}, github: ${empty},
          plaud: ${empty}, digitalocean: ${empty}, microsoft: { clientId: '' },
        };
        export const LIVE_OAUTH_CREDENTIALS_PROVIDER = { get: (c) => CREDENTIALS[c] ?? null };
      `;
      const errors = checkOAuthCredentials(withMutation({ commercialOAuthProvider: syntheticProvider }));
      expect(errors.join('\n')).toContain('empty/missing clientId');
      expect(errors.join('\n')).toContain('requires a clientSecret');
    });

    it('fails when a connector is missing from the commercial provider entirely', () => {
      const syntheticProvider = `
        const CREDENTIALS = { google: { clientId: 'x', clientSecret: 'y' } };
        export const LIVE_OAUTH_CREDENTIALS_PROVIDER = { get: (c) => CREDENTIALS[c] ?? null };
      `;
      const errors = checkOAuthCredentials(withMutation({ commercialOAuthProvider: syntheticProvider }));
      expect(errors.join('\n')).toContain('missing credentials for "slack"');
    });

    it.skipIf(!commercialPresent)('fails when the commercial bootstrap drops the provider key', () => {
      const mutated = withMutation({
        commercialBootstrap: mustReplace(disk.commercialBootstrap, /\n\s*LIVE_OAUTH_CREDENTIALS_PROVIDER,/, '\n'),
      });
      expect(checkOAuthCredentials(mutated).join('\n')).toContain(
        'does not wire LIVE_OAUTH_CREDENTIALS_PROVIDER',
      );
    });
  });

  describe('meeting-bot-backend-config', () => {
    it('fails when the desktop setMeetingBotBackendConfigProvider call is removed', () => {
      const mutated = withMutation({
        desktopMain: mustReplace(
          disk.desktopMain,
          'setMeetingBotBackendConfigProvider(LIVE_MEETING_BOT_BACKEND_CONFIG_PROVIDER)',
          'void 0',
        ),
      });
      expect(checkMeetingBotBackendConfig(mutated).join('\n')).toContain('setMeetingBotBackendConfigProvider');
    });

    it.skipIf(!commercialPresent)('fails when the commercial bootstrap drops the provider key', () => {
      const mutated = withMutation({
        commercialBootstrap: mustReplace(
          disk.commercialBootstrap,
          /\n\s*LIVE_MEETING_BOT_BACKEND_CONFIG_PROVIDER,/,
          '\n',
        ),
      });
      expect(checkMeetingBotBackendConfig(mutated).join('\n')).toContain(
        'does not wire LIVE_MEETING_BOT_BACKEND_CONFIG_PROVIDER',
      );
    });

    it('fails when the OSS stub bootstrap drops the provider key', () => {
      const mutated = withMutation({
        stubBootstrap: mustReplace(
          disk.stubBootstrap,
          /\n\s*LIVE_MEETING_BOT_BACKEND_CONFIG_PROVIDER,/,
          '\n',
        ),
      });
      expect(checkMeetingBotBackendConfig(mutated).join('\n')).toContain(
        'does not wire LIVE_MEETING_BOT_BACKEND_CONFIG_PROVIDER',
      );
    });
  });

  describe('auth-provider', () => {
    it('fails when the desktop setRebelAuthProvider call is removed', () => {
      const mutated = withMutation({
        desktopMain: mustReplace(disk.desktopMain, 'setRebelAuthProvider(LIVE_AUTH_PROVIDER)', 'void 0'),
      });
      expect(checkAuthProvider(mutated).join('\n')).toContain('setRebelAuthProvider');
    });

    it.skipIf(!commercialPresent)('fails when the commercial auth provider is swapped for the OSS null provider', () => {
      const mutated = withMutation({
        commercialBootstrap: mustReplace(
          disk.commercialBootstrap,
          'LIVE_AUTH_PROVIDER = DESKTOP_REBEL_AUTH_PROVIDER',
          'LIVE_AUTH_PROVIDER = OSS_NULL_AUTH_PROVIDER',
        ),
      });
      expect(checkAuthProvider(mutated).join('\n')).toContain('must be DESKTOP_REBEL_AUTH_PROVIDER');
    });

    it('fails when the OSS stub swaps in a real auth provider', () => {
      const mutated = withMutation({
        stubBootstrap: mustReplace(
          disk.stubBootstrap,
          'LIVE_AUTH_PROVIDER = OSS_NULL_AUTH_PROVIDER',
          'LIVE_AUTH_PROVIDER = DESKTOP_REBEL_AUTH_PROVIDER',
        ),
      });
      expect(checkAuthProvider(mutated).join('\n')).toContain('must stay OSS_NULL_AUTH_PROVIDER');
    });
  });

  describe('current-user-provider', () => {
    it('fails when the desktop setCurrentUserProviderFactory call is removed', () => {
      const mutated = withMutation({
        desktopMain: mustReplace(disk.desktopMain, 'setCurrentUserProviderFactory(LIVE_CURRENT_USER_PROVIDER_FACTORY)', 'void 0'),
      });
      expect(checkCurrentUserProvider(mutated).join('\n')).toContain('setCurrentUserProviderFactory');
    });

    it.skipIf(!commercialPresent)('fails when the commercial factory stops constructing the real provider', () => {
      const mutated = withMutation({
        commercialBootstrap: mustReplace(
          disk.commercialBootstrap,
          /new ElectronCurrentUserProvider\(\)/,
          '({ getCurrentUser: () => null })',
        ),
      });
      expect(checkCurrentUserProvider(mutated).join('\n')).toContain('must construct ElectronCurrentUserProvider');
    });

    it('fails when the OSS stub references the real current-user provider', () => {
      const mutated = withMutation({
        stubBootstrap: disk.stubBootstrap + '\nconst LEAK = ElectronCurrentUserProvider;\n',
      });
      expect(checkCurrentUserProvider(mutated).join('\n')).toContain('must not reference ElectronCurrentUserProvider');
    });
  });

  describe('contribution-relay', () => {
    it('fails when the desktop registerPrivateMindstoneHandlers call is removed', () => {
      const mutated = withMutation({
        desktopMain: mustReplace(disk.desktopMain, /registerPrivateMindstoneHandlers\(getHandlerRegistry\(\)\);/, ';'),
      });
      expect(checkContributionRelay(mutated).join('\n')).toContain('registerPrivateMindstoneHandlers');
    });

    it.skipIf(!commercialPresent)('fails when the commercial bootstrap stops registering the relay extension', () => {
      const mutated = withMutation({
        commercialBootstrap: mustReplace(disk.commercialBootstrap, 'registerContributionRelayExtension({', 'noopRelayExtension({'),
      });
      expect(checkContributionRelay(mutated).join('\n')).toContain('registerContributionRelayExtension');
    });

    it.skipIf(!commercialPresent)('fails when the relay extension loses a member (refreshStatus)', () => {
      const mutated = withMutation({
        commercialBootstrap: mustReplace(disk.commercialBootstrap, /\n\s*refreshStatus: refreshStatusViaRelay,/, '\n'),
      });
      expect(checkContributionRelay(mutated).join('\n')).toContain('missing extension member(s): refreshStatus');
    });

    it('fails when the OSS stub registers a relay extension', () => {
      const mutated = withMutation({
        stubBootstrap: disk.stubBootstrap + '\nregisterContributionRelayExtension({ submit, refreshStatus });\n',
      });
      expect(checkContributionRelay(mutated).join('\n')).toContain('must not register a contribution relay extension');
    });
  });

  describe('auth-config-refresh', () => {
    it('fails when the desktop stops consuming forceAuthConfigRefresh', () => {
      // Seam moved from index.ts to startup/deepLinkHandler.ts (Stage 2 refactor).
      const mutated = withMutation({
        desktopDeepLink: mustReplace(disk.desktopDeepLink, /fetchAuthConfig: forceAuthConfigRefresh,/, 'fetchAuthConfig: async () => {},'),
      });
      expect(checkAuthConfigRefresh(mutated).join('\n')).toContain('never consumes forceAuthConfigRefresh');
    });

    it.skipIf(!commercialPresent)('fails when the commercial refresh becomes a no-op', () => {
      const mutated = withMutation({
        commercialBootstrap: mustReplace(
          disk.commercialBootstrap,
          /forceAuthConfigRefresh = \(\): Promise<void> => fetchAuthConfig\(\)/,
          'forceAuthConfigRefresh = (): Promise<void> => Promise.resolve()',
        ),
      });
      expect(checkAuthConfigRefresh(mutated).join('\n')).toContain('must call fetchAuthConfig');
    });

    it('fails when the OSS stub starts calling fetchAuthConfig', () => {
      const mutated = withMutation({
        stubBootstrap: disk.stubBootstrap + '\nvoid fetchAuthConfig();\n',
      });
      expect(checkAuthConfigRefresh(mutated).join('\n')).toContain('must stay a no-op');
    });
  });

  describe('auth-health-check', () => {
    it('fails when the desktop registerPrivateMindstoneHealthCheck call is removed', () => {
      const mutated = withMutation({
        desktopMain: mustReplace(disk.desktopMain, 'registerPrivateMindstoneHealthCheck({', 'void ({'),
      });
      expect(checkAuthHealthCheck(mutated).join('\n')).toContain('registerPrivateMindstoneHealthCheck');
    });

    it.skipIf(!commercialPresent)('fails when the commercial bootstrap stops registering checkAuthHealth', () => {
      const mutated = withMutation({
        commercialBootstrap: mustReplace(disk.commercialBootstrap, 'registry.registerAuthHealthCheck(checkAuthHealth);', ';'),
      });
      expect(checkAuthHealthCheck(mutated).join('\n')).toContain('checkAuthHealth');
    });
  });

  describe('GPT-5.5 stage-4 review F1 probes (stale/dead-call & no-op shapes must be RED, not false-pass)', () => {
    // Each probe below previously returned [] against the name-anywhere matchers
    // (260610_204130_reviewer-gpt-5-5-stage04.md, F1). The guard now pins the live
    // AST shape, so every one must produce an error.

    it('auth-config-refresh: no-op injection + surviving bare identifier reference fails', () => {
      // Seam moved from index.ts to startup/deepLinkHandler.ts (Stage 2 refactor).
      const mutated = withMutation({
        desktopDeepLink:
          mustReplace(disk.desktopDeepLink, 'fetchAuthConfig: forceAuthConfigRefresh,', 'fetchAuthConfig: async () => {},') +
          '\nvoid forceAuthConfigRefresh;\n',
      });
      expect(checkAuthConfigRefresh(mutated).join('\n')).toContain('never consumes forceAuthConfigRefresh');
    });

    it('contribution-relay: desktop registration demoted to a dead `if (false)` call fails', () => {
      const mutated = withMutation({
        desktopMain: mustReplace(
          disk.desktopMain,
          'registerPrivateMindstoneHandlers(getHandlerRegistry());',
          'if (false) registerPrivateMindstoneHandlers(getHandlerRegistry());',
        ),
      });
      expect(checkContributionRelay(mutated).join('\n')).toContain('registerPrivateMindstoneHandlers');
    });

    it('auth-health-check: desktop registration demoted to a dead `if (false)` call fails', () => {
      const mutated = withMutation({
        desktopMain: mustReplace(
          disk.desktopMain,
          'registerPrivateMindstoneHealthCheck({',
          'if (false) registerPrivateMindstoneHealthCheck({',
        ),
      });
      expect(checkAuthHealthCheck(mutated).join('\n')).toContain('registerPrivateMindstoneHealthCheck');
    });

    it.skipIf(!commercialPresent)('contribution-relay: no-op extension carrying the right property names fails', () => {
      const mutated = withMutation({
        commercialBootstrap: mustReplace(
          disk.commercialBootstrap,
          /registerContributionRelayExtension\(\{[\s\S]*?notifyPublished,\s*\}\);/,
          'registerContributionRelayExtension({ submit: async () => ({}), refreshStatus: async () => ({}), notifyPublished: async () => {} });',
        ),
      });
      const errors = checkContributionRelay(mutated).join('\n');
      expect(errors).toContain('not backed by');
      expect(errors).toContain('submitViaRelay');
    });

    it.skipIf(!commercialPresent)('current-user-provider: discarded `new` side effect + stub return fails', () => {
      const mutated = withMutation({
        commercialBootstrap: mustReplace(
          disk.commercialBootstrap,
          '() => new ElectronCurrentUserProvider()',
          '() => { new ElectronCurrentUserProvider(); return { getCurrentUser: () => null }; }',
        ),
      });
      expect(checkCurrentUserProvider(mutated).join('\n')).toContain('must construct ElectronCurrentUserProvider');
    });

    it.skipIf(!commercialPresent)('auth-health-check: registration moved to an unused helper fails', () => {
      const mutated = withMutation({
        commercialBootstrap:
          mustReplace(disk.commercialBootstrap, 'registry.registerAuthHealthCheck(checkAuthHealth);', ';') +
          '\nexport function unusedRegisterAuthHealth(registry: { registerAuthHealthCheck: (fn: unknown) => void }): void {\n' +
          '  registry.registerAuthHealthCheck(checkAuthHealth);\n}\n',
      });
      expect(checkAuthHealthCheck(mutated).join('\n')).toContain('checkAuthHealth');
    });
  });

  describe('surface coverage (anti-rot for FUTURE capabilities)', () => {
    it('fails when a new PrivateMindstoneBootstrap key has no registry entry', () => {
      const contract = readFileSync(path.join(REPO_ROOT, BOOTSTRAP_CONTRACT_FILE), 'utf8');
      const mutated = mustReplace(
        contract,
        'export interface PrivateMindstoneBootstrap {',
        'export interface PrivateMindstoneBootstrap {\n  LIVE_FUTURE_CAPABILITY: unknown;',
      );
      expect(checkBootstrapSurfaceCoverage(mutated).join('\n')).toContain('LIVE_FUTURE_CAPABILITY');
    });

    it('fails loudly if the PrivateMindstoneBootstrap interface moves/renames', () => {
      expect(checkBootstrapSurfaceCoverage('export const nothing = 1;').join('\n')).toContain(
        'PrivateMindstoneBootstrap interface not found',
      );
    });
  });

  describe('validate:fast wiring', () => {
    it('is wired as a validate:fast step (migrated from check-commercial-oauth-credentials)', () => {
      const step = STEPS.find((s) => s.name === 'check-commercial-capability-parity');
      expect(step?.command).toBe('npx tsx scripts/check-commercial-capability-parity.ts');
      expect(STEPS.some((s) => s.name === 'check-commercial-oauth-credentials')).toBe(false);
    });
  });
});
