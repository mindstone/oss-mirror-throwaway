import { readFileSync } from 'node:fs';

import remarkGfm from 'remark-gfm';

import {
  DEFAULT_REMARK_PLUGINS,
  preprocessMarkdownForRender,
} from '../markdownPipeline';

describe('preprocessMarkdownForRender', () => {
  it('T-A1 returns single-space input unchanged', () => {
    const result = preprocessMarkdownForRender(' ');
    expect(result.source).toBe(' ');
  });

  it('T-A2 returns empty-string input unchanged', () => {
    const result = preprocessMarkdownForRender('');
    expect(result.source).toBe('');
  });

  it('T-A3 encodes spaces in markdown image destinations', () => {
    const result = preprocessMarkdownForRender('![alt](my image.png)');
    expect(result.source).toBe('![alt](my%20image.png)');
  });

  it('T-A4 preserves protocol URLs without double encoding', () => {
    const result = preprocessMarkdownForRender('![alt](rebel://library/foo.png)');
    expect(result.source).toBe('![alt](rebel://library/foo.png)');
  });

  it('T-A5 includes remarkGfm when additionalPlugins is undefined', () => {
    const result = preprocessMarkdownForRender('hello');
    expect(result.remarkPlugins).toContain(remarkGfm);
  });

  it('T-A6 appends additional plugins after defaults', () => {
    const pluginA = () => undefined;
    const pluginB = () => undefined;

    const result = preprocessMarkdownForRender('hello', {
      additionalPlugins: [pluginA, pluginB],
    });

    expect(result.remarkPlugins).toEqual([remarkGfm, pluginA, pluginB]);
  });

  it('T-A7 does not rewrite markdown inside fenced code blocks', () => {
    const input = '```\n[x](my file.md)\n```';
    const result = preprocessMarkdownForRender(input);
    expect(result.source).toBe(input);
  });

  it('T-A8 does not rewrite markdown inside inline code', () => {
    const input = '`[x](my file.md)`';
    const result = preprocessMarkdownForRender(input);
    expect(result.source).toBe(input);
  });

  it('T-A9 preserves quoted titles while encoding path spaces', () => {
    const result = preprocessMarkdownForRender('[doc](my file.md "Title")');
    expect(result.source).toBe('[doc](my%20file.md "Title")');
  });

  it('T-A10 returns DEFAULT_REMARK_PLUGINS by reference when extras are omitted/empty', () => {
    const omittedResult = preprocessMarkdownForRender('hello');
    const emptyResult = preprocessMarkdownForRender('hello', {
      additionalPlugins: [],
    });

    expect(omittedResult.remarkPlugins).toBe(DEFAULT_REMARK_PLUGINS);
    expect(emptyResult.remarkPlugins).toBe(DEFAULT_REMARK_PLUGINS);
  });

  it('T-A11 module stays pure with no renderer/electron/runtime globals', () => {
    const source = readFileSync(new URL('../markdownPipeline.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/from\s+['"]react['"]/);
    expect(source).not.toMatch(/from\s+['"]electron['"]/);
    expect(source).not.toMatch(/window\./);
    expect(source).not.toMatch(/from\s+['"]@core\//);
    expect(source).not.toMatch(/from\s+['"]@renderer\//);
  });
});
