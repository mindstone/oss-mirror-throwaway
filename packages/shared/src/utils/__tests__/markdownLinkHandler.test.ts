import { createMarkdownLinkHandler, type LinkPolicy } from '../markdownLinkHandler';

type PolicySpies = Required<LinkPolicy>;

function createPolicySpies(): PolicySpies {
  return {
    onOpenFile: vi.fn(),
    onOpenFileUrl: vi.fn(),
    onOpenImage: vi.fn(),
    onOpenFolder: vi.fn(),
    onOpenConversation: vi.fn(),
    onOpenTutorial: vi.fn(),
    onNavigate: vi.fn(),
    onBlocked: vi.fn(),
  };
}

function expectNoCallbacks(spies: PolicySpies) {
  expect(spies.onOpenFile).not.toHaveBeenCalled();
  expect(spies.onOpenFileUrl).not.toHaveBeenCalled();
  expect(spies.onOpenImage).not.toHaveBeenCalled();
  expect(spies.onOpenFolder).not.toHaveBeenCalled();
  expect(spies.onOpenConversation).not.toHaveBeenCalled();
  expect(spies.onOpenTutorial).not.toHaveBeenCalled();
  expect(spies.onNavigate).not.toHaveBeenCalled();
  expect(spies.onBlocked).not.toHaveBeenCalled();
}

describe('createMarkdownLinkHandler', () => {
  it('ignores empty URLs without firing callbacks', () => {
    const spies = createPolicySpies();
    const dispatcher = createMarkdownLinkHandler(spies);

    expect(dispatcher('')).toEqual({ action: 'ignore' });
    expectNoCallbacks(spies);
  });

  it('opens rebel conversation links', () => {
    const spies = createPolicySpies();
    const dispatcher = createMarkdownLinkHandler(spies);

    expect(dispatcher('rebel://conversation/abc-123')).toEqual({
      action: 'handled',
      kind: 'conversation',
    });
    expect(spies.onOpenConversation).toHaveBeenCalledWith('abc-123');
  });

  describe('rebel:// URL validation', () => {
    it('blocks unknown rebel hosts with invalid-rebel-url', () => {
      const spies = createPolicySpies();
      const dispatcher = createMarkdownLinkHandler(spies);

      expect(dispatcher('rebel://foo/bar')).toEqual({
        action: 'blocked',
        reason: 'invalid-rebel-url',
        url: 'rebel://foo/bar',
      });
      expect(spies.onBlocked).toHaveBeenCalledWith('rebel://foo/bar', 'invalid-rebel-url');
      expect(spies.onNavigate).not.toHaveBeenCalled();
    });

    it('routes rebel://conversation/ (empty id) as sessions-root navigation', () => {
      // Canonical parser maps rebel://conversation/ → { type: 'sessions' }
      // (sessions root), so we preserve that semantic instead of blocking.
      const spies = createPolicySpies();
      const dispatcher = createMarkdownLinkHandler(spies);

      expect(dispatcher('rebel://conversation/')).toEqual({
        action: 'handled',
        kind: 'rebel-nav',
      });
      expect(spies.onNavigate).toHaveBeenCalledWith('rebel://conversation/');
      expect(spies.onOpenConversation).not.toHaveBeenCalled();
    });

    it('routes rebel://sessions (no id) as sessions-root navigation', () => {
      const spies = createPolicySpies();
      const dispatcher = createMarkdownLinkHandler(spies);

      expect(dispatcher('rebel://sessions')).toEqual({
        action: 'handled',
        kind: 'rebel-nav',
      });
      expect(spies.onNavigate).toHaveBeenCalledWith('rebel://sessions');
      expect(spies.onOpenConversation).not.toHaveBeenCalled();
    });

    it('routes rebel://sessions/abc-123 as a specific conversation', () => {
      const spies = createPolicySpies();
      const dispatcher = createMarkdownLinkHandler(spies);

      expect(dispatcher('rebel://sessions/abc-123')).toEqual({
        action: 'handled',
        kind: 'conversation',
      });
      expect(spies.onOpenConversation).toHaveBeenCalledWith('abc-123');
    });

    it('blocks malformed percent-encoding in conversation id', () => {
      // decodeURIComponent('%GG') throws, so silently passing the raw
      // firstSegment through would route a garbage id — block instead.
      const spies = createPolicySpies();
      const dispatcher = createMarkdownLinkHandler(spies);

      expect(dispatcher('rebel://conversation/%GG')).toEqual({
        action: 'blocked',
        reason: 'invalid-rebel-url',
        url: 'rebel://conversation/%GG',
      });
      expect(spies.onOpenConversation).not.toHaveBeenCalled();
    });

    it('accepts rebel://feedback and rebel://feedback/bug', () => {
      const spies = createPolicySpies();
      const dispatcher = createMarkdownLinkHandler(spies);

      expect(dispatcher('rebel://feedback')).toEqual({
        action: 'handled',
        kind: 'rebel-nav',
      });
      expect(spies.onNavigate).toHaveBeenCalledWith('rebel://feedback');

      expect(dispatcher('rebel://feedback/bug')).toEqual({
        action: 'handled',
        kind: 'rebel-nav',
      });
      expect(spies.onNavigate).toHaveBeenCalledWith('rebel://feedback/bug');
    });

    it('routes validated rebel navigation links through onNavigate', () => {
      const spies = createPolicySpies();
      const dispatcher = createMarkdownLinkHandler(spies);

      expect(dispatcher('rebel://settings/agents')).toEqual({
        action: 'handled',
        kind: 'rebel-nav',
      });
      expect(spies.onNavigate).toHaveBeenCalledWith('rebel://settings/agents');
    });

    it('accepts rebel://space links when the space name is present', () => {
      const spies = createPolicySpies();
      const dispatcher = createMarkdownLinkHandler(spies);

      expect(dispatcher('rebel://space/Exec/memory.md')).toEqual({
        action: 'handled',
        kind: 'rebel-nav',
      });
      expect(spies.onNavigate).toHaveBeenCalledWith('rebel://space/Exec/memory.md');
    });

    it('blocks rebel://space without a space name', () => {
      const spies = createPolicySpies();
      const dispatcher = createMarkdownLinkHandler(spies);

      expect(dispatcher('rebel://space')).toEqual({
        action: 'blocked',
        reason: 'invalid-rebel-url',
        url: 'rebel://space',
      });
      expect(spies.onNavigate).not.toHaveBeenCalled();
    });

    it('blocks rebel://media without a resource path', () => {
      const spies = createPolicySpies();
      const dispatcher = createMarkdownLinkHandler(spies);

      expect(dispatcher('rebel://media')).toEqual({
        action: 'blocked',
        reason: 'invalid-rebel-url',
        url: 'rebel://media',
      });
      expect(spies.onNavigate).not.toHaveBeenCalled();
    });

    it('accepts rebel://action/{verb} with a verb', () => {
      const spies = createPolicySpies();
      const dispatcher = createMarkdownLinkHandler(spies);

      expect(dispatcher('rebel://action/start-voice')).toEqual({
        action: 'handled',
        kind: 'rebel-nav',
      });
      expect(spies.onNavigate).toHaveBeenCalledWith('rebel://action/start-voice');
    });

    it('blocks rebel://action without a verb', () => {
      const spies = createPolicySpies();
      const dispatcher = createMarkdownLinkHandler(spies);

      expect(dispatcher('rebel://action')).toEqual({
        action: 'blocked',
        reason: 'invalid-rebel-url',
        url: 'rebel://action',
      });
      expect(spies.onNavigate).not.toHaveBeenCalled();
    });
  });

  it('opens sanitized tutorial links', () => {
    const spies = createPolicySpies();
    const dispatcher = createMarkdownLinkHandler(spies);

    expect(dispatcher('rebel://help/tutorials/guide%20me.html?step=1#intro')).toEqual({
      action: 'handled',
      kind: 'tutorial',
    });
    expect(spies.onOpenTutorial).toHaveBeenCalledWith(
      'rebel-system/help-for-humans/tutorials/guide me.html',
    );
  });

  it('blocks invalid tutorial traversal and only fires onBlocked', () => {
    const spies = createPolicySpies();
    const dispatcher = createMarkdownLinkHandler(spies);

    expect(dispatcher('rebel://help/tutorials/%2E%2E%2Fetc%2Fpasswd')).toEqual({
      action: 'blocked',
      reason: 'invalid-tutorial',
      url: 'rebel://help/tutorials/%2E%2E%2Fetc%2Fpasswd',
    });
    expect(spies.onBlocked).toHaveBeenCalledWith(
      'rebel://help/tutorials/%2E%2E%2Fetc%2Fpasswd',
      'invalid-tutorial',
    );
    expect(spies.onOpenTutorial).not.toHaveBeenCalled();
    expect(spies.onOpenFile).not.toHaveBeenCalled();
    expect(spies.onNavigate).not.toHaveBeenCalled();
  });

  it('blocks invalid tutorial file extensions', () => {
    const spies = createPolicySpies();
    const dispatcher = createMarkdownLinkHandler(spies);

    expect(dispatcher('rebel://help/tutorials/evil.exe')).toEqual({
      action: 'blocked',
      reason: 'invalid-tutorial',
      url: 'rebel://help/tutorials/evil.exe',
    });
    expect(spies.onBlocked).toHaveBeenCalledWith(
      'rebel://help/tutorials/evil.exe',
      'invalid-tutorial',
    );
    expect(spies.onOpenTutorial).not.toHaveBeenCalled();
  });

  it('routes other rebel links through onNavigate', () => {
    const spies = createPolicySpies();
    const dispatcher = createMarkdownLinkHandler(spies);

    expect(dispatcher('rebel://settings/profile')).toEqual({
      action: 'handled',
      kind: 'rebel-nav',
    });
    expect(spies.onNavigate).toHaveBeenCalledWith('rebel://settings/profile');
  });

  it('opens library and legacy workspace file links case-insensitively', () => {
    const spies = createPolicySpies();
    const dispatcher = createMarkdownLinkHandler(spies);

    expect(dispatcher('LiBrArY://docs%2Fguide.md')).toEqual({
      action: 'handled',
      kind: 'file',
    });
    expect(dispatcher('WORKSPACE://notes/today.md')).toEqual({
      action: 'handled',
      kind: 'file',
    });

    expect(spies.onOpenFile).toHaveBeenNthCalledWith(1, 'docs/guide.md');
    expect(spies.onOpenFile).toHaveBeenNthCalledWith(2, 'notes/today.md');
  });

  it('opens image library links except svg', () => {
    const spies = createPolicySpies();
    const dispatcher = createMarkdownLinkHandler(spies);

    expect(dispatcher('library://images/photo.png')).toEqual({
      action: 'handled',
      kind: 'image',
    });
    expect(spies.onOpenImage).toHaveBeenCalledWith('images/photo.png');

    expect(dispatcher('library://images/diagram.svg')).toEqual({
      action: 'handled',
      kind: 'file',
    });
    expect(spies.onOpenFile).toHaveBeenCalledWith('images/diagram.svg');
  });

  it('opens folder links when the path ends with a slash', () => {
    const spies = createPolicySpies();
    const dispatcher = createMarkdownLinkHandler(spies);

    expect(dispatcher('library://folder/subfolder/')).toEqual({
      action: 'handled',
      kind: 'folder',
    });
    expect(spies.onOpenFolder).toHaveBeenCalledWith('folder/subfolder/');
  });

  it('strips fragments and queries from library paths before dispatching', () => {
    const spies = createPolicySpies();
    const dispatcher = createMarkdownLinkHandler(spies);

    expect(dispatcher('library://docs/file.md?line=42#heading')).toEqual({
      action: 'handled',
      kind: 'file',
    });
    expect(spies.onOpenFile).toHaveBeenCalledWith('docs/file.md');
  });

  it('blocks empty library paths and does not fire content callbacks', () => {
    const spies = createPolicySpies();
    const dispatcher = createMarkdownLinkHandler(spies);

    expect(dispatcher('library://?q=1')).toEqual({
      action: 'blocked',
      reason: 'empty-path',
      url: 'library://?q=1',
    });
    expect(spies.onBlocked).toHaveBeenCalledWith('library://?q=1', 'empty-path');
    expect(spies.onOpenFile).not.toHaveBeenCalled();
    expect(spies.onOpenImage).not.toHaveBeenCalled();
    expect(spies.onOpenFolder).not.toHaveBeenCalled();
  });

  it('passes file URLs through the raw desktop callback', () => {
    const spies = createPolicySpies();
    const dispatcher = createMarkdownLinkHandler(spies);

    expect(dispatcher('file:///Users/me/file.md')).toEqual({
      action: 'handled',
      kind: 'file',
    });
    expect(spies.onOpenFileUrl).toHaveBeenCalledWith('file:///Users/me/file.md');
  });

  it('blocks file URLs when the platform callback is unavailable', () => {
    const spies = createPolicySpies();
    const { onOpenFileUrl: _ignored, ...mobilePolicy } = spies;
    const dispatcher = createMarkdownLinkHandler(mobilePolicy);

    expect(dispatcher('file:///tmp/notes.md')).toEqual({
      action: 'blocked',
      reason: 'platform-unsupported',
      url: 'file:///tmp/notes.md',
    });
    expect(spies.onBlocked).toHaveBeenCalledWith('file:///tmp/notes.md', 'platform-unsupported');
    expect(spies.onOpenFile).not.toHaveBeenCalled();
    expect(spies.onOpenImage).not.toHaveBeenCalled();
  });

  it('returns open-external for http(s) URLs without firing callbacks', () => {
    const spies = createPolicySpies();
    const dispatcher = createMarkdownLinkHandler(spies);

    expect(dispatcher('https://example.com')).toEqual({
      action: 'open-external',
      url: 'https://example.com',
    });
    expectNoCallbacks(spies);
  });

  it('blocks protocol-relative URLs', () => {
    const spies = createPolicySpies();
    const dispatcher = createMarkdownLinkHandler(spies);

    expect(dispatcher('//example.com/path')).toEqual({
      action: 'blocked',
      reason: 'protocol-relative',
      url: '//example.com/path',
    });
    expect(spies.onBlocked).toHaveBeenCalledWith('//example.com/path', 'protocol-relative');
    expect(spies.onOpenFile).not.toHaveBeenCalled();
  });

  it('opens relative file, image, and folder paths', () => {
    const spies = createPolicySpies();
    const dispatcher = createMarkdownLinkHandler(spies);

    expect(dispatcher('docs/file.md')).toEqual({
      action: 'handled',
      kind: 'file',
    });
    expect(dispatcher('images/photo.jpg#preview')).toEqual({
      action: 'handled',
      kind: 'image',
    });
    expect(dispatcher('docs/folder/')).toEqual({
      action: 'handled',
      kind: 'folder',
    });

    expect(spies.onOpenFile).toHaveBeenCalledWith('docs/file.md');
    expect(spies.onOpenImage).toHaveBeenCalledWith('images/photo.jpg');
    expect(spies.onOpenFolder).toHaveBeenCalledWith('docs/folder/');
  });

  it('treats Windows absolute paths as file paths instead of unknown schemes', () => {
    const spies = createPolicySpies();
    const dispatcher = createMarkdownLinkHandler(spies);

    expect(dispatcher('C:\\Users\\me\\notes.md')).toEqual({
      action: 'handled',
      kind: 'file',
    });
    expect(spies.onOpenFile).toHaveBeenCalledWith('C:\\Users\\me\\notes.md');
  });

  it('blocks unknown URL schemes and only fires onBlocked', () => {
    const spies = createPolicySpies();
    const dispatcher = createMarkdownLinkHandler(spies);

    expect(dispatcher('javascript:alert(1)')).toEqual({
      action: 'blocked',
      reason: 'unknown-scheme',
      url: 'javascript:alert(1)',
    });
    expect(spies.onBlocked).toHaveBeenCalledWith('javascript:alert(1)', 'unknown-scheme');
    expect(spies.onOpenFile).not.toHaveBeenCalled();
    expect(spies.onOpenImage).not.toHaveBeenCalled();
    expect(spies.onOpenFolder).not.toHaveBeenCalled();
    expect(spies.onNavigate).not.toHaveBeenCalled();
  });

  it('ignores anchors and plain relative text without firing callbacks', () => {
    const spies = createPolicySpies();
    const dispatcher = createMarkdownLinkHandler(spies);

    expect(dispatcher('#top')).toEqual({ action: 'ignore' });
    expect(dispatcher('notes without extension')).toEqual({ action: 'ignore' });
    expectNoCallbacks(spies);
  });

  // Stage H of docs/plans/260416_centralize_cross_surface_links.md unified the
  // workspace-relative file URL under one protocol. Confirm both legacy and
  // canonical forms route to the same file/image/folder handlers so a click on
  // `rebel://library/foo.md` behaves exactly like `library://foo.md`.
  describe('rebel://library/ canonical form (Stage H)', () => {
    it('routes rebel://library/file.md through onOpenFile (same as library://)', () => {
      const spies = createPolicySpies();
      const dispatcher = createMarkdownLinkHandler(spies);

      expect(dispatcher('rebel://library/docs%2Ffile.md')).toEqual({
        action: 'handled',
        kind: 'file',
      });
      expect(spies.onOpenFile).toHaveBeenCalledWith('docs/file.md');
      expect(spies.onNavigate).not.toHaveBeenCalled();
    });

    it('routes rebel://library/img.png through onOpenImage', () => {
      const spies = createPolicySpies();
      const dispatcher = createMarkdownLinkHandler(spies);

      expect(dispatcher('rebel://library/docs%2Fimg.png')).toEqual({
        action: 'handled',
        kind: 'image',
      });
      expect(spies.onOpenImage).toHaveBeenCalledWith('docs/img.png');
    });

    it('routes rebel://library/folder/ through onOpenFolder', () => {
      const spies = createPolicySpies();
      const dispatcher = createMarkdownLinkHandler(spies);

      expect(dispatcher('rebel://library/docs%2F')).toEqual({
        action: 'handled',
        kind: 'folder',
      });
      expect(spies.onOpenFolder).toHaveBeenCalledWith('docs/');
    });

    it('treats rebel://library/ (no path) as library-root navigation', () => {
      const spies = createPolicySpies();
      const dispatcher = createMarkdownLinkHandler(spies);

      expect(dispatcher('rebel://library/')).toEqual({
        action: 'handled',
        kind: 'rebel-nav',
      });
      expect(spies.onNavigate).toHaveBeenCalledWith('rebel://library/');
    });

    it('still supports legacy library:// form for back-compat', () => {
      const spies = createPolicySpies();
      const dispatcher = createMarkdownLinkHandler(spies);

      expect(dispatcher('library://docs%2Ffile.md')).toEqual({
        action: 'handled',
        kind: 'file',
      });
      expect(spies.onOpenFile).toHaveBeenCalledWith('docs/file.md');
    });
  });
});
