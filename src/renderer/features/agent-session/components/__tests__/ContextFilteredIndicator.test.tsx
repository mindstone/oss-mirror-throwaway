import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContextFilteredIndicator } from '../ContextFilteredIndicator';

function stripReactComments(html: string): string {
  return html
    .replace(/<!--[^]*?-->/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

describe('ContextFilteredIndicator', () => {
  it('renders nothing when filteredCount is 0', () => {
    const html = renderToStaticMarkup(
      <ContextFilteredIndicator filteredCount={0} mode="ownerOnly" />,
    );

    expect(html).toBe('');
  });

  it('renders nothing when mode is legacyPermissive', () => {
    const html = renderToStaticMarkup(
      <ContextFilteredIndicator filteredCount={3} mode="legacyPermissive" />,
    );

    expect(html).toBe('');
  });

  it('renders singular copy and settings deep link for count=1', () => {
    const html = stripReactComments(renderToStaticMarkup(
      <ContextFilteredIndicator filteredCount={1} mode="ownerOnly" />,
    ));

    expect(html).toContain("Context filtered — 1 message was ignored because that sender isn't allowed to message Rebel.");
    expect(html).toContain('Review recent message attempts');
    expect(html).toContain('href="rebel://settings/?tab=cloud&section=recent-message-attempts"');
    expect(html).toContain('data-testid="context-filtered-indicator-link"');
  });

  it('renders plural copy for count > 1', () => {
    const html = stripReactComments(renderToStaticMarkup(
      <ContextFilteredIndicator filteredCount={4} mode="allowlist" />,
    ));

    expect(html).toContain("Context filtered — 4 messages were ignored because those senders aren't allowed to message Rebel.");
    expect(html).toContain('data-testid="context-filtered-indicator"');
  });
});
