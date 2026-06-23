import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const serverModule = require('../server.cjs') as {
  ACTION_CAPABLE_TEMPLATES: Set<string>;
  buildResourceResponse: (uri: URL, templateName: string, data: Record<string, unknown>) => {
    contents: Array<{ text: string }>;
  };
  injectActionSubstrate: (html: string) => string;
  loadActionSubstrateScript: () => string;
  loadTemplate: (name: string) => string;
};

describe('rebel-canvas server action substrate injection', () => {
  it.each(['form', 'confirm', 'picker', 'html-action'])(
    'marks shipped action-capable template %s for substrate injection',
    (templateName) => {
      expect(serverModule.ACTION_CAPABLE_TEMPLATES.has(templateName)).toBe(true);
      const html = serverModule.injectActionSubstrate('<!doctype html><html><body><main>Action</main></body></html>');

      expect(html).toContain('window.__rebelCanvas');
      expect(html).toContain('</script>');
    },
  );

  it.each(['chart', 'table', 'options', 'html'])(
    'does not inject the script into shipped non-action template %s',
    (templateName) => {
      expect(serverModule.ACTION_CAPABLE_TEMPLATES.has(templateName)).toBe(false);
      if (templateName === 'html') {
        expect('<!doctype html><html><body><p>Hi</p></body></html>').not.toContain('window.__rebelCanvas');
        return;
      }
      const response = serverModule.buildResourceResponse(
        new URL(`ui://RebelCanvas/${templateName}?id=test`),
        templateName,
        { title: 'Read-only view', type: 'bar', data: [], columns: [], rows: [], options: [] },
      );

      expect(response.contents[0].text).not.toContain('window.__rebelCanvas');
    },
  );

  it('exports helper functions without spawning stdio', () => {
    expect(serverModule.ACTION_CAPABLE_TEMPLATES.has('html-action')).toBe(true);
    expect(serverModule.loadActionSubstrateScript()).toContain('window.__rebelCanvas');
    expect(serverModule.loadTemplate('chart')).toContain('/*__DATA__*/ null');
  });

  it('keeps the shipped action allowlist stable during injection tests', () => {
    expect([...serverModule.ACTION_CAPABLE_TEMPLATES].sort()).toEqual([
      'confirm',
      'form',
      'html-action',
      'picker',
    ]);
  });
});
