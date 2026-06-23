/**
 * BrowserContextChip — presentational component tests.
 *
 * We lean on `react-dom/server.renderToString` because
 * `@testing-library/react` is not installed in this repo. That limits
 * us to structural/output assertions, which is fine for a chip whose
 * behaviour is "render or don't".
 */

import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { BrowserContextChip } from '../BrowserContextChip';

describe('BrowserContextChip', () => {
  it('renders hostname extracted from URL', () => {
    const html = renderToString(
      createElement(BrowserContextChip, { url: 'https://stripe.com/pricing', title: 'Stripe' }),
    );
    expect(html).toContain('stripe.com');
    expect(html).toContain('From Chrome');
    expect(html).toContain('data-testid="browser-context-chip"');
  });

  it('falls back gracefully when URL is malformed (uses raw URL slice)', () => {
    const html = renderToString(
      createElement(BrowserContextChip, { url: 'not-a-url', title: 'Thing' }),
    );
    expect(html).toContain('not-a-url');
    expect(html).toContain('data-testid="browser-context-chip"');
  });

  it('returns null when nothing useful to show (no url, no title)', () => {
    const html = renderToString(createElement(BrowserContextChip, {}));
    expect(html).toBe('');
  });

  it('renders title-only when URL is missing', () => {
    const html = renderToString(createElement(BrowserContextChip, { title: 'Doc title' }));
    // No separator/hostname expected in title-only mode
    expect(html).toContain('From Chrome');
    expect(html).not.toContain('·');
  });

  it('sets accessible role + aria-label reflecting the hostname', () => {
    const html = renderToString(
      createElement(BrowserContextChip, { url: 'https://app.example.com/path' }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Browser context: app.example.com"');
  });
});
