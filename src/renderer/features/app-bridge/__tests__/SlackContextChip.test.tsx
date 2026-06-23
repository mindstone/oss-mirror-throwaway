import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SlackContextChip } from '../SlackContextChip';

function normalise(html: string): string {
  return html.replace(/<!--[^]*?-->/g, '');
}

describe('SlackContextChip', () => {
  it('renders full metadata with a Slack permalink', () => {
    const html = renderToStaticMarkup(
      <SlackContextChip
        userName="Alice"
        channelName="planning"
        teamName="Acme"
        permalink="https://acme.slack.com/archives/C1/p1700000000123456"
      />,
    );
    const text = normalise(html);

    expect(text).toContain('Alice in #planning');
    expect(text).toContain('Acme');
    expect(text).toContain('View in Slack');
    expect(html).toContain('href="https://acme.slack.com/archives/C1/p1700000000123456"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('aria-label="View this Slack message in Slack"');
    expect(html).not.toContain('role="status"');
  });

  it('falls back calmly when the user is missing', () => {
    const html = normalise(renderToStaticMarkup(
      <SlackContextChip channelName="planning" teamName="Acme" />,
    ));

    expect(html).toContain('Unknown user in #planning');
    expect(html).toContain('Acme');
  });

  it('falls back calmly when the channel is missing', () => {
    const html = normalise(renderToStaticMarkup(
      <SlackContextChip userName="Alice" teamName="Acme" />,
    ));

    expect(html).toContain('Alice in (channel unavailable)');
  });

  it('renders a generic Slack message label when all metadata is missing', () => {
    const html = normalise(renderToStaticMarkup(<SlackContextChip />));

    expect(html).toContain('Slack message');
    expect(html).toContain('data-testid="slack-context-chip"');
  });

  it('does not render a link when permalink is missing', () => {
    const html = renderToStaticMarkup(
      <SlackContextChip userName="Alice" channelName="planning" teamName="Acme" />,
    );

    expect(html).not.toContain('data-testid="slack-context-chip-link"');
    expect(html).not.toContain('href=');
  });

  it('does not render a link when permalink is not https', () => {
    const html = normalise(renderToStaticMarkup(
      <SlackContextChip
        userName="Alice"
        channelName="planning"
        teamName="Acme"
        permalink="javascript:alert(1)"
      />,
    ));

    expect(html).toContain('Alice in #planning');
    expect(html).not.toContain('data-testid="slack-context-chip-link"');
    expect(html).not.toContain('href=');
  });

  it('uses userDisplayName when userName is absent', () => {
    const html = normalise(renderToStaticMarkup(
      <SlackContextChip userDisplayName="Display Alice" channelName="planning" />,
    ));

    expect(html).toContain('Display Alice in #planning');
  });

});
