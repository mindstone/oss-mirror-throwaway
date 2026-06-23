import { describe, expect, it } from 'vitest';

import {
  ALLOWLISTED_BARE_EXIT_FILES,
  PRIMITIVE_MODULE,
  checkAppExitChokepoint,
  stripComments,
  type ScannedFile,
} from '../check-app-exit-chokepoint';
import { STEPS } from '../run-validate-fast';
import { GUARD_NAMES as SOURCE_POLICY_GUARDS } from '../groups/source-policy-chokepoints';

const ALLOWLISTED_FILE = [...ALLOWLISTED_BARE_EXIT_FILES.keys()][0]!;

function files(entries: Record<string, string>): ScannedFile[] {
  return Object.entries(entries).map(([relativePath, source]) => ({ relativePath, source }));
}

describe('check-app-exit-chokepoint', () => {
  it('passes when app.exit only appears in the primitive module and allowlisted pre-watcher sites', () => {
    const violations = checkAppExitChokepoint(
      files({
        [PRIMITIVE_MODULE]: 'electron.app.exit(exitCode);',
        [ALLOWLISTED_FILE]: 'app.exit(0);',
        'src/main/services/gracefulShutdown.ts': "void immediateExitWithFseventsSweep('graceful-shutdown-complete', 0);",
      }),
    );

    expect(violations).toEqual([]);
  });

  it('fails on a bare app.exit outside the primitive and allowlist', () => {
    const violations = checkAppExitChokepoint(
      files({
        [PRIMITIVE_MODULE]: 'electron.app.exit(exitCode);',
        [ALLOWLISTED_FILE]: 'app.exit(0);',
        'src/main/services/someService.ts': 'app.exit(1);',
      }),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain('immediateExitWithFseventsSweep');
    expect(violations[0]!.relativePath).toBe('src/main/services/someService.ts');
  });

  it('catches optional-chained and namespaced receivers', () => {
    for (const call of ['electron.app.exit(0)', 'electron?.app.exit(0)', 'app?.exit(0)', 'getElectronModule()?.app.exit(0)']) {
      const violations = checkAppExitChokepoint(
        files({
          [PRIMITIVE_MODULE]: 'electron.app.exit(exitCode);',
          [ALLOWLISTED_FILE]: 'app.exit(0);',
          'src/main/other.ts': `${call};`,
        }),
      );
      expect(violations, call).toHaveLength(1);
    }
  });

  it('ignores app.exit mentions inside comments', () => {
    const violations = checkAppExitChokepoint(
      files({
        [PRIMITIVE_MODULE]: 'electron.app.exit(exitCode);',
        [ALLOWLISTED_FILE]: 'app.exit(0);',
        'src/main/commented.ts': [
          '// then call app.exit() to ensure the app quits',
          '/* legacy pattern: app.exit(0) after cleanup */',
          '/*',
          ' * multi-line: app.exit(1)',
          ' */',
          'const x = 1;',
        ].join('\n'),
      }),
    );

    expect(violations).toEqual([]);
  });

  it('ignores test files', () => {
    const violations = checkAppExitChokepoint(
      files({
        [PRIMITIVE_MODULE]: 'electron.app.exit(exitCode);',
        [ALLOWLISTED_FILE]: 'app.exit(0);',
        'src/main/services/__tests__/someService.test.ts': 'app.exit(1);',
        'src/main/services/someService.test.ts': 'app.exit(1);',
      }),
    );

    expect(violations).toEqual([]);
  });

  it('fails on a stale allowlist entry whose file no longer bare-calls app.exit', () => {
    const violations = checkAppExitChokepoint(
      files({
        [PRIMITIVE_MODULE]: 'electron.app.exit(exitCode);',
        [ALLOWLISTED_FILE]: "void immediateExitWithFseventsSweep('migrated', 0);",
      }),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain('stale');
  });

  it('every allowlist entry carries a non-empty evidence note', () => {
    for (const [file, evidence] of ALLOWLISTED_BARE_EXIT_FILES) {
      expect(evidence.length, file).toBeGreaterThan(20);
    }
  });

  it('strips line and block comments but keeps code', () => {
    expect(stripComments('code(); // app.exit(0)')).toBe('code(); ');
    expect(stripComments('a /* app.exit( */ b')).toBe('a  b');
    expect(stripComments('/*\napp.exit(\n*/\nreal()')).toBe('\n\n\nreal()');
  });

  it('is wired into validate:fast via the source-policy-chokepoints group', () => {
    expect(STEPS.map((step) => step.name)).toContain('validate:source-policy-chokepoints');
    expect(SOURCE_POLICY_GUARDS).toContain('check-app-exit-chokepoint');
  });
});
