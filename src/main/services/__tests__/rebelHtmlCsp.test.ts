import { describe, expect, it } from 'vitest';
import { getRebelHtmlCsp, MAJOR_SCRIPT_CDNS } from '../rebelHtmlCsp';

describe('getRebelHtmlCsp', () => {
  describe('strict (default)', () => {
    const csp = getRebelHtmlCsp({ trusted: false });

    it("blocks 'connect-src so beacons cannot exfiltrate", () => {
      expect(csp).toMatch(/connect-src 'none'/);
    });

    it("blocks 'form-action' to remote endpoints", () => {
      expect(csp).toMatch(/form-action 'none'/);
    });

    it('does NOT permit https: scripts wholesale', () => {
      // script-src must NOT contain bare `https:` — only the explicit CDN list.
      expect(csp).not.toMatch(/script-src[^;]*\shttps:(\s|;|$)/);
    });

    it('does NOT permit unsafe-inline scripts', () => {
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    });

    it('includes every allowlisted CDN for scripts', () => {
      for (const cdn of MAJOR_SCRIPT_CDNS) {
        expect(csp).toContain(cdn);
      }
    });

    it('keeps shared hard-blocks (frame, object, base, worker)', () => {
      expect(csp).toMatch(/frame-src 'none'/);
      expect(csp).toMatch(/object-src 'none'/);
      expect(csp).toMatch(/base-uri 'none'/);
      expect(csp).toMatch(/worker-src 'none'/);
    });
  });

  describe('trusted', () => {
    const csp = getRebelHtmlCsp({ trusted: true });

    it('permits any HTTPS script', () => {
      expect(csp).toMatch(/script-src[^;]*\shttps:/);
    });

    it("permits 'unsafe-inline' scripts", () => {
      expect(csp).toMatch(/script-src[^;]*'unsafe-inline'/);
    });

    it('permits HTTPS fetch/XHR via connect-src', () => {
      expect(csp).toMatch(/connect-src https:/);
      expect(csp).not.toMatch(/connect-src 'none'/);
    });

    it('permits HTTPS form-action', () => {
      expect(csp).toMatch(/form-action https:/);
    });

    it('still blocks nested frames, objects, base hijack, workers', () => {
      expect(csp).toMatch(/frame-src 'none'/);
      expect(csp).toMatch(/object-src 'none'/);
      expect(csp).toMatch(/base-uri 'none'/);
      expect(csp).toMatch(/worker-src 'none'/);
    });
  });
});
