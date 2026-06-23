import { describe, expect, it } from 'vitest';

import {
  ALLOWLISTED_WILL_QUIT_PREVENTERS,
  checkWillQuitPreventDefaultChokepoint,
  extractRegistrationCallSpan,
  type ScannedFile,
} from '../check-will-quit-preventdefault-chokepoint';
import { STEPS } from '../run-validate-fast';
import { GUARD_NAMES as SOURCE_POLICY_GUARDS } from '../groups/source-policy-chokepoints';

const BOOTSTRAP = 'src/main/bootstrap.ts';

function files(entries: Record<string, string>): ScannedFile[] {
  return Object.entries(entries).map(([relativePath, source]) => ({ relativePath, source }));
}

const DRAIN_HANDLER = `
app.on('will-quit', (event) => {
  if (!drained) {
    event.preventDefault();
    drainOutboxes().finally(() => app.quit());
  }
});
`;

describe('check-will-quit-preventdefault-chokepoint', () => {
  it('passes when only bootstrap.ts cancels will-quit and other listeners are clean', () => {
    const violations = checkWillQuitPreventDefaultChokepoint(
      files({
        [BOOTSTRAP]: DRAIN_HANDLER,
        'src/main/index.ts': `
          app.on('will-quit', () => {
            stopLatencyTracker();
            globalShortcut.unregisterAll();
          });
        `,
        'src/main/services/finalExit.ts': `
          electron.app.on('will-quit', (event) => {
            if (event.defaultPrevented) return;
            void sweep();
          });
        `,
      }),
    );

    expect(violations).toEqual([]);
  });

  it('fails on a synthetic will-quit preventDefaulter outside bootstrap', () => {
    const violations = checkWillQuitPreventDefaultChokepoint(
      files({
        [BOOTSTRAP]: DRAIN_HANDLER,
        'src/main/services/someLazyService.ts': `
          app.on('will-quit', (event) => {
            event.preventDefault();
            void dialog.showMessageBox({ message: 'Really quit?' }).then(retry);
          });
        `,
      }),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]!.relativePath).toBe('src/main/services/someLazyService.ts');
    expect(violations[0]!.message).toContain('before-quit');
  });

  it('catches once/addListener/onElectronAppEvent registration forms', () => {
    for (const form of [
      `app.once('will-quit', (e) => { e.preventDefault(); })`,
      `app.addListener('will-quit', (e) => { e.preventDefault(); })`,
      `onElectronAppEvent('will-quit', (e) => { e.preventDefault(); })`,
    ]) {
      const violations = checkWillQuitPreventDefaultChokepoint(
        files({
          [BOOTSTRAP]: DRAIN_HANDLER,
          'src/main/other.ts': form,
        }),
      );
      expect(violations, form).toHaveLength(1);
    }
  });

  it('does not flag preventDefault on OTHER events in the same file', () => {
    const violations = checkWillQuitPreventDefaultChokepoint(
      files({
        [BOOTSTRAP]: DRAIN_HANDLER,
        'src/main/services/quitGuard.ts': `
          app.on('before-quit', (event) => {
            event.preventDefault();
            void confirmQuit();
          });
          app.on('will-quit', () => {
            cleanupOnly();
          });
        `,
      }),
    );

    expect(violations).toEqual([]);
  });

  it('ignores preventDefault mentions in comments and strings inside the listener', () => {
    const violations = checkWillQuitPreventDefaultChokepoint(
      files({
        [BOOTSTRAP]: DRAIN_HANDLER,
        'src/main/services/commented.ts': `
          app.on('will-quit', () => {
            // never call preventDefault here (see finalExit.ts backstop)
            log("calling preventDefault would be bad :) and a paren ( inside a string");
            cleanup();
          });
        `,
      }),
    );

    expect(violations).toEqual([]);
  });

  it('fails on a stale allowlist entry', () => {
    const violations = checkWillQuitPreventDefaultChokepoint(
      files({
        [BOOTSTRAP]: `
          app.on('will-quit', () => {
            drainOutboxesWithoutCancelling();
          });
        `,
      }),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain('stale');
  });

  it('every allowlist entry carries a non-empty evidence note', () => {
    for (const [file, evidence] of ALLOWLISTED_WILL_QUIT_PREVENTERS) {
      expect(evidence.length, file).toBeGreaterThan(20);
    }
  });

  it('extractRegistrationCallSpan balances parens across strings and comments', () => {
    const source = `
      before();
      app.on('will-quit', (event) => {
        // a comment with an unmatched paren (
        log('string with ) unmatched close');
        inner(call(nested()));
      });
      after('will-quit-not-a-registration');
    `;
    const matchIndex = source.indexOf("on('will-quit'");
    const span = extractRegistrationCallSpan(source, matchIndex);

    expect(span).toContain('inner(call(nested()))');
    expect(span).not.toContain('after(');
  });

  it('is wired into validate:fast via the source-policy-chokepoints group', () => {
    expect(STEPS.map((step) => step.name)).toContain('validate:source-policy-chokepoints');
    expect(SOURCE_POLICY_GUARDS).toContain('check-will-quit-preventdefault-chokepoint');
  });
});
