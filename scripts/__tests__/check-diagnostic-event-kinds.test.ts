import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { check } from '../check-diagnostic-event-kinds';

describe('check-diagnostic-event-kinds', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-reconciliation-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('passes against the real codebase (current registry)', () => {
    const realSrcDir = path.join(__dirname, '..', '..', 'src');
    
    // Suppress console.log output during successful test
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    const result = check(realSrcDir);
    expect(result).toBe(true);
    
    consoleLogSpy.mockRestore();
  });

  it('fails when an extra entry exists in downstream surfaces', () => {
    // Suppress console.error output during expected failure
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    // Create mock structure
    fs.mkdirSync(path.join(tmpDir, 'core', 'services', 'diagnostics'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'shared', 'diagnostics'), { recursive: true });

    // Canonical source (2 kinds)
    fs.writeFileSync(
      path.join(tmpDir, 'core', 'services', 'diagnosticEventsLedger.ts'),
      `export const DIAGNOSTIC_EVENT_KIND_LITERALS = ['event_a', 'event_b'] as const;`
    );

    // Shared schema has extra entry 'event_c'
    fs.writeFileSync(
      path.join(tmpDir, 'shared', 'diagnostics', 'recentDiagnosticContext.ts'),
      `export const DiagnosticEventKindSchema = z.enum(['event_a', 'event_b', 'event_c']);`
    );

    // Bundle allowlist is fine
    fs.writeFileSync(
      path.join(tmpDir, 'core', 'services', 'diagnostics', 'diagnosticBundleService.ts'),
      `const VALID_DIAGNOSTIC_EVENT_KINDS = new Set(['event_a', 'event_b']);`
    );

    // Display map is fine
    fs.writeFileSync(
      path.join(tmpDir, 'core', 'services', 'diagnostics', 'diagnosticEventDisplay.ts'),
      `
      function getFriendlyEventDisplay() {
        switch (event.kind) {
          case 'event_a': break;
          case 'event_b': break;
        }
      }
      `
    );

    const result = check(tmpDir);
    expect(result).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Extra: event_c'));
    
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it('fails when an entry is missing in downstream surfaces', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    // Create mock structure
    fs.mkdirSync(path.join(tmpDir, 'core', 'services', 'diagnostics'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'shared', 'diagnostics'), { recursive: true });

    // Canonical source (3 kinds)
    fs.writeFileSync(
      path.join(tmpDir, 'core', 'services', 'diagnosticEventsLedger.ts'),
      `export const DIAGNOSTIC_EVENT_KIND_LITERALS = ['event_a', 'event_b', 'event_c'] as const;`
    );

    // Shared schema is fine
    fs.writeFileSync(
      path.join(tmpDir, 'shared', 'diagnostics', 'recentDiagnosticContext.ts'),
      `export const DiagnosticEventKindSchema = z.enum(['event_a', 'event_b', 'event_c']);`
    );

    // Bundle allowlist missing 'event_b'
    fs.writeFileSync(
      path.join(tmpDir, 'core', 'services', 'diagnostics', 'diagnosticBundleService.ts'),
      `const VALID_DIAGNOSTIC_EVENT_KINDS = new Set(['event_a', 'event_c']);`
    );

    // Display map is fine
    fs.writeFileSync(
      path.join(tmpDir, 'core', 'services', 'diagnostics', 'diagnosticEventDisplay.ts'),
      `
      function getFriendlyEventDisplay() {
        switch (event.kind) {
          case 'event_a': break;
          case 'event_b': break;
          case 'event_c': break;
        }
      }
      `
    );

    const result = check(tmpDir);
    expect(result).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Missing: event_b'));
    
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });
});
