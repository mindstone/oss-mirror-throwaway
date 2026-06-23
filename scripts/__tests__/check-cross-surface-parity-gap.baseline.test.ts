import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_ACKNOWLEDGED_EXEMPTIONS,
  runCli,
  type DiffProvider,
  type FileReader,
} from '../check-cross-surface-parity-gap';

const repoRoot = join(__dirname, '..', '..');

interface CapturedStreams {
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
  stdoutText: () => string;
  stderrText: () => string;
}

function createCapturedStreams(): CapturedStreams {
  let stdout = '';
  let stderr = '';
  return {
    stdout: {
      write(chunk: string): boolean {
        stdout += chunk;
        return true;
      },
    },
    stderr: {
      write(chunk: string): boolean {
        stderr += chunk;
        return true;
      },
    },
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

function noDiffProvider(): DiffProvider {
  return () => '';
}

describe('cross-surface parity gap acknowledged-exemption baseline', () => {
  it('keeps the detector-owned manifest pinned to the reviewed escape hatches', () => {
    expect(EXPECTED_ACKNOWLEDGED_EXEMPTIONS).toEqual([
      // 260623 (Layer 3 / DI-05): `registerManagedKeyAvailability` exemption
      // removed — cloud now wires a real `() => hasManagedOpenRouterKey()`
      // registrant (genuine cross-surface parity, not a constant stub).
      { file: 'src/core/appNavigationService.ts', target: 'setAppNavigationService' },
      { file: 'src/core/rebelAuth.ts', target: 'setRebelAuthProvider' },
      { file: 'src/core/screenshotCaptureService.ts', target: 'setScreenshotCaptureService' },
      { file: 'src/shared/types/settings.ts', target: 'field:activeProvider' },
      { file: 'src/shared/types/settings.ts', target: 'field:enabledProviders' },
      { file: 'src/shared/types/settings.ts', target: 'field:managedProviderDeactivated' },
    ]);
  });

  it('passes the normal detector CLI when live source matches the manifest', async () => {
    const streams = createCapturedStreams();
    const exitCode = await runCli([], {}, streams, {
      repoRoot,
      diffProvider: noDiffProvider(),
    });

    expect(exitCode).toBe(0);
    expect(streams.stdoutText()).toContain('Cross-surface parity gap check passed');
    expect(streams.stderrText()).toBe('');
  });

  it('fails the normal detector CLI for an unmanifested exemption even with a strong rationale', async () => {
    const streams = createCapturedStreams();
    const settingsPath = join(repoRoot, 'src/shared/types/settings.ts');
    const injectedSettingsSource = readFileSync(settingsPath, 'utf8').replace(
      '  /** Experimental features (may be unstable) */\n  experimental?: ExperimentalSettings;',
      [
        '  /** Experimental features (may be unstable) */',
        '  // CROSS_SURFACE_PARITY_EXEMPT: Test-only injected rationale is intentionally long and specific enough to prove source comments alone do not acknowledge new escape hatches.',
        '  experimental?: ExperimentalSettings;',
      ].join('\n'),
    );
    const fileReader: FileReader = (absolutePath) => {
      if (absolutePath === settingsPath) return injectedSettingsSource;
      return readFileSync(absolutePath, 'utf8');
    };

    const exitCode = await runCli([], {}, streams, {
      repoRoot,
      diffProvider: noDiffProvider(),
      fileReader,
    });

    expect(exitCode).toBe(1);
    expect(streams.stdoutText()).toBe('');
    expect(streams.stderrText()).toContain('Acknowledged CROSS_SURFACE_PARITY_EXEMPT baseline drifted');
    expect(streams.stderrText()).toContain('field:experimental');
    expect(streams.stderrText()).toContain('A long comment alone is not accepted');
    expect(streams.stderrText()).toContain('--update-acknowledged-exemptions');
  });
});
