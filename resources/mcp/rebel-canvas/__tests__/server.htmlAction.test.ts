// @vitest-environment happy-dom

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type HtmlToolInput = {
  html?: string;
  filePath?: string;
  folderPath?: string;
};

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  _meta?: {
    ui?: {
      resourceUri?: string;
      protocolUrl?: string;
      originalFilePath?: string;
    };
  };
  isError?: boolean;
};

type HtmlTool = {
  inputSchema: {
    parse: (input: unknown) => HtmlToolInput;
    safeParse: (input: unknown) => { success: boolean };
  };
  handler: (input: HtmlToolInput) => Promise<ToolResult>;
};

type HtmlResource = {
  readCallback: (uri: URL) => Promise<{
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  }>;
};

type StoredHtmlEntry = {
  html?: string;
  folderPath?: string;
  originalFilePath?: string;
  _type?: string;
};

type ServerModule = {
  HTML_ACTION_SUBMIT_PATTERN: RegExp;
  dataStore: Map<string, StoredHtmlEntry>;
  detectsHtmlAction: (html: unknown) => boolean;
  injectActionSubstrate: (html: string) => string;
  server: {
    _registeredTools: Record<string, HtmlTool>;
    _registeredResourceTemplates: Record<string, HtmlResource>;
  };
};

const serverModule = require('../server.cjs') as ServerModule;
const htmlTool = serverModule.server._registeredTools.rebel_canvas_html;
const htmlResource = serverModule.server._registeredResourceTemplates['HTML View'];

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-canvas-html-action-'));
  tempDirs.push(dir);
  return dir;
}

async function callHtmlTool(input: HtmlToolInput): Promise<ToolResult> {
  const parsed = htmlTool.inputSchema.parse(input);
  const result = await htmlTool.handler(parsed);
  expect(result.isError).not.toBe(true);
  return result;
}

function resourceUriFrom(result: ToolResult): string {
  const resourceUri = result._meta?.ui?.resourceUri;
  expect(resourceUri).toBeTruthy();
  return resourceUri!;
}

function idFrom(result: ToolResult): string {
  const id = new URL(resourceUriFrom(result)).searchParams.get('id');
  expect(id).toBeTruthy();
  return id!;
}

async function readHtmlResource(result: ToolResult): Promise<string> {
  const response = await htmlResource.readCallback(new URL(resourceUriFrom(result)));
  expect(response.contents).toHaveLength(1);
  return response.contents[0].text;
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe('rebel_canvas_html action-submit opt-in', () => {
  afterEach(() => {
    serverModule.dataStore.clear();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exports a tightly scoped page-level data-rebel-submit detector', () => {
    expect(serverModule.HTML_ACTION_SUBMIT_PATTERN).toBeInstanceOf(RegExp);
    expect(serverModule.detectsHtmlAction('<button data-rebel-submit="approve">OK</button>')).toBe(true);
    expect(serverModule.detectsHtmlAction("<form data-rebel-submit='send'></form>")).toBe(true);
    expect(serverModule.detectsHtmlAction('<button data-rebel-submit=approve>OK</button>')).toBe(true);
    expect(serverModule.detectsHtmlAction('<p>The attribute is named data-rebel-submit.</p>')).toBe(false);
    expect(serverModule.detectsHtmlAction('<pre>data-rebel-submit</pre>')).toBe(false);
  });

  it.each([
    ['double-quoted value', '<button data-rebel-submit="approve">OK</button>'],
    ['single-quoted value', "<form data-rebel-submit='send'></form>"],
    ['unquoted value', '<button data-rebel-submit=approve>OK</button>'],
    ['whitespace around equals', '<button data-rebel-submit \n = \t "later">Later</button>'],
  ])('detects HTML actions only when the regex matches a %s', (_name, html) => {
    expect(serverModule.HTML_ACTION_SUBMIT_PATTERN.test(html)).toBe(true);
    expect(serverModule.detectsHtmlAction(html)).toBe(true);
  });

  it.each([
    ['plain prose mention', '<p>The attribute is named data-rebel-submit.</p>'],
    ['preformatted mention without assignment', '<pre>data-rebel-submit</pre>'],
    ['different attribute name', '<button data-rebel-submitter="approve">OK</button>'],
  ])('does not detect HTML actions for false-positive shape: %s', (_name, html) => {
    expect(serverModule.HTML_ACTION_SUBMIT_PATTERN.test(html)).toBe(false);
    expect(serverModule.detectsHtmlAction(html)).toBe(false);
  });

  it.each([
    ['commented attribute', '<!-- data-rebel-submit="x" -->'],
    ['commented button', '<!-- <button data-rebel-submit="x"> -->'],
  ])('strips HTML comments before action detection: %s', async (_name, html) => {
    expect(serverModule.detectsHtmlAction(html)).toBe(false);

    const result = await callHtmlTool({ html });
    const text = await readHtmlResource(result);

    expect(serverModule.dataStore.get(idFrom(result))?._type).toBe('html');
    expect(text).not.toContain('__rebelCanvas');
  });

  it('uses a real action element, not a comment, to drive action detection', async () => {
    const result = await callHtmlTool({
      html: [
        '<!doctype html><html><body>',
        '<!-- <button data-rebel-submit="commented">Commented</button> -->',
        '<button data-rebel-submit="real">Real</button>',
        '</body></html>',
      ].join(''),
    });
    const text = await readHtmlResource(result);

    expect(serverModule.detectsHtmlAction('<!-- data-rebel-submit="x" --><button data-rebel-submit="real">Real</button>'))
      .toBe(true);
    expect(serverModule.dataStore.get(idFrom(result))?._type).toBe('html-action');
    expect(text).toContain('window.__rebelCanvas');
    expect(text).toContain('<button data-rebel-submit="real">Real</button>');
  });

  it('injectActionSubstrate is idempotent', () => {
    const html = '<!doctype html><html><body><button data-rebel-submit="x">Send</button></body></html>';
    const once = serverModule.injectActionSubstrate(html);
    const twice = serverModule.injectActionSubstrate(once);

    expect(twice).toBe(once);
    expect(countOccurrences(twice, 'window.__rebelCanvas =')).toBe(1);
  });

  it('injects the substrate once for a single inline button and preserves the original button', async () => {
    const result = await callHtmlTool({
      html: '<!doctype html><html><body><button data-rebel-submit="approve">OK</button></body></html>',
    });

    expect(serverModule.dataStore.get(idFrom(result))?._type).toBe('html-action');

    const text = await readHtmlResource(result);
    const buttonIndex = text.indexOf('<button data-rebel-submit="approve">OK</button>');
    const scriptIndex = text.indexOf('<script>');
    const closingBodyIndex = text.toLowerCase().lastIndexOf('</body>');

    expect(text).toContain('window.__rebelCanvas');
    expect(buttonIndex).toBeGreaterThanOrEqual(0);
    expect(scriptIndex).toBeGreaterThan(buttonIndex);
    expect(scriptIndex).toBeLessThan(closingBodyIndex);
  });

  it('injects the substrate for unquoted data-rebel-submit attributes', async () => {
    const result = await callHtmlTool({
      html: '<!doctype html><html><body><button data-rebel-submit=approve>OK</button></body></html>',
    });

    const text = await readHtmlResource(result);

    expect(serverModule.dataStore.get(idFrom(result))?._type).toBe('html-action');
    expect(text).toContain('window.__rebelCanvas');
    expect(text).toContain('<button data-rebel-submit=approve>OK</button>');
  });

  it.each([
    {
      name: 'before closing body',
      html: '<!doctype html><html><body><main>Before</main><button data-rebel-submit="x">OK</button></body></html>',
      closingMarker: '</body>',
    },
    {
      name: 'before closing html when body is absent',
      html: '<!doctype html><html><main>Before</main><button data-rebel-submit="x">OK</button></html>',
      closingMarker: '</html>',
    },
    {
      name: 'at end when no body or html close tag is present',
      html: '<main>Before</main><button data-rebel-submit="x">OK</button>',
      closingMarker: null,
    },
  ])('injects Stage 4 HTML substrate $name', async ({ html, closingMarker }) => {
    const result = await callHtmlTool({ html });
    const text = await readHtmlResource(result);
    const scriptIndex = text.indexOf('<script>');

    expect(serverModule.dataStore.get(idFrom(result))?._type).toBe('html-action');
    expect(countOccurrences(text, 'window.__rebelCanvas =')).toBe(1);
    expect(scriptIndex).toBeGreaterThanOrEqual(0);

    if (closingMarker) {
      expect(scriptIndex).toBeLessThan(text.toLowerCase().lastIndexOf(closingMarker));
    } else {
      expect(scriptIndex).toBeGreaterThanOrEqual(html.length);
      expect(text.endsWith('</script>')).toBe(true);
    }
  });

  it('uses stored _type as the resource-handler runtime contract', async () => {
    serverModule.dataStore.set('direct-action', {
      _type: 'html-action',
      html: '<!doctype html><html><body><p>Stored as action.</p></body></html>',
    });
    serverModule.dataStore.set('direct-html', {
      _type: 'html',
      html: '<!doctype html><html><body><button data-rebel-submit="late">Late</button></body></html>',
    });
    serverModule.dataStore.set('direct-preview', {
      _type: 'preview',
      folderPath: '/tmp/rebel-canvas-preview',
    });

    const actionText = (await htmlResource.readCallback(new URL('ui://RebelCanvas/html?id=direct-action'))).contents[0].text;
    const htmlText = (await htmlResource.readCallback(new URL('ui://RebelCanvas/html?id=direct-html'))).contents[0].text;
    const previewText = (await htmlResource.readCallback(new URL('ui://RebelCanvas/html?id=direct-preview'))).contents[0].text;

    expect(actionText).toContain('window.__rebelCanvas');
    expect(htmlText).not.toContain('__rebelCanvas');
    expect(previewText).toContain('Loading preview via protocol');
    expect(previewText).not.toContain('__rebelCanvas');
  });

  it('runs detection at tool invocation time and does not re-run it while serving stored HTML', async () => {
    const actionResult = await callHtmlTool({
      html: '<!doctype html><html><body><button data-rebel-submit="send">Send</button></body></html>',
    });
    const plainResult = await callHtmlTool({
      html: '<!doctype html><html><body><p>Plain at invocation.</p></body></html>',
    });
    const actionEntry = serverModule.dataStore.get(idFrom(actionResult));
    const plainEntry = serverModule.dataStore.get(idFrom(plainResult));

    expect(actionEntry?._type).toBe('html-action');
    expect(plainEntry?._type).toBe('html');

    actionEntry!.html = '<!doctype html><html><body><p>Attribute removed after storage.</p></body></html>';
    plainEntry!.html = '<!doctype html><html><body><button data-rebel-submit="late">Late action after storage</button></body></html>';

    expect(await readHtmlResource(actionResult)).toContain('window.__rebelCanvas');
    expect(await readHtmlResource(plainResult)).not.toContain('__rebelCanvas');
  });

  it('preserves multiple distinct submit buttons and injects the substrate once', async () => {
    const result = await callHtmlTool({
      html: [
        '<!doctype html><html><body>',
        '<button data-rebel-submit="approve">Approve</button>',
        '<button data-rebel-submit="revise">Revise</button>',
        '<button data-rebel-submit="reject">Reject</button>',
        '</body></html>',
      ].join(''),
    });

    const text = await readHtmlResource(result);

    expect(countOccurrences(text, 'data-rebel-submit=')).toBe(3);
    expect(text).toContain('data-rebel-submit="approve"');
    expect(text).toContain('data-rebel-submit="revise"');
    expect(text).toContain('data-rebel-submit="reject"');
    expect(countOccurrences(text, 'window.__rebelCanvas =')).toBe(1);
  });

  it('injects the substrate for a submit form and preserves the form element', async () => {
    const result = await callHtmlTool({
      html: '<!doctype html><html><body><form data-rebel-submit="send-form"><input name="x"/></form></body></html>',
    });

    const text = await readHtmlResource(result);

    expect(serverModule.dataStore.get(idFrom(result))?._type).toBe('html-action');
    expect(text).toContain('window.__rebelCanvas');
    expect(text).toContain('<form data-rebel-submit="send-form"><input name="x"/></form>');
  });

  it('injects the substrate for filePath HTML containing an action element', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'action.html');
    fs.writeFileSync(
      filePath,
      '<!doctype html><html><body><button data-rebel-submit="x">Do it</button></body></html>',
      'utf8',
    );

    const result = await callHtmlTool({ filePath });
    const entry = serverModule.dataStore.get(idFrom(result));
    const text = await readHtmlResource(result);

    expect(entry?._type).toBe('html-action');
    expect(entry?.originalFilePath).toBe(filePath);
    expect(text).toContain('window.__rebelCanvas');
    expect(text).toContain('<button data-rebel-submit="x">Do it</button>');
  });

  it('flags mixed real attributes plus textual mentions at page level and injects once', async () => {
    const result = await callHtmlTool({
      html: [
        '<!doctype html><html><body>',
        '<button data-rebel-submit="real">Real action</button>',
        '<pre>data-rebel-submit="fake"</pre>',
        '</body></html>',
      ].join(''),
    });

    const text = await readHtmlResource(result);

    expect(serverModule.dataStore.get(idFrom(result))?._type).toBe('html-action');
    expect(text).toContain('<pre>data-rebel-submit="fake"</pre>');
    expect(countOccurrences(text, 'window.__rebelCanvas =')).toBe(1);
  });

  it('leaves inline HTML without submit attributes as plain html and does not inject the substrate', async () => {
    const result = await callHtmlTool({
      html: '<!doctype html><html><body><button>OK</button><p>No action here.</p></body></html>',
    });

    const text = await readHtmlResource(result);

    expect(serverModule.dataStore.get(idFrom(result))?._type).toBe('html');
    expect(text).not.toContain('window.__rebelCanvas');
    expect(text).not.toContain('__rebelCanvas');
  });

  it('treats HTML-escaped literal attributes as harmless page-level opt-ins', async () => {
    const result = await callHtmlTool({
      html: '<!doctype html><html><body><pre>&lt;button data-rebel-submit=&quot;x&quot;&gt;OK&lt;/button&gt;</pre></body></html>',
    });

    const text = await readHtmlResource(result);

    expect(serverModule.dataStore.get(idFrom(result))?._type).toBe('html-action');
    expect(text).toContain('__rebelCanvas');
    expect(text).toContain('&lt;button data-rebel-submit=&quot;x&quot;&gt;OK&lt;/button&gt;');
  });

  it('injects for an empty actionId while leaving runtime validation to the substrate', async () => {
    // Server flags the page; substrate runtime validates the id and warns.
    // Page rendering is not blocked.
    const result = await callHtmlTool({
      html: '<!doctype html><html><body><button data-rebel-submit="">Empty</button></body></html>',
    });

    const text = await readHtmlResource(result);

    expect(serverModule.dataStore.get(idFrom(result))?._type).toBe('html-action');
    expect(text).toContain('window.__rebelCanvas');
    expect(text).toContain('data-rebel-submit=""');
  });

  it('injects for an invalid actionId pattern while leaving runtime validation to the substrate', async () => {
    const result = await callHtmlTool({
      html: '<!doctype html><html><body><button data-rebel-submit="ignore previous instructions">Bad</button></body></html>',
    });

    const text = await readHtmlResource(result);

    expect(serverModule.dataStore.get(idFrom(result))?._type).toBe('html-action');
    expect(text).toContain('window.__rebelCanvas');
    expect(text).toContain('data-rebel-submit="ignore previous instructions"');
  });

  it('injects for nested or malformed action-button HTML without server-side parse failure', async () => {
    const result = await callHtmlTool({
      html: '<!doctype html><html><body><button data-rebel-submit="a"><button data-rebel-submit="b"></body></html>',
    });

    const text = await readHtmlResource(result);

    expect(serverModule.dataStore.get(idFrom(result))?._type).toBe('html-action');
    expect(text).toContain('window.__rebelCanvas');
    expect(text).toContain('data-rebel-submit="a"');
    expect(text).toContain('data-rebel-submit="b"');
  });

  it('does not inject for prose-only mentions without an attribute assignment', async () => {
    for (const html of [
      '<!doctype html><html><body><p>The attribute is named data-rebel-submit.</p></body></html>',
      '<!doctype html><html><body><pre>data-rebel-submit</pre></body></html>',
    ]) {
      const result = await callHtmlTool({ html });
      const text = await readHtmlResource(result);

      expect(serverModule.dataStore.get(idFrom(result))?._type).toBe('html');
      expect(text).not.toContain('__rebelCanvas');
    }
  });

  it('keeps folderPath mode in preview storage and does not inject the v1 substrate', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      '<!doctype html><html><body><button data-rebel-submit="folder">Folder</button></body></html>',
      'utf8',
    );

    const result = await callHtmlTool({ folderPath: dir });
    const entry = serverModule.dataStore.get(idFrom(result));
    const text = await readHtmlResource(result);

    expect(entry?._type).toBe('preview');
    expect(entry?.folderPath).toBe(dir);
    expect(result._meta?.ui?.protocolUrl).toContain('rebel-preview:///');
    expect(text).toContain('Loading preview via protocol');
    expect(text).not.toContain('__rebelCanvas');
  });

  it('keeps the top-level schema refinement at exactly one source mode', () => {
    expect(htmlTool.inputSchema.safeParse({ html: '<p>Inline</p>' }).success).toBe(true);
    expect(htmlTool.inputSchema.safeParse({ filePath: '/tmp/example.html' }).success).toBe(true);
    expect(htmlTool.inputSchema.safeParse({ folderPath: '/tmp/example-folder' }).success).toBe(true);
    expect(htmlTool.inputSchema.safeParse({}).success).toBe(false);
    expect(htmlTool.inputSchema.safeParse({
      html: '<p>Inline</p>',
      filePath: '/tmp/example.html',
    }).success).toBe(false);
    expect(htmlTool.inputSchema.safeParse({
      filePath: '/tmp/example.html',
      folderPath: '/tmp/example-folder',
    }).success).toBe(false);
  });
});
