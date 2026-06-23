/**
 * Extract a normalized meeting identifier from a URL.
 * Returns a platform-prefixed ID that can be compared across URL variations.
 *
 * CANONICAL IMPLEMENTATION: Used by both the desktop app and the Cloudflare Worker.
 * Do not duplicate this logic — import from here.
 *
 * @example
 * extractMeetingId('https://us02web.zoom.us/j/123456789') // 'zoom:123456789'
 * extractMeetingId('https://meet.google.com/abc-defg-hij') // 'meet:abc-defg-hij'
 */
export function extractMeetingId(url: string): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    // Zoom: extract meeting ID from /j/{id} or /s/{id}
    if (host.includes('zoom.us')) {
      const match = parsed.pathname.match(/\/[js]\/(\d+)/);
      return match ? `zoom:${match[1]}` : null;
    }

    // Google Meet: extract code from path
    if (host === 'meet.google.com') {
      const code = parsed.pathname.slice(1).replace(/\/$/, '');
      return code ? `meet:${code}` : null;
    }

    // Microsoft Teams: Extract stable meeting identifier from path
    if (host.includes('teams.microsoft.com') || host.includes('teams.live.com')) {
      if (host.includes('teams.live.com')) {
        const meetMatch = parsed.pathname.match(/\/meet\/([^/?#]+)/);
        if (meetMatch) return `teams:live:${meetMatch[1]}`;
      }

      const joinMatch = parsed.pathname.match(/\/l\/meetup-join\/([^/?#]+)/);
      if (joinMatch) return `teams:join:${decodeURIComponent(joinMatch[1])}`;

      return `teams:${parsed.origin}${parsed.pathname}`;
    }

    // Unknown platform: use origin + pathname (ignore query params)
    return `other:${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}
