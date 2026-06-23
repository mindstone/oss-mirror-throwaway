import { describe, expect, test } from 'vitest';

// Imports the pure-Node CI resolver (.mjs, run in CI via plain `node`). This test
// lives under scripts/__tests__/ (the desktop Vitest project glob) and is excluded
// from tsconfig.scripts.json, so the .mjs import is friction-free for `lint:ts`.
import {
  resolveMirrorPublishTrigger,
  PUBLISH_OSS_MARKER,
} from '../ci/resolve-mirror-publish-trigger.mjs';

describe('resolveMirrorPublishTrigger', () => {
  describe('push (opt-in [publish-oss] marker)', () => {
    test('marked dev push => publish to production', () => {
      const r = resolveMirrorPublishTrigger({
        eventName: 'push',
        headCommitMessage: 'feat: thing\n\n[publish-oss] cut the public mirror',
      });
      expect(r.shouldRun).toBe(true);
      expect(r.mode).toBe('publish');
      expect(r.destination).toBe('production');
      expect(r.error).toBeUndefined();
    });

    test('UNMARKED dev push => clean no-op skip, no error (THE safety property)', () => {
      const r = resolveMirrorPublishTrigger({
        eventName: 'push',
        headCommitMessage: 'fix: an ordinary change',
      });
      expect(r.shouldRun).toBe(false);
      expect(r.error).toBeUndefined(); // benign skip, not a failed run
      expect(r.mode).toBe('');
      expect(r.destination).toBe('');
    });

    test('push with empty / missing head commit message => skip (null-safe)', () => {
      expect(resolveMirrorPublishTrigger({ eventName: 'push', headCommitMessage: '' }).shouldRun).toBe(false);
      expect(resolveMirrorPublishTrigger({ eventName: 'push' }).shouldRun).toBe(false);
    });

    test('marker match is case-sensitive', () => {
      expect(resolveMirrorPublishTrigger({ eventName: 'push', headCommitMessage: 'chore: [PUBLISH-OSS]' }).shouldRun).toBe(false);
      expect(resolveMirrorPublishTrigger({ eventName: 'push', headCommitMessage: 'chore: [Publish-OSS]' }).shouldRun).toBe(false);
    });

    test('marker must be the exact bracketed token, not a loose substring', () => {
      expect(resolveMirrorPublishTrigger({ eventName: 'push', headCommitMessage: 'docs: publish oss notes' }).shouldRun).toBe(false);
      expect(resolveMirrorPublishTrigger({ eventName: 'push', headCommitMessage: 'docs: publish-oss notes' }).shouldRun).toBe(false);
    });

    test('marker anywhere in a multi-line message fires', () => {
      const r = resolveMirrorPublishTrigger({
        eventName: 'push',
        headCommitMessage: 'line1\nline2 with [publish-oss] here\nline3',
      });
      expect(r.shouldRun).toBe(true);
      expect(r.destination).toBe('production');
    });
  });

  describe('workflow_dispatch (manual control)', () => {
    test('honours publish/production', () => {
      expect(
        resolveMirrorPublishTrigger({ eventName: 'workflow_dispatch', dispatchMode: 'publish', dispatchDestination: 'production' }),
      ).toMatchObject({ shouldRun: true, mode: 'publish', destination: 'production' });
    });

    test('honours dry-run/throwaway', () => {
      expect(
        resolveMirrorPublishTrigger({ eventName: 'workflow_dispatch', dispatchMode: 'dry-run', dispatchDestination: 'throwaway' }),
      ).toMatchObject({ shouldRun: true, mode: 'dry-run', destination: 'throwaway' });
    });

    test('publish/throwaway is allowed (publish rehearsal) — dispatch does NOT force production', () => {
      expect(
        resolveMirrorPublishTrigger({ eventName: 'workflow_dispatch', dispatchMode: 'publish', dispatchDestination: 'throwaway' }),
      ).toMatchObject({ shouldRun: true, mode: 'publish', destination: 'throwaway' });
    });

    test('dry-run + production is rejected (fail-closed, loud)', () => {
      const r = resolveMirrorPublishTrigger({ eventName: 'workflow_dispatch', dispatchMode: 'dry-run', dispatchDestination: 'production' });
      expect(r.shouldRun).toBe(false);
      expect(r.error).toBeTruthy();
    });

    test('invalid mode or destination is rejected', () => {
      expect(resolveMirrorPublishTrigger({ eventName: 'workflow_dispatch', dispatchMode: 'nope', dispatchDestination: 'production' }).error).toBeTruthy();
      expect(resolveMirrorPublishTrigger({ eventName: 'workflow_dispatch', dispatchMode: 'publish', dispatchDestination: 'nope' }).error).toBeTruthy();
      expect(resolveMirrorPublishTrigger({ eventName: 'workflow_dispatch', dispatchMode: '', dispatchDestination: '' }).error).toBeTruthy();
    });
  });

  describe('fail-closed defaults', () => {
    test('unknown event => fail-closed with error', () => {
      const r = resolveMirrorPublishTrigger({ eventName: 'schedule' });
      expect(r.shouldRun).toBe(false);
      expect(r.error).toBeTruthy();
    });

    test('no input at all => fail-closed', () => {
      const r = resolveMirrorPublishTrigger();
      expect(r.shouldRun).toBe(false);
      expect(r.error).toBeTruthy();
    });
  });

  test('marker constant is the documented token', () => {
    expect(PUBLISH_OSS_MARKER).toBe('[publish-oss]');
  });
});
