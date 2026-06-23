import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setErrorReporter } from '@core/errorReporter';
import {
  HUBSPOT_TELEMETRY_EVENTS,
  deriveHubSpotAccountHash,
  emitHubSpotTelemetry,
  _testOnly,
  type HubSpotTelemetryPayload,
} from '../hubspotTelemetry';

const TEST_SALT = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const HUBSPOT_REFRESH_EVENTS_EMITTED_IN_OSS = new Set([
  'hubspot.refresh.start',
  'hubspot.refresh.success',
  'hubspot.refresh.invalid_grant',
  'hubspot.refresh.transient',
  'hubspot.refresh.rate_limited',
  'hubspot.refresh.persist_failed',
  'hubspot.refresh.lock_failed',
]);
const HUBSPOT_HOST_MULTI_CALLER_EXCEPTIONS = new Map<string, number>([
  // callback_failed can be emitted from multiple callback failure branches by design.
  ['hubspot.auth_required.callback_failed', 4],
]);
const HUBSPOT_TELEMETRY_EMIT_FILES = [
  'src/main/services/bundledMcpManager.ts',
  'src/main/services/connectorCatalogResolver.ts',
  'src/main/services/hubspotAuthService.ts',
  'src/main/services/hubspotAuthOrchestrator.ts',
  'src/main/services/managedMcpInstallService.ts',
  'src/main/services/mcpService.ts',
];
const HUBSPOT_LOG_REDACTION_SWEEP_FILES = [
  'src/main/services/bundledMcpManager.ts',
  'src/main/services/hubspotAuthService.ts',
  'src/main/services/hubspotAuthOrchestrator.ts',
  'src/main/services/mcpService.ts',
];
const LOGGER_OBJECT_CALL_RE = /log\.(?:info|warn|error)\(\s*\{([\s\S]*?)\}\s*,/g;
const FORBIDDEN_LOGGER_EMAIL_FIELD_RE = /(?:^|[,{]\s*)(?:accountEmail|email)(?:\s*:|\s*(?:,|\}))/;

describe('hubspotTelemetry', () => {
  let tempDir: string;
  const breadcrumbs: Array<{ category: string; message: string; level?: string; data?: Record<string, unknown> }> = [];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hubspot-telemetry-'));
    _testOnly.configureUserDataDirForTests(tempDir);
    _testOnly.configureSaltForTests(TEST_SALT);
    _testOnly.resetCatalogOverrideStatusForTests();
    breadcrumbs.length = 0;
    setErrorReporter({
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      addBreadcrumb: (breadcrumb) => {
        breadcrumbs.push(breadcrumb);
      },
    });
  });

  afterEach(async () => {
    _testOnly.configureUserDataDirForTests(null);
    _testOnly.configureSaltForTests(null);
    _testOnly.resetCatalogOverrideStatusForTests();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('derives account_hash with HMAC-SHA256(email, appTelemetrySalt), not plain SHA256', () => {
    const email = 'acct1@example.com';
    const expected = crypto.createHmac('sha256', Buffer.from(TEST_SALT, 'hex')).update(email).digest('hex');
    const plainSha = crypto.createHash('sha256').update(email).digest('hex');

    expect(deriveHubSpotAccountHash(email, TEST_SALT)).toBe(expected);
    expect(deriveHubSpotAccountHash(email, TEST_SALT)).not.toBe(plainSha);
  });

  it.each(HUBSPOT_TELEMETRY_EVENTS)('emits documented dimensions for %s', async (event) => {
    const payload = await emitHubSpotTelemetry({
      event,
      accountEmail: 'acct1@example.com',
      refreshAuthority: 'desktop',
      errorCode: 'TEST_CODE',
      rotationDetected: false,
      instanceId: 'HubSpot-acct1-example-com',
      quarantinedCount: 1,
    });

    expect(Object.keys(payload.dimensions).sort()).toEqual([
      'account_hash',
      'connector',
      'error_code',
      'instance_id',
      'package_version',
      'quarantined_count',
      'refresh_authority',
      'rotation_detected',
      'surface',
    ]);
    expect(payload.dimensions.connector).toBe('hubspot');
    expect(payload.dimensions.account_hash).toBe(deriveHubSpotAccountHash('acct1@example.com', TEST_SALT));
  });

  it('does not leak raw email, token material, or salt into payloads or breadcrumbs', async () => {
    const payload = await emitHubSpotTelemetry({
      event: 'hubspot.refresh.invalid_grant',
      accountEmail: 'acct1@example.com',
      errorCode: 'invalid_grant',
    });

    const serialized = JSON.stringify({ payload, breadcrumbs });
    expect(serialized).not.toContain('acct1@example.com');
    expect(serialized).not.toContain(TEST_SALT);
    expect(serialized).not.toMatch(/access_token|refresh_token|hubspot-access-token|hubspot-refresh-token/i);
    expect(breadcrumbs).toHaveLength(1);
  });

  it('persists a lazy per-install salt with 0o600 permissions', async () => {
    _testOnly.configureSaltForTests(null);
    const first = await _testOnly.getTelemetrySaltHex();
    const second = await _testOnly.getTelemetrySaltHex();

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    if (process.platform !== 'win32') {
      const mode = (await fs.stat(path.join(tempDir, 'telemetry-salt.bin'))).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('returns the same on-disk salt for concurrent getTelemetrySaltHex callers', async () => {
    _testOnly.configureSaltForTests(null);
    const [first, second] = await Promise.all([
      _testOnly.getTelemetrySaltHex(),
      _testOnly.getTelemetrySaltHex(),
    ]);
    const onDisk = (await fs.readFile(path.join(tempDir, 'telemetry-salt.bin'), 'utf8')).trim().toLowerCase();

    expect(first).toBe(second);
    expect(first).toBe(onDisk);
  });

  it('documents one canonical @emittedAt annotation and one host caller per telemetry event', async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), 'src', 'main', 'services', 'hubspotTelemetry.ts'),
      'utf8',
    );

    const hostCallerCounts = new Map<string, number>();
    const emitCallRegex = /(?:emitHubSpotTelemetry|safeEmitHubSpotTelemetry)\(\s*\{[\s\S]*?event:\s*'([^']+)'[\s\S]*?\}\s*\)/g;
    for (const relativePath of HUBSPOT_TELEMETRY_EMIT_FILES) {
      const fileSource = await fs.readFile(path.join(process.cwd(), relativePath), 'utf8');
      for (const match of fileSource.matchAll(emitCallRegex)) {
        const event = match[1];
        hostCallerCounts.set(event, (hostCallerCounts.get(event) ?? 0) + 1);
      }
    }

    for (const event of HUBSPOT_TELEMETRY_EVENTS) {
      const matches = source.match(new RegExp(`@emittedAt ${event.replace(/\./g, '\\.')}`, 'g')) ?? [];
      expect(matches, `${event} canonical emit-site annotation`).toHaveLength(1);
      const hostCallerCount = hostCallerCounts.get(event) ?? 0;
      if (HUBSPOT_REFRESH_EVENTS_EMITTED_IN_OSS.has(event)) {
        // refresh.* is emitted from the OSS package; host receives/records via bridge + breadcrumbs.
        expect(hostCallerCount, `${event} host-side caller count (OSS-emitted)`).toBe(0);
      } else if (HUBSPOT_HOST_MULTI_CALLER_EXCEPTIONS.has(event)) {
        expect(hostCallerCount, `${event} host-side caller count (known multi-caller exception)`).toBe(
          HUBSPOT_HOST_MULTI_CALLER_EXCEPTIONS.get(event),
        );
      } else {
        expect(hostCallerCount, `${event} host-side caller count`).toBe(1);
      }
    }

    for (const discoveredEvent of hostCallerCounts.keys()) {
      expect(HUBSPOT_TELEMETRY_EVENTS).toContain(discoveredEvent as typeof HUBSPOT_TELEMETRY_EVENTS[number]);
    }
  });

  it('keeps host-side telemetry/logger equivalents redacted', async () => {
    const payloads: HubSpotTelemetryPayload[] = [];
    payloads.push(await emitHubSpotTelemetry({
      event: 'hubspot.migration.instance.failed',
      accountEmail: 'acct2@example.com',
      errorCode: 'TOKEN_PERSIST_FAILED',
      instanceId: 'HubSpot-acct2-example-com',
    }));

    const serialized = JSON.stringify(payloads);
    expect(serialized).not.toContain('acct2@example.com');
    expect(serialized).not.toMatch(/access_token|refresh_token/i);
  });

  it('rejects raw email/accountEmail logger payload fields in HubSpot host source paths', async () => {
    const violations: string[] = [];

    for (const relativePath of HUBSPOT_LOG_REDACTION_SWEEP_FILES) {
      const source = await fs.readFile(path.join(process.cwd(), relativePath), 'utf8');
      for (const match of source.matchAll(LOGGER_OBJECT_CALL_RE)) {
        const payload = match[1] ?? '';
        if (FORBIDDEN_LOGGER_EMAIL_FIELD_RE.test(payload) || /\baccount\.email\b/.test(payload)) {
          violations.push(relativePath);
          break;
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('logger source sweep regex catches the historical raw accountEmail migration log pattern', () => {
    const historicalLogLine = "log.error({ catalogId, accountEmail, oldName, err: errMsg }, 'migrateBundledConnectorsToNpx: failed HubSpot instance migration; preserving legacy entry')";
    expect(FORBIDDEN_LOGGER_EMAIL_FIELD_RE.test(historicalLogLine)).toBe(true);
  });
});
