import { redirectSystemPath } from '../../app/+native-intent';

describe('redirectSystemPath', () => {
  const originalE2eFlag = process.env.EXPO_PUBLIC_REBEL_E2E;

  afterEach(() => {
    if (originalE2eFlag === undefined) {
      delete process.env.EXPO_PUBLIC_REBEL_E2E;
    } else {
      process.env.EXPO_PUBLIC_REBEL_E2E = originalE2eFlag;
    }
  });

  it('redirects E2E pair deep links only when mobile E2E mode is enabled', () => {
    const pairLink = 'rebel://e2e/pair?cloudUrl=http%3A%2F%2F127.0.0.1%3A8080&token=test-token&runId=run-123';

    delete process.env.EXPO_PUBLIC_REBEL_E2E;
    expect(redirectSystemPath({ path: pairLink, initial: true })).toBe(pairLink);

    process.env.EXPO_PUBLIC_REBEL_E2E = '1';
    expect(redirectSystemPath({ path: pairLink, initial: true })).toBe(
      '/(e2e)/pair?cloudUrl=http%3A%2F%2F127.0.0.1%3A8080&token=test-token&runId=run-123',
    );
  });

  it('redirects legacy three-slash widget deep link to a new auto-record conversation', () => {
    const redirected = redirectSystemPath({ path: 'rebel:///start-voice', initial: true });

    expect(redirected).toMatch(
      /^\/conversation\/mobile-\d+-[a-z0-9]+\?autoRecord=true&source=widget$/,
    );
  });

  it('redirects canonical rebel://action/start-voice to a new auto-record conversation', () => {
    const redirected = redirectSystemPath({ path: 'rebel://action/start-voice', initial: true });

    expect(redirected).toMatch(
      /^\/conversation\/mobile-\d+-[a-z0-9]+\?autoRecord=true&source=widget$/,
    );
  });

  it('redirects path-only widget deep link', () => {
    const redirected = redirectSystemPath({ path: '/start-voice', initial: false });

    expect(redirected).toMatch(
      /^\/conversation\/mobile-\d+-[a-z0-9]+\?autoRecord=true&source=widget$/,
    );
  });

  it('redirects start-meeting-recording (legacy and canonical)', () => {
    expect(redirectSystemPath({ path: 'rebel:///start-meeting-recording', initial: true })).toBe(
      '/meeting-recording?source=widget',
    );
    expect(redirectSystemPath({ path: 'rebel://action/start-meeting-recording', initial: true })).toBe(
      '/meeting-recording?source=widget',
    );
  });

  it('redirects stop-meeting-recording (legacy and canonical)', () => {
    expect(redirectSystemPath({ path: 'rebel:///stop-meeting-recording', initial: false })).toBe(
      '/meeting-recording?action=stop&source=widget',
    );
    expect(redirectSystemPath({ path: 'rebel://action/stop-meeting-recording', initial: false })).toBe(
      '/meeting-recording?action=stop&source=widget',
    );
  });

  it('redirects rebel:///inbox-item/{id} to the inbox tab with the item focused', () => {
    expect(redirectSystemPath({ path: 'rebel:///inbox-item/abc-123', initial: false })).toBe(
      '/(tabs)/inbox?itemId=abc-123&source=widget',
    );
  });

  it('redirects canonical rebel://tasks/{id} to the inbox tab with the item focused', () => {
    expect(redirectSystemPath({ path: 'rebel://tasks/approval-xyz', initial: false })).toBe(
      '/(tabs)/inbox?itemId=approval-xyz&source=widget',
    );
  });

  it('redirects feedback deep links to the help tab and preserves continuity flag', () => {
    const redirected = redirectSystemPath({
      path: 'rebel://feedback/bug?description=Sync+issue&attachContinuityDiagnostics=1',
      initial: false,
    });

    expect(redirected.startsWith('/(tabs)/help?')).toBe(true);
    expect(redirected).toContain('feedbackType=bug');
    expect(redirected).toContain('description=Sync+issue');
    expect(redirected).toContain('attachContinuityDiagnostics=1');
  });

  it('does not redirect URLs that merely contain start-voice as substring', () => {
    const paths = [
      '/start-voice-later',
      '/foo/start-voice',
      'rebel:///settings/start-voice-config',
    ];

    for (const path of paths) {
      expect(redirectSystemPath({ path, initial: false })).toBe(path);
    }
  });

  it('passes through non-widget URLs unchanged', () => {
    const paths = ['rebel://conversations', '/inbox', 'arbitrary/path', '', '/'];

    for (const path of paths) {
      expect(redirectSystemPath({ path, initial: false })).toBe(path);
    }
  });

  it('does not crash on malformed URLs and returns the original path', () => {
    const malformedPath = 'rebel://%E0%A4%A';

    expect(() => redirectSystemPath({ path: malformedPath, initial: false })).not.toThrow();
    expect(redirectSystemPath({ path: malformedPath, initial: false })).toBe(malformedPath);
  });
});
