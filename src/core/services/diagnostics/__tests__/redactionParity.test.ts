import { describe, it, expect } from 'vitest';
import { redactSensitiveData } from '../redaction';
import { assembleMobileBundle, redactSettingsForDiagnostics } from '../diagnosticBundleService';
import { redactObjectDeep as redactObjectDeepLog } from '@core/utils/logRedaction';
import { redactObjectDeep as redactObjectDeepSentry } from '@shared/utils/sentryRedaction';
import { isSensitiveKeyName } from '@shared/utils/redactionPatterns';

describe('diagnostics redaction parity', () => {
  it('redacts common API keys wherever core diagnostics redaction is applied', () => {
    const secret = `sk-ant-${'a'.repeat(40)}`;
    expect(redactSensitiveData(secret)).toContain('REDACTED');
    expect(JSON.stringify(redactSettingsForDiagnostics({ nested: { apiKey: secret } } as any))).toContain('REDACTED');
  });
  it('normalizes Unix and Windows user paths across bundle text', () => {
    const output = redactSensitiveData('/Users/alice/a /home/bob/b C:\\Users\\Carol\\c');
    expect(output).not.toContain('/Users/alice');
    expect(output).not.toContain('/home/bob');
    expect(output).not.toContain('Carol');
  });
  it('keeps mobile logs redacted through the shared assembly entry point', () => {
    const bundle = assembleMobileBundle({ deviceInfo: {}, filteredLogs: `Bearer ${'a'.repeat(40)}`, logLineCount: 1 }, { collectors: { getSessions: () => [], getAppVersion: () => '1', getPlatform: () => 'ios', getPlatformVersion: () => '17', getRuntimeVersion: () => 'r' } });
    expect(bundle.logs.mainNdjson).toContain('REDACTED');
  });

  // ===========================================================================
  // Rec B5 (cluster telemetry-redaction-parity, fingerprint 3d0777b0762183cc):
  // "Shared redaction-parity fixture for realistic settings/providerKeys/OAuth/
  //  MCP credentials."
  //
  // The two object redactors — `redactObjectDeep` in logRedaction (diagnostics/
  // log path) and `redactObjectDeep` in sentryRedaction (Sentry beforeSend
  // path) — both key-redact via the single shared `isSensitiveKeyName`
  // vocabulary (SENSITIVE_KEY_NAME_PATTERNS). The risk class this fixture kills:
  // a NEW credential family lands in settings/config but only one of the two
  // redactors (or the vocabulary itself) recognises its key, so the credential
  // leaks through the other telemetry path. This fixture exercises every known
  // credential family through BOTH redactors and asserts the shared vocabulary
  // matches each key — so adding a family without extending the vocab fails
  // here rather than in a production leak.
  // ===========================================================================
  describe('B5 — realistic credential families redact through both telemetry paths', () => {
    const FAMILIES: ReadonlyArray<{ name: string; key: string; value: string }> = [
      { name: 'Anthropic API key', key: 'apiKey', value: `sk-ant-${'a'.repeat(40)}` },
      { name: 'OpenAI/OpenRouter API key', key: 'openrouterApiKey', value: `sk-or-${'b'.repeat(40)}` },
      { name: 'provider keys map', key: 'providerKeys', value: `{"anthropic":"sk-ant-${'c'.repeat(40)}"}` },
      { name: 'OAuth access token', key: 'accessToken', value: `ya29.${'d'.repeat(60)}` },
      { name: 'OAuth refresh token', key: 'refreshToken', value: `1//${'e'.repeat(60)}` },
      { name: 'Slack bot token', key: 'botToken', value: `xoxb-${'f'.repeat(40)}` },
      { name: 'Slack signing secret', key: 'slackSigningSecret', value: `${'9'.repeat(32)}` },
      { name: 'ElevenLabs API key', key: 'elevenlabsApiKey', value: `${'a'.repeat(48)}` },
      { name: 'OAuth client secret', key: 'clientSecret', value: `GOCSPX-${'g'.repeat(28)}` },
      { name: 'bearer / JWT', key: 'authorization', value: `Bearer ${'h'.repeat(40)}` },
      { name: 'MCP env secret', key: 'HUBSPOT_PRIVATE_APP_TOKEN', value: `pat-na1-${'i'.repeat(36)}` },
      { name: 'device pairing code', key: 'pairingCode', value: 'ABCD-1234-EFGH' },
    ];

    it.each(FAMILIES)('redacts $name through the diagnostics/log redactObjectDeep', ({ key, value }) => {
      const out = redactObjectDeepLog({ settings: { [key]: value } }) as {
        settings: Record<string, unknown>;
      };
      // Assert key-name-driven redaction only for keys the shared vocab claims.
      // The MCP env-var key (HUBSPOT_PRIVATE_APP_TOKEN) is matched by the
      // anchored screaming-snake suffix pattern /_(TOKEN|SECRET|PASSWORD|API_KEY)$/
      // added in Stage 3 (NOT a broad /token/i).
      if (isSensitiveKeyName(key)) {
        expect(JSON.stringify(out.settings[key])).toContain('REDACTED');
        expect(JSON.stringify(out.settings[key])).not.toContain(value.slice(0, 12));
      }
    });

    it.each(FAMILIES)('redacts $name through the Sentry redactObjectDeep', ({ key, value }) => {
      const out = redactObjectDeepSentry({ settings: { [key]: value } }) as {
        settings: Record<string, unknown>;
      };
      if (isSensitiveKeyName(key)) {
        expect(JSON.stringify(out.settings[key])).toContain('REDACTED');
        expect(JSON.stringify(out.settings[key])).not.toContain(value.slice(0, 12));
      }
    });

    it('the shared vocabulary recognises every credential family key (parity SSOT)', () => {
      // This is the kill-by-test: a new family added to FAMILIES whose key is
      // not in SENSITIVE_KEY_NAME_PATTERNS fails here, forcing the vocab update
      // that both redactors then inherit for free.
      const unrecognised = FAMILIES.filter((f) => !isSensitiveKeyName(f.key));
      expect(
        unrecognised.map((f) => `${f.name} (key=${f.key})`),
        'credential family key not in the shared SENSITIVE_KEY_NAME_PATTERNS vocabulary',
      ).toEqual([]);
    });

    it('both redactors agree (parity) on a combined realistic credential object', () => {
      const obj = {
        settings: Object.fromEntries(FAMILIES.map((f) => [f.key, f.value])),
        appVersion: 'keep-me-visible',
      };
      const log = JSON.stringify(redactObjectDeepLog(obj));
      const sentry = JSON.stringify(redactObjectDeepSentry(obj));

      for (const f of FAMILIES) {
        // No raw credential prefix survives in either path.
        expect(log, `${f.name} leaked through log redactor`).not.toContain(f.value.slice(0, 12));
        expect(sentry, `${f.name} leaked through Sentry redactor`).not.toContain(f.value.slice(0, 12));
      }
      // Negative control: a non-sensitive value is preserved by both, so the
      // assertions above aren't passing by over-redacting everything.
      expect(log).toContain('keep-me-visible');
      expect(sentry).toContain('keep-me-visible');
    });
  });
});
