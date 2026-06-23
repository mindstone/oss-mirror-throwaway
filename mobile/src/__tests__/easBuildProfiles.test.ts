/**
 * Config-contract test for EAS build profiles (mobile/eas.json).
 *
 * Why this exists: the OSS content scrub made mobile Sentry env-driven
 * (EXPO_PUBLIC_SENTRY_DSN, read at Metro bundle time on the EAS builder), but
 * nothing delivered the variable, so mobile telemetry shipped dark. The DSN
 * itself lives as an EAS project environment variable (OWNER action:
 *   eas env:create --scope project --environment production \
 *     --name EXPO_PUBLIC_SENTRY_DSN --value <dsn> --visibility plaintext
 * — a literal DSN in repo text is blocked by the OSS mirror + the
 * oss-forbidden-patterns leak gate). What the repo CAN pin is the binding:
 * shipped builds must declare `"environment": "production"` on the production
 * profile so they pull that EAS environment instead of relying on EAS CLI
 * default-environment semantics.
 *
 * Honest limit: this proves the BINDING, not that the env var exists on EAS
 * servers (owner-verifiable only via `eas env:list --environment production`,
 * then the next build's `[Sentry:Mobile] Enabled { dsnHost }` log).
 */
import easConfig from '../../eas.json';

type BuildProfile = {
  environment?: string;
  env?: Record<string, string>;
};

const buildProfiles = (easConfig as { build: Record<string, BuildProfile> }).build;

describe('eas.json build profiles', () => {
  it('binds the production profile to the production EAS environment (Sentry DSN delivery)', () => {
    const production = buildProfiles.production;
    expect(production).toBeDefined();
    expect(production.environment).toBe('production');
  });

  it('never hardcodes a Sentry DSN in any profile env block (OSS mirror + leak gate)', () => {
    for (const [name, profile] of Object.entries(buildProfiles)) {
      for (const [key, value] of Object.entries(profile.env ?? {})) {
        expect({ profile: name, key, matchesDsn: /sentry\.io/i.test(value) }).toEqual({
          profile: name,
          key,
          matchesDsn: false,
        });
      }
    }
  });

  it('keeps the e2e profile unbound from any EAS environment (CI builds stay Sentry-free)', () => {
    // mobile-e2e.yml builds locally with this profile; binding it to an EAS
    // environment would pull EXPO_PUBLIC_SENTRY_DSN into E2E builds and send
    // CI noise to Sentry. Mobile gets for free what desktop needed
    // SENTRY_ENABLED=0 for — keep it that way.
    expect(buildProfiles.e2e).toBeDefined();
    expect(buildProfiles.e2e.environment).toBeUndefined();
  });
});
