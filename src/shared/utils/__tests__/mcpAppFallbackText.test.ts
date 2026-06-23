import { describe, expect, it } from 'vitest';
import type { McpAppStructuredFallback, McpAppUiMeta } from '@shared/types';
import {
  formatMcpAppStructuredFallbackAsPlainText,
  formatPrimaryMcpAppFallbackAsPlainText,
} from '../mcpAppFallbackText';

describe('mcpAppFallbackText', () => {
  it('formats email-draft fallback and omits empty Cc/Bcc lines', () => {
    const fallback: McpAppStructuredFallback = {
      kind: 'email-draft',
      payload: {
        to: ['person@example.com'],
        cc: [],
        bcc: [],
        subject: 'Quarterly check-in',
        body: 'Draft body.',
      },
    };

    const text = formatMcpAppStructuredFallbackAsPlainText(fallback, {
      roleLabel: 'Editable email draft',
    });

    expect(text).toContain('[Editable email draft]');
    expect(text).toContain('To: person@example.com');
    expect(text).toContain('Subject: Quarterly check-in');
    expect(text).toContain('Draft body.');
    expect(text).not.toContain('Cc:');
    expect(text).not.toContain('Bcc:');
  });

  it('formats calendar-pick fallback', () => {
    const fallback: McpAppStructuredFallback = {
      kind: 'calendar-pick',
      payload: {
        title: 'Choose a time',
        options: [
          {
            id: 'slot-1',
            label: 'Tuesday 10:00',
            start: '2026-05-12T10:00:00Z',
            end: '2026-05-12T10:30:00Z',
            location: 'Meet',
          },
        ],
      },
    };

    expect(formatMcpAppStructuredFallbackAsPlainText(fallback)).toContain(
      '1. Tuesday 10:00 (2026-05-12T10:00:00Z - 2026-05-12T10:30:00Z · Meet)',
    );
  });

  it('formats document-outline fallback', () => {
    const fallback: McpAppStructuredFallback = {
      kind: 'document-outline',
      payload: {
        title: 'Launch memo',
        sections: [{ heading: 'Summary', bullets: ['Audience', 'Timing'] }],
      },
    };

    expect(formatMcpAppStructuredFallbackAsPlainText(fallback)).toContain([
      '[Document outline]',
      'Title: Launch memo',
      '## Summary',
      '- Audience',
      '- Timing',
    ].join('\n'));
  });

  it('formats plain fallback', () => {
    const fallback: McpAppStructuredFallback = {
      kind: 'plain',
      payload: { markdown: 'Plain fallback content.' },
    };

    expect(formatMcpAppStructuredFallbackAsPlainText(fallback)).toBe('Plain fallback content.');
  });

  it('returns viewSummary when primary metadata has no structuredFallback', () => {
    const meta: McpAppUiMeta = {
      resourceUri: 'ui://google-workspace/compose-email',
      presentation: 'primary',
      viewSummary: 'Email draft ready.',
    };

    expect(formatPrimaryMcpAppFallbackAsPlainText(meta)).toBe('Email draft ready.');
  });

  it('returns empty text when no metadata is available', () => {
    expect(formatPrimaryMcpAppFallbackAsPlainText(undefined)).toBe('');
    expect(formatPrimaryMcpAppFallbackAsPlainText({
      resourceUri: 'ui://google-workspace/compose-email',
      presentation: 'primary',
    })).toBe('');
  });
});
