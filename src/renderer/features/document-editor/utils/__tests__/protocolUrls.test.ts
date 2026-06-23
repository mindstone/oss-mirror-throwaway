import { describe, expect, it } from 'vitest';

import { getMediaProtocolUrl } from '../protocolUrls';

/**
 * Bug history (260523):
 *
 *   v1 (original): `rebel-media://${absolutePath}` placed the absolute path
 *   directly after `://`. Chromium's standard-scheme URL parser promoted the
 *   first real path segment (`Users`) into the host slot, lowercased it, and
 *   the handler silently dropped that segment.
 *
 *   v2 (first attempt at fix): `rebel-media:///${encodeURIComponent(path)}`
 *   moved the encoded path into a single segment after a triple slash
 *   (empty authority). Node's WHATWG URL parser accepted this, so unit tests
 *   passed — but Chromium's parser **rejects empty-authority forms outright**
 *   for standard schemes ("Media load rejected by URL safety check").
 *
 *   v3 (current): `rebel-media://local/${encodeURIComponent(path)}` uses the
 *   literal sentinel host `local` to satisfy Chromium's authority requirement
 *   without exposing a real path segment to the host parser. The pathname
 *   carries the encoded absolute path. The handler decodes it.
 *
 * The tests below verify both the literal URL string AND that the URL is
 * Chromium-shape compatible (host is the sentinel, pathname round-trips).
 */
describe('getMediaProtocolUrl', () => {
  const macWorkspace = '/Users/alice/Workspace/Core';

  it('emits sentinel-host form with encoded absolute path', () => {
    const url = getMediaProtocolUrl('Chief-of-Staff/song.mp3', macWorkspace);
    expect(url).toBe(
      'rebel-media://local/%2FUsers%2Falice%2FWorkspace%2FCore%2FChief-of-Staff%2Fsong.mp3'
    );
  });

  it('round-trips a macOS absolute path with case preservation', () => {
    const url = getMediaProtocolUrl('Chief-of-Staff/song.mp3', macWorkspace);
    const parsed = new URL(url);
    expect(parsed.host).toBe('local');
    const filePath = decodeURIComponent(parsed.pathname).replace(/^\//, '');
    expect(filePath).toBe('/Users/alice/Workspace/Core/Chief-of-Staff/song.mp3');
  });

  it('passes through an already-absolute Unix path', () => {
    const url = getMediaProtocolUrl('/Users/alice/Movies/clip.mp4', macWorkspace);
    const parsed = new URL(url);
    expect(parsed.host).toBe('local');
    expect(decodeURIComponent(parsed.pathname).replace(/^\//, ''))
      .toBe('/Users/alice/Movies/clip.mp4');
  });

  it('round-trips a Windows absolute path with drive letter', () => {
    const url = getMediaProtocolUrl('C:/Users/alice/song.mp3', 'C:/Users/alice/Workspace');
    const parsed = new URL(url);
    expect(parsed.host).toBe('local');
    expect(decodeURIComponent(parsed.pathname).replace(/^\//, ''))
      .toBe('C:/Users/alice/song.mp3');
  });

  it('preserves spaces and unicode in path segments', () => {
    const url = getMediaProtocolUrl('Workspace/My Files/résumé.mp3', macWorkspace);
    const parsed = new URL(url);
    expect(parsed.host).toBe('local');
    expect(decodeURIComponent(parsed.pathname).replace(/^\//, ''))
      .toBe('/Users/alice/Workspace/Core/Workspace/My Files/résumé.mp3');
  });

  // PDF preview routes through rebel-media:// (260619 fix): a renderer-origin blob:
  // URL left the packaged file:// preview blank (the exact blob:file:// fetch
  // mechanism is runtime-UNCONFIRMED; the protocol path is robust regardless), so PDFs
  // use the same origin-independent protocol URL as video/audio. Guards against a blob.
  it('emits the sentinel-host rebel-media shape for a .pdf path (no blob)', () => {
    const url = getMediaProtocolUrl('work/Mindstone/General/report.pdf', macWorkspace);
    expect(url).toBe(
      'rebel-media://local/%2FUsers%2Falice%2FWorkspace%2FCore%2Fwork%2FMindstone%2FGeneral%2Freport.pdf'
    );
    expect(url.startsWith('rebel-media://local/')).toBe(true);
    expect(url.startsWith('blob:')).toBe(false);
    const parsed = new URL(url);
    expect(parsed.host).toBe('local');
    expect(decodeURIComponent(parsed.pathname).replace(/^\//, ''))
      .toBe('/Users/alice/Workspace/Core/work/Mindstone/General/report.pdf');
  });

  it('round-trips an already-absolute .pdf path with spaces', () => {
    const url = getMediaProtocolUrl('/Users/alice/Dropbox/agentic-ai academy/overview.pdf', macWorkspace);
    const parsed = new URL(url);
    expect(parsed.host).toBe('local');
    expect(decodeURIComponent(parsed.pathname).replace(/^\//, ''))
      .toBe('/Users/alice/Dropbox/agentic-ai academy/overview.pdf');
  });
});
