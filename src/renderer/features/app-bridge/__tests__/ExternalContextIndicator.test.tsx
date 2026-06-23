/**
 * ExternalContextIndicator — presentational component tests.
 */

import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ExternalContextIndicator } from '../ExternalContextIndicator';

describe('ExternalContextIndicator', () => {
  it('returns null when queueSize is 0', () => {
    const html = renderToString(
      createElement(ExternalContextIndicator, { queueSize: 0 }),
    );
    expect(html).toBe('');
  });

  it('returns null for negative queueSize (defensive)', () => {
    const html = renderToString(
      createElement(ExternalContextIndicator, { queueSize: -1 }),
    );
    expect(html).toBe('');
  });

  it('renders singular copy for queueSize=1', () => {
    const html = renderToString(
      createElement(ExternalContextIndicator, { queueSize: 1 }),
    );
    expect(html).toContain('1 message held for you');
    expect(html).toContain('data-testid="external-context-indicator"');
  });

  it('renders plural copy for queueSize>1', () => {
    const html = renderToString(
      createElement(ExternalContextIndicator, { queueSize: 3 }),
    );
    expect(html).toContain('3 messages held for you');
  });

  it('renders preview when provided, with title attribute for overflow', () => {
    const html = renderToString(
      createElement(ExternalContextIndicator, {
        queueSize: 2,
        lastPreview: 'Check the annual plan',
      }),
    );
    expect(html).toContain('Check the annual plan');
    expect(html).toContain('title="Check the annual plan"');
  });

  it('shows hostname when provided', () => {
    const html = renderToString(
      createElement(ExternalContextIndicator, {
        queueSize: 1,
        hostname: 'docs.anthropic.com',
      }),
    );
    // React SSR inserts an HTML comment between text nodes ("from <!-- -->host").
    // Normalise before asserting.
    const normalised = html.replace(/<!--[^]*?-->/g, '');
    expect(normalised).toContain('from docs.anthropic.com');
    expect(html).toContain('data-testid="external-context-indicator-host"');
  });

  it('prefers sourceLabel for non-browser held-message sources', () => {
    const html = renderToString(
      createElement(ExternalContextIndicator, {
        queueSize: 1,
        hostname: 'docs.example.com',
        sourceLabel: 'Quarterly Plan.docx',
      }),
    );
    const normalised = html.replace(/<!--[^]*?-->/g, '');
    expect(normalised).toContain('from Quarterly Plan.docx');
    expect(normalised).not.toContain('from docs.example.com');
  });

  it('omits dismiss button when onDismiss is not provided', () => {
    const html = renderToString(
      createElement(ExternalContextIndicator, { queueSize: 1 }),
    );
    expect(html).not.toContain('data-testid="external-context-indicator-dismiss"');
  });

  it('renders dismiss button when onDismiss is provided', () => {
    const html = renderToString(
      createElement(ExternalContextIndicator, {
        queueSize: 1,
        onDismiss: () => {},
      }),
    );
    expect(html).toContain('data-testid="external-context-indicator-dismiss"');
    expect(html).toContain('aria-label="Dismiss held messages indicator"');
  });

  it('has accessible live region (role=status + aria-live=polite)', () => {
    const html = renderToString(
      createElement(ExternalContextIndicator, { queueSize: 2 }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });
});
