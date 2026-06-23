// @vitest-environment happy-dom

import { describe, it, expect } from 'vitest';
import type { McpAppUiMeta } from '@shared/types';
import {
  buildCSPString,
  escapeHtmlAttribute,
  injectCspMeta,
  isMessageFromAllowedSandboxFrame,
  sanitizeCspDomain,
  STRICT_CSP,
} from '../utilities';

describe('escapeHtmlAttribute', () => {
  it('escapes ampersands', () => {
    expect(escapeHtmlAttribute('a&b')).toBe('a&amp;b');
  });

  it('escapes double quotes', () => {
    expect(escapeHtmlAttribute('a"b')).toBe('a&quot;b');
  });

  it('escapes single quotes', () => {
    expect(escapeHtmlAttribute("a'b")).toBe('a&#39;b');
  });

  it('escapes angle brackets', () => {
    expect(escapeHtmlAttribute('<script>')).toBe('&lt;script&gt;');
  });

  it('passes through safe strings', () => {
    expect(escapeHtmlAttribute('normal text')).toBe('normal text');
  });
});

describe('sanitizeCspDomain', () => {
  it('allows valid https domain', () => {
    expect(sanitizeCspDomain('https://cdn.example.com')).toBe('https://cdn.example.com');
  });

  it('allows valid http domain', () => {
    expect(sanitizeCspDomain('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('allows wildcard subdomain', () => {
    expect(sanitizeCspDomain('https://*.example.com')).toBe('https://*.example.com');
  });

  it('allows CSP scheme sources', () => {
    expect(sanitizeCspDomain('data:')).toBe('data:');
    expect(sanitizeCspDomain('blob:')).toBe('blob:');
  });

  it('rejects empty string', () => {
    expect(sanitizeCspDomain('')).toBeNull();
    expect(sanitizeCspDomain('   ')).toBeNull();
  });

  it('rejects semicolon injection', () => {
    expect(sanitizeCspDomain("https://evil.com; script-src 'unsafe-eval'")).toBeNull();
  });

  it('rejects quote injection', () => {
    expect(sanitizeCspDomain("https://evil.com' 'unsafe-eval")).toBeNull();
    expect(sanitizeCspDomain('https://evil.com" onclick=alert(1)')).toBeNull();
  });

  it('rejects newline injection', () => {
    expect(sanitizeCspDomain('https://evil.com\nscript-src *')).toBeNull();
  });

  it('trims whitespace', () => {
    expect(sanitizeCspDomain('  https://cdn.example.com  ')).toBe('https://cdn.example.com');
  });

  it('rejects bare domain without scheme', () => {
    expect(sanitizeCspDomain('cdn.example.com')).toBeNull();
  });
});

describe('buildCSPString', () => {
  it('returns restrictive default CSP when no config provided', () => {
    const csp = buildCSPString();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline' blob: data:");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain('img-src data: blob:');
    expect(csp).toContain('font-src data:');
    expect(csp).toContain('media-src blob:');
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("worker-src 'none'");
  });

  it('returns restrictive default CSP when empty config provided', () => {
    const csp = buildCSPString({});
    expect(csp).toContain("script-src 'unsafe-inline' blob: data:");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain('media-src blob:');
  });

  it('returns restrictive default CSP when empty arrays provided', () => {
    const csp = buildCSPString({ connectDomains: [], resourceDomains: [], frameDomains: [] });
    expect(csp).toContain("script-src 'unsafe-inline' blob: data:");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain('img-src data: blob:');
    expect(csp).toContain('font-src data:');
    expect(csp).toContain('media-src blob:');
    expect(csp).toContain("frame-src 'none'");
  });

  it('applies resourceDomains to script-src, style-src, img-src, font-src, and media-src', () => {
    const config: McpAppUiMeta['csp'] = {
      resourceDomains: ['https://cdn.example.com'],
    };
    const csp = buildCSPString(config);

    expect(csp).toContain("script-src 'unsafe-inline' blob: data: https://cdn.example.com");
    expect(csp).toContain("style-src 'unsafe-inline' https://cdn.example.com");
    expect(csp).toContain('img-src data: blob: https://cdn.example.com');
    expect(csp).toContain('font-src data: https://cdn.example.com');
    expect(csp).toContain('media-src blob: https://cdn.example.com');
  });

  it('applies multiple resourceDomains to all resource directives', () => {
    const config: McpAppUiMeta['csp'] = {
      resourceDomains: ['https://cdn.example.com', 'https://fonts.googleapis.com'],
    };
    const csp = buildCSPString(config);

    const expectedResource = 'https://cdn.example.com https://fonts.googleapis.com';
    expect(csp).toContain(`script-src 'unsafe-inline' blob: data: ${expectedResource}`);
    expect(csp).toContain(`style-src 'unsafe-inline' ${expectedResource}`);
    expect(csp).toContain(`img-src data: blob: ${expectedResource}`);
    expect(csp).toContain(`font-src data: ${expectedResource}`);
    expect(csp).toContain(`media-src blob: ${expectedResource}`);
  });

  it('applies connectDomains to connect-src', () => {
    const config: McpAppUiMeta['csp'] = {
      connectDomains: ['https://api.example.com'],
    };
    const csp = buildCSPString(config);
    expect(csp).toContain('connect-src https://api.example.com');
  });

  it('applies frameDomains to frame-src', () => {
    const config: McpAppUiMeta['csp'] = {
      frameDomains: ['https://embed.example.com'],
    };
    const csp = buildCSPString(config);
    expect(csp).toContain('frame-src https://embed.example.com');
  });

  it('filters out invalid domains via sanitization', () => {
    const config: McpAppUiMeta['csp'] = {
      resourceDomains: [
        'https://valid.com',
        "https://evil.com; script-src 'unsafe-eval'",
        '',
        'https://also-valid.com',
      ],
    };
    const csp = buildCSPString(config);

    expect(csp).toContain('https://valid.com');
    expect(csp).toContain('https://also-valid.com');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('evil.com');
  });

  it('handles combined CSP config', () => {
    const config: McpAppUiMeta['csp'] = {
      connectDomains: ['https://api.example.com'],
      resourceDomains: ['https://cdn.example.com'],
      frameDomains: ['https://embed.example.com'],
    };
    const csp = buildCSPString(config);

    expect(csp).toContain('connect-src https://api.example.com');
    expect(csp).toContain("script-src 'unsafe-inline' blob: data: https://cdn.example.com");
    expect(csp).toContain("style-src 'unsafe-inline' https://cdn.example.com");
    expect(csp).toContain('img-src data: blob: https://cdn.example.com');
    expect(csp).toContain('font-src data: https://cdn.example.com');
    expect(csp).toContain('media-src blob: https://cdn.example.com');
    expect(csp).toContain('frame-src https://embed.example.com');
  });

  it('does not add trailing spaces when resourceDomains is empty', () => {
    const csp = buildCSPString({ resourceDomains: [] });
    // Directives should not have trailing spaces (trim works correctly)
    expect(csp).not.toMatch(/script-src .* (?=;|$)/);
    expect(csp).toContain("script-src 'unsafe-inline' blob: data:");
    expect(csp).toContain("style-src 'unsafe-inline'");
  });

  describe('trustedDomains parameter', () => {
    it('applies trusted domains to all resource directives when no CSP config', () => {
      const csp = buildCSPString(undefined, ['https://cdn.jsdelivr.net']);
      expect(csp).toContain("script-src 'unsafe-inline' blob: data: https://cdn.jsdelivr.net");
      expect(csp).toContain("style-src 'unsafe-inline' https://cdn.jsdelivr.net");
      expect(csp).toContain('img-src data: blob: https://cdn.jsdelivr.net');
      expect(csp).toContain('font-src data: https://cdn.jsdelivr.net');
      expect(csp).toContain('media-src blob: https://cdn.jsdelivr.net');
    });

    it('merges trusted domains with existing resourceDomains', () => {
      const config: McpAppUiMeta['csp'] = {
        resourceDomains: ['https://cdnjs.cloudflare.com'],
      };
      const csp = buildCSPString(config, ['https://cdn.jsdelivr.net']);
      const expected = 'https://cdnjs.cloudflare.com https://cdn.jsdelivr.net';
      expect(csp).toContain(`script-src 'unsafe-inline' blob: data: ${expected}`);
      expect(csp).toContain(`style-src 'unsafe-inline' ${expected}`);
      expect(csp).toContain(`img-src data: blob: ${expected}`);
      expect(csp).toContain(`font-src data: ${expected}`);
      expect(csp).toContain(`media-src blob: ${expected}`);
    });

    it('handles multiple trusted domains', () => {
      const csp = buildCSPString(undefined, [
        'https://cdn.jsdelivr.net',
        'https://fonts.googleapis.com',
      ]);
      expect(csp).toContain('https://cdn.jsdelivr.net https://fonts.googleapis.com');
    });

    it('sanitizes invalid trusted domains', () => {
      const csp = buildCSPString(undefined, [
        'https://valid.com',
        "https://evil.com; script-src 'unsafe-eval'",
        'https://also-valid.com',
      ]);
      expect(csp).toContain('https://valid.com');
      expect(csp).toContain('https://also-valid.com');
      expect(csp).not.toContain('unsafe-eval');
      expect(csp).not.toContain('evil.com');
    });

    it('does not affect connect-src or frame-src', () => {
      const csp = buildCSPString(undefined, ['https://cdn.jsdelivr.net']);
      expect(csp).toContain("connect-src 'none'");
      expect(csp).toContain("frame-src 'none'");
    });

    it('handles empty trusted domains array', () => {
      const csp = buildCSPString(undefined, []);
      expect(csp).toContain("script-src 'unsafe-inline' blob: data:");
      expect(csp).toContain("style-src 'unsafe-inline'");
    });
  });
});

describe('STRICT_CSP', () => {
  it('is an array of CSP directives for plugin iframes', () => {
    expect(Array.isArray(STRICT_CSP)).toBe(true);
    expect(STRICT_CSP.length).toBeGreaterThanOrEqual(10);
  });

  it('blocks network connections', () => {
    expect(STRICT_CSP).toContain("connect-src 'none'");
  });

  it('blocks workers', () => {
    expect(STRICT_CSP).toContain("worker-src 'none'");
  });

  it('blocks nested frames', () => {
    expect(STRICT_CSP).toContain("frame-src 'none'");
  });

  it('blocks form submissions', () => {
    expect(STRICT_CSP).toContain("form-action 'none'");
  });
});

describe('injectCspMeta', () => {
  const cspFragment = 'http-equiv="Content-Security-Policy"';

  describe('plugin mode', () => {
    const injectPluginCsp = (html: string) => (
      injectCspMeta(html, { mode: 'plugin', cspString: STRICT_CSP.join('; ') })
    );

    it('injects CSP into existing <head> tag', () => {
      const html = '<html><head><title>Test</title></head><body>Hello</body></html>';
      const result = injectPluginCsp(html);

      expect(result).toContain(cspFragment);
      // CSP meta should appear right after <head>
      expect(result.indexOf(cspFragment)).toBeLessThan(result.indexOf('<title>'));
      // Original content preserved
      expect(result).toContain('<title>Test</title>');
      expect(result).toContain('Hello');
    });

    it('injects CSP when <head> has attributes', () => {
      const html = '<html><head lang="en"><title>Test</title></head><body>Hi</body></html>';
      const result = injectPluginCsp(html);

      expect(result).toContain(cspFragment);
      expect(result).toContain('lang="en"');
    });

    it('injects CSP after DOCTYPE when no <head> tag', () => {
      const html = '<!DOCTYPE html><html><body>Hello</body></html>';
      const result = injectPluginCsp(html);

      expect(result).toContain(cspFragment);
      expect(result).toContain('<!DOCTYPE html>');
      expect(result).toContain('<head>');
    });

    it('injects CSP after <html> tag when no <head> or DOCTYPE', () => {
      const html = '<html><body>Hello</body></html>';
      const result = injectPluginCsp(html);

      expect(result).toContain(cspFragment);
      expect(result).toContain('<head>');
    });

    it('wraps bare HTML with full document structure and CSP', () => {
      const html = '<div>Just a div</div>';
      const result = injectPluginCsp(html);

      expect(result).toContain(cspFragment);
      expect(result).toContain('<!DOCTYPE html>');
      expect(result).toContain('<html>');
      expect(result).toContain('<head>');
      expect(result).toContain('<body>');
      expect(result).toContain('<div>Just a div</div>');
    });

    it('wraps plain text with full document structure', () => {
      const html = 'Hello, plain text!';
      const result = injectPluginCsp(html);

      expect(result).toContain(cspFragment);
      expect(result).toContain('Hello, plain text!');
    });

    it('CSP content includes all required directives', () => {
      const result = injectPluginCsp('<html><head></head><body></body></html>');

      // Directives are HTML-attribute-escaped (single quotes → &#39;)
      expect(result).toContain('default-src &#39;none&#39;');
      expect(result).toContain('script-src &#39;unsafe-inline&#39;');
      expect(result).toContain('style-src &#39;unsafe-inline&#39;');
      expect(result).toContain('connect-src &#39;none&#39;');
      expect(result).toContain('worker-src &#39;none&#39;');
      expect(result).toContain('frame-src &#39;none&#39;');
      expect(result).toContain('object-src &#39;none&#39;');
      expect(result).toContain('base-uri &#39;none&#39;');
      expect(result).toContain('form-action &#39;none&#39;');
    });
  });

  describe('mcp-app mode', () => {
    const cspString = "default-src 'none'; script-src 'unsafe-inline'";
    const additionalHeadInserts = '<script>window.__REBEL_HOST_CONTEXT__={}</script><script>window.__REBEL_ERRORS__=[]</script>';
    const escapedCspMeta = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(cspString)}">`;
    const injections = `${escapedCspMeta}${additionalHeadInserts}`;
    const injectMcpCsp = (html: string) => injectCspMeta(html, {
      mode: 'mcp-app',
      cspString,
      additionalHeadInserts,
    });

    it('injects CSP and additional head inserts into an existing <head> tag', () => {
      const html = '<html><head data-owner="mcp"><title>Test</title></head><body>Hello</body></html>';

      expect(injectMcpCsp(html)).toBe(
        `<html><head data-owner="mcp">${injections}<title>Test</title></head><body>Hello</body></html>`,
      );
    });

    it('injects CSP and additional head inserts after DOCTYPE when no <head> tag exists', () => {
      const html = '<!DOCTYPE html><html><body>Hello</body></html>';

      expect(injectMcpCsp(html)).toBe(
        `<!DOCTYPE html><head>${injections}</head><html><body>Hello</body></html>`,
      );
    });

    it('prepends a head block without wrapping bare HTML', () => {
      const html = '<div>Just a div</div>';

      expect(injectMcpCsp(html)).toBe(`<head>${injections}</head>${html}`);
    });
  });
});

describe('isMessageFromAllowedSandboxFrame', () => {
  function createFrameWindow(): Window {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    expect(iframe.contentWindow).toBeTruthy();
    return iframe.contentWindow as Window;
  }

  function createMessageEvent(source: Window, origin: string): MessageEvent {
    return new MessageEvent('message', { source, origin });
  }

  it('allows a null-origin message from an allowed sandboxed frame', () => {
    const source = createFrameWindow();
    const event = createMessageEvent(source, 'null');

    expect(isMessageFromAllowedSandboxFrame(event, [source], ['null'])).toBe(true);
  });

  it('allows rebel-preview protocol messages from an allowed MCP App frame', () => {
    const source = createFrameWindow();

    expect(isMessageFromAllowedSandboxFrame(
      createMessageEvent(source, 'rebel-preview:'),
      [source],
      ['rebel-preview:'],
    )).toBe(true);
    expect(isMessageFromAllowedSandboxFrame(
      createMessageEvent(source, 'rebel-preview://compose-email'),
      [source],
      ['rebel-preview:'],
    )).toBe(true);
  });

  it('rejects unknown origins even when the source window is allowed', () => {
    const source = createFrameWindow();
    const event = createMessageEvent(source, 'https://evil.example');

    expect(isMessageFromAllowedSandboxFrame(event, [source], ['null'])).toBe(false);
  });

  it('allows any source window in the allowed window list', () => {
    const firstSource = createFrameWindow();
    const secondSource = createFrameWindow();
    const event = createMessageEvent(secondSource, 'null');

    expect(isMessageFromAllowedSandboxFrame(event, [firstSource, secondSource], ['null'])).toBe(true);
  });

  it('ignores null windows in the allowed window list', () => {
    const source = createFrameWindow();
    const event = createMessageEvent(source, 'null');

    expect(isMessageFromAllowedSandboxFrame(event, [null, source], ['null'])).toBe(true);
  });

  it('rejects messages from unlisted source windows', () => {
    const allowedSource = createFrameWindow();
    const otherSource = createFrameWindow();
    const event = createMessageEvent(otherSource, 'null');

    expect(isMessageFromAllowedSandboxFrame(event, [allowedSource], ['null'])).toBe(false);
  });
});
