import { describe, expect, it, vi } from 'vitest';
import {
  formatMcpAppSendMessageText,
  parseMcpAppSendMessageText,
} from '../mcpAppSendMessageAttribution';

describe('mcpAppSendMessageAttribution', () => {
  it('formats and parses attributed app messages', () => {
    const text = formatMcpAppSendMessageText({
      sourcePackageId: 'GoogleWorkspace-joshua-example-com',
      sourcePackageFamily: 'Google Workspace',
      toolUseId: 'tool-1',
      timestamp: '2026-05-10T00:00:00.000Z',
      content: 'Use this edited draft.',
    });

    expect(text).toMatch(/^\uE001APPMSG:\uE002[A-Za-z0-9+/=]+\uE003Use this edited draft\.$/u);
    expect(parseMcpAppSendMessageText(text)).toEqual({
      sourcePackageId: 'GoogleWorkspace-joshua-example-com',
      sourcePackageFamily: 'Google Workspace',
      toolUseId: 'tool-1',
      timestamp: '2026-05-10T00:00:00.000Z',
      content: 'Use this edited draft.',
    });
  });

  it('defensively strips bracket and newline characters from attribution labels', () => {
    const text = formatMcpAppSendMessageText({
      sourcePackageId: 'Tool\uE001Bad',
      sourcePackageFamily: 'Tool]\nWith Bad Label',
      toolUseId: 'tool\n1',
      timestamp: '2026-05-10T00:00:00.000Z',
      content: 'Hello',
    });

    expect(parseMcpAppSendMessageText(text)).toMatchObject({
      sourcePackageId: 'Tool Bad',
      sourcePackageFamily: 'Tool] With Bad Label',
      toolUseId: 'tool 1',
      content: 'Hello',
    });
  });

  it('returns null for ordinary user messages', () => {
    expect(parseMcpAppSendMessageText('Hello there')).toBeNull();
  });

  it('fails closed and warns when user text contains a malformed private-use marker', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(parseMcpAppSendMessageText('\uE001APPMSG: user typed something odd')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('Suspicious MCP App attribution marker ignored');

    warnSpy.mockRestore();
  });
});
