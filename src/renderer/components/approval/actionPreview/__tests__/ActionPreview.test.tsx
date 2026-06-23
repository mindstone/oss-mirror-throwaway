// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { deriveActionPreview, type ActionPreviewModel } from '@rebel/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionPreview } from '../ActionPreview';
import { ActionPreviewDialog } from '../ActionPreviewDialog';
import { DataCapturePreview } from '../DataCapturePreview';
import { getActionPreviewBodyRenderer } from '../rendererRegistry';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  rerender: (ui: React.ReactElement) => void;
  unmount: () => void;
}

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(ui);
  });

  return {
    container,
    root,
    rerender: (nextUi) => {
      act(() => {
        root.render(nextUi);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function buildModel(overrides: Partial<ActionPreviewModel> = {}): ActionPreviewModel {
  return {
    effectKind: 'generic',
    title: 'Review action',
    contentVisibility: 'safe',
    blastRadius: {
      where: [{ label: 'Slack channel', evidence: 'explicit' }],
      whoCanSeeIt: [{ label: 'Shared workspace', evidence: 'explicit' }],
      afterwards: [{ label: 'Can edit after posting', evidence: 'derived' }],
    },
    reversibility: 'Can edit after posting',
    riskReasons: [],
    structuredArgs: [{ key: 'channel', value: '#leadership' }],
    safeRawArgs: { channel: '#leadership' },
    ...overrides,
  };
}

describe('ActionPreview', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
  });

  it('selects body renderer by effect kind', () => {
    mounted = mount(<ActionPreview model={buildModel({ effectKind: 'message' })} />);
    // Stage 4: message has a dedicated renderer (not the generic placeholder).
    expect(mounted.container.querySelector('[data-testid="message-preview"]')).not.toBeNull();

    mounted.rerender(
      <ActionPreview
        model={buildModel({
          effectKind: 'data-capture',
          structuredArgs: [
            { key: 'what will be saved', value: 'Meeting capture summary' },
            { key: 'excerpt 1', value: 'A key detail from the source capture.' },
          ],
          safeRawArgs: {
            where: 'Chief-of-Staff',
            path: '/memory/chief-of-staff/260529_1430_meeting_q3-review.md',
            sharing: 'Shared workspace',
            isNew: true,
            summary: 'Meeting capture summary',
            excerpts: ['A key detail from the source capture.'],
          },
        })}
      />,
    );
    expect(mounted.container.querySelector('[data-testid="data-capture-preview"]')).not.toBeNull();

    mounted.rerender(<ActionPreview model={buildModel({ effectKind: 'command' })} />);
    const renderer = mounted.container.querySelector('[data-testid="generic-structured-preview"]');
    expect(renderer?.getAttribute('data-renderer-key')).toBe('command');
  });

  it('falls back to generic renderer for unknown effect keys', () => {
    const Renderer = getActionPreviewBodyRenderer('future-effect');
    mounted = mount(<Renderer model={buildModel({ effectKind: 'generic' })} />);

    const renderer = mounted.container.querySelector('[data-testid="generic-structured-preview"]');
    expect(renderer?.getAttribute('data-renderer-key')).toBe('generic');
  });

  it('shows details unavailable when structured args are empty', () => {
    mounted = mount(
      <ActionPreview
        model={buildModel({
          effectKind: 'generic',
          structuredArgs: [],
          safeRawArgs: {},
        })}
      />,
    );

    expect(mounted.container.textContent).toContain('Details unavailable.');
  });

  it('keeps raw JSON inside collapsed receipts only', () => {
    mounted = mount(
      <ActionPreview
        model={buildModel({
          structuredArgs: [{ key: 'channel', value: '#leadership' }],
          safeRawArgs: {
            channel: '#leadership',
            metadata: { traceId: 'trace-123' },
          },
        })}
        toolName="slack_post_message"
      />,
    );

    expect(mounted.container.textContent).not.toContain('trace-123');

    const detailsButton = mounted.container.querySelector('[data-testid="action-preview-receipts-toggle"]');
    expect(detailsButton).not.toBeNull();

    act(() => {
      detailsButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    expect(mounted.container.textContent).toContain('trace-123');
  });

  it('renders Slack block text payloads without structural labels', () => {
    mounted = mount(
      <ActionPreview
        model={buildModel({
          effectKind: 'message',
          title: 'Send Slack message',
          blastRadius: {
            where: [{ label: '#leadership', evidence: 'explicit' }],
            whoCanSeeIt: [],
            afterwards: [{ label: 'Can edit after posting', evidence: 'derived' }],
          },
          structuredArgs: [
            {
              key: 'blocks',
              value: JSON.stringify([
                {
                  type: 'section',
                  text: { type: 'mrkdwn', text: 'Launch update' },
                },
              ]),
            },
          ],
          safeRawArgs: {
            blocks: [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: 'Launch update' },
              },
            ],
          },
        })}
      />,
    );

    const primaryBody = mounted.container.querySelector('[data-testid="action-preview-body-message"]');
    expect(mounted.container.textContent).toContain('Launch update');
    expect(mounted.container.textContent).not.toContain('"type":"section"');
    expect(primaryBody?.textContent?.toLowerCase()).not.toContain('section');
    expect(primaryBody?.textContent?.toLowerCase()).not.toContain('mrkdwn');
    expect(mounted.container.querySelector('[data-testid="message-preview-blocks-text"]')).not.toBeNull();
  });

  it('renders long Slack message body without the generic 240-char truncation', () => {
    const longBody = `Launch update: ${'A'.repeat(300)}`;
    const model = deriveActionPreview({
      kind: 'tool',
      toolName: 'post_slack_message',
      effectiveToolId: 'post_slack_message',
      packageId: 'slack',
      args: {
        channel: '#leadership',
        text: longBody,
      },
    });

    mounted = mount(<ActionPreview model={model} />);

    const body = mounted.container.querySelector('[data-testid="message-preview-text"]');
    expect(body?.textContent).toBe(longBody);
    expect(body?.textContent).not.toBe(`${longBody.slice(0, 239)}…`);
  });

  it('renders an HTML email body as parsed markup, not escaped text (REBEL-66G)', () => {
    const model = buildModel({
      effectKind: 'message',
      structuredArgs: [
        { key: 'body', value: '<p>Hi Alice,</p><ul><li>Budget</li></ul>', isHtml: true },
      ],
    });

    mounted = mount(<ActionPreview model={model} />);

    const bodyEl = mounted.container.querySelector('[data-testid="message-preview-text"]');
    // Tags must be parsed into real DOM elements, not shown verbatim as text.
    expect(bodyEl?.querySelector('ul li')?.textContent).toBe('Budget');
    expect(bodyEl?.querySelector('p')?.textContent).toBe('Hi Alice,');
    expect(bodyEl?.textContent).not.toContain('<p>');
    expect(bodyEl?.textContent).not.toContain('<li>');
  });

  it('sanitizes a malicious HTML email body (strips script + onerror) (REBEL-66G)', () => {
    const model = buildModel({
      effectKind: 'message',
      structuredArgs: [
        {
          key: 'body',
          value:
            '<p>hello</p><script>window.__pwned = true;</script>'
            + '<img src="x" onerror="window.__pwned = true">'
            + '<a href="javascript:window.__pwned=true">click</a>',
          isHtml: true,
        },
      ],
    });

    mounted = mount(<ActionPreview model={model} />);

    const bodyEl = mounted.container.querySelector('[data-testid="message-preview-text"]');
    // No script element survives sanitization.
    expect(bodyEl?.querySelector('script')).toBeNull();
    // The <img> is not on the allow-list, so it (and any onerror handler) is
    // dropped entirely — strictly safer than keeping the element minus onerror.
    expect(bodyEl?.querySelector('img')).toBeNull();
    expect(bodyEl?.innerHTML).not.toContain('onerror');
    // No javascript: URI survives sanitization.
    const anchor = bodyEl?.querySelector('a');
    expect(anchor?.getAttribute('href') ?? '').not.toContain('javascript:');
    // Benign content is preserved.
    expect(bodyEl?.querySelector('p')?.textContent).toBe('hello');
  });

  it('preserves benign email formatting (p/strong/em/ul/li/table/links) (REBEL-66G)', () => {
    const model = buildModel({
      effectKind: 'message',
      structuredArgs: [
        {
          key: 'body',
          value:
            '<p>Hi <strong>Alice</strong>, here is the <em>summary</em>:</p>'
            + '<ul><li>Budget</li><li>Timeline</li></ul>'
            + '<table><thead><tr><th>Item</th></tr></thead>'
            + '<tbody><tr><td>Q3 review</td></tr></tbody></table>'
            + '<a href="https://example.com/report" title="Report">Open report</a>'
            + '<a href="mailto:alice@example.com">Email Alice</a>',
          isHtml: true,
        },
      ],
    });

    mounted = mount(<ActionPreview model={model} />);
    const bodyEl = mounted.container.querySelector('[data-testid="message-preview-text"]');

    // Basic formatting survives.
    expect(bodyEl?.querySelector('p strong')?.textContent).toBe('Alice');
    expect(bodyEl?.querySelector('p em')?.textContent).toBe('summary');
    expect(bodyEl?.querySelectorAll('ul li').length).toBe(2);
    // Tables are common in emails — they must survive.
    expect(bodyEl?.querySelector('table thead th')?.textContent).toBe('Item');
    expect(bodyEl?.querySelector('table tbody td')?.textContent).toBe('Q3 review');
    // Safe links are preserved with their (constrained) protocol + title only.
    const links = bodyEl?.querySelectorAll('a') ?? [];
    expect(links.length).toBe(2);
    expect(links[0]?.getAttribute('href')).toBe('https://example.com/report');
    expect(links[0]?.getAttribute('title')).toBe('Report');
    expect(links[1]?.getAttribute('href')).toBe('mailto:alice@example.com');
  });

  it('blocks remote/interactive/active HTML in the approval preview (REBEL-66G)', () => {
    const model = buildModel({
      effectKind: 'message',
      structuredArgs: [
        {
          key: 'body',
          value:
            '<p>hello</p>'
            // Remote tracking pixel / network fetch.
            + '<img src="https://evil.example.com/pixel.png" id="px">'
            // srcset-based remote load.
            + '<img srcset="https://evil.example.com/a.png 1x">'
            // data: SVG image source.
            + '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">'
            // Spoofable interactive controls.
            + '<button onclick="window.__pwned=true">Allow</button>'
            + '<input type="text" value="phish">'
            // CSS-based exfiltration / UI spoofing.
            + '<style>p{display:none}</style>'
            // Active-content href.
            + '<a href="javascript:window.__pwned=true">click</a>'
            // Classic script + sibling event-handler leak.
            + '<script>window.__pwned = true;</script>'
            + '<img src="x" onerror="window.__pwned = true">',
          isHtml: true,
        },
      ],
    });

    mounted = mount(<ActionPreview model={model} />);
    const bodyEl = mounted.container.querySelector('[data-testid="message-preview-text"]');

    // No element that loads remote/data resources survives.
    expect(bodyEl?.querySelector('img')).toBeNull();
    // No element carrying a srcset attribute survives.
    expect(bodyEl?.querySelector('[srcset]')).toBeNull();
    // No spoofable interactive controls survive.
    expect(bodyEl?.querySelector('button')).toBeNull();
    expect(bodyEl?.querySelector('input')).toBeNull();
    // No <style> (CSS exfiltration / spoofing) survives.
    expect(bodyEl?.querySelector('style')).toBeNull();
    // No <script> survives.
    expect(bodyEl?.querySelector('script')).toBeNull();
    // No event-handler attribute survives anywhere.
    expect(bodyEl?.innerHTML).not.toContain('onerror');
    expect(bodyEl?.innerHTML).not.toContain('onclick');
    // No javascript: URI survives on any link.
    const anchor = bodyEl?.querySelector('a');
    expect(anchor?.getAttribute('href') ?? '').not.toContain('javascript:');
    // The render never executed any injected handler.
    expect((window as unknown as { __pwned?: boolean }).__pwned).not.toBe(true);
    // Benign text is preserved.
    expect(bodyEl?.querySelector('p')?.textContent).toBe('hello');
  });

  it('renders a plain-text email body as escaped text, not markup', () => {
    const model = buildModel({
      effectKind: 'message',
      structuredArgs: [
        { key: 'body', value: '<p>not really html</p>', isHtml: false },
      ],
    });

    mounted = mount(<ActionPreview model={model} />);

    const bodyEl = mounted.container.querySelector('[data-testid="message-preview-text"]');
    // Plain-text path: the angle brackets are shown literally, no real <p> child.
    expect(bodyEl?.querySelector('p')).toBeNull();
    expect(bodyEl?.textContent).toBe('<p>not really html</p>');
  });

  it('hides structured body values when content is withheld', () => {
    mounted = mount(
      <ActionPreview
        model={buildModel({
          contentVisibility: 'withheld',
          structuredArgs: [{ key: 'text', value: 'super secret message body' }],
          safeRawArgs: { destination: '#leadership' },
        })}
      />,
    );

    expect(mounted.container.textContent).toContain('Content hidden for privacy');
    expect(mounted.container.textContent).not.toContain('super secret message body');
  });

  it('renders revealed content section even when model visibility is withheld', () => {
    mounted = mount(
      <ActionPreview
        model={buildModel({
          contentVisibility: 'withheld',
          effectKind: 'data-capture',
          structuredArgs: [{ key: 'text', value: 'withheld model content' }],
          safeRawArgs: { text: 'withheld model content' },
        })}
        toolName="capture_tool"
        revealedContent="recovered secret text"
      />,
    );

    const revealedSection = mounted.container.querySelector('[data-testid="action-preview-revealed-content-section"]');
    expect(revealedSection).not.toBeNull();
    expect(mounted.container.querySelector('[data-testid="action-preview-revealed-content"]')?.textContent).toContain('recovered secret text');
    expect(mounted.container.textContent).not.toContain('Content hidden for privacy');

    const detailsButton = mounted.container.querySelector('[data-testid="action-preview-receipts-toggle"]');
    const receiptsSection = mounted.container.querySelector('[data-testid="action-preview-receipts"]');
    expect(detailsButton).not.toBeNull();
    expect(receiptsSection?.textContent).not.toContain('recovered secret text');
    act(() => {
      detailsButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(receiptsSection?.textContent).not.toContain('recovered secret text');
  });

  it('renders revealed content section even when model visibility is withheld', () => {
    mounted = mount(
      <ActionPreview
        model={buildModel({
          effectKind: 'data-capture',
          contentVisibility: 'withheld',
          structuredArgs: [{ key: 'text', value: 'hidden structured content' }],
          safeRawArgs: {},
        })}
        revealedContent={'Recovered secret content'}
      />,
    );

    const revealed = mounted.container.querySelector('[data-testid="action-preview-revealed-content"]');
    expect(revealed).not.toBeNull();
    expect(revealed?.textContent).toContain('Recovered secret content');
    expect(mounted.container.textContent).not.toContain('hidden structured content');
  });

  it('fails closed for unknown content visibility and hides receipts values', () => {
    mounted = mount(
      <ActionPreview
        model={buildModel({
          contentVisibility: 'unknown',
          structuredArgs: [{ key: 'text', value: 'sensitive unknown visibility payload' }],
          safeRawArgs: { text: 'sensitive unknown visibility payload' },
        })}
        toolName="slack_post_message"
      />,
    );

    expect(mounted.container.textContent).toContain('Content hidden for privacy');
    expect(mounted.container.textContent).not.toContain('sensitive unknown visibility payload');

    const detailsButton = mounted.container.querySelector('[data-testid="action-preview-receipts-toggle"]');
    expect(detailsButton).not.toBeNull();
    act(() => {
      detailsButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    expect(mounted.container.textContent).not.toContain('sensitive unknown visibility payload');
  });

  it('renders generic shell body for malformed effectKind values', () => {
    const malformedModel = {
      ...buildModel(),
      effectKind: 'mystery-effect',
    } as unknown as ActionPreviewModel;

    mounted = mount(<ActionPreview model={malformedModel} />);

    const renderer = mounted.container.querySelector('[data-testid="generic-structured-preview"]');
    expect(renderer).not.toBeNull();
    expect(renderer?.getAttribute('data-renderer-key')).toBe('generic');
  });

  it('wires dialog accessible name via DialogTitle', () => {
    mounted = mount(
      <ActionPreviewDialog
        open={true}
        onOpenChange={() => undefined}
        model={buildModel({ effectKind: 'message', title: 'Send Slack message' })}
      />,
    );

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();

    const labelledBy = dialog?.getAttribute('aria-labelledby') ?? '';
    expect(labelledBy).not.toBe('');

    const labelElement = document.getElementById(labelledBy);
    expect(labelElement?.textContent).toBe('Send Slack message');
  });

  it('uses full dialog privacy copy when content is withheld', () => {
    mounted = mount(
      <ActionPreviewDialog
        open={true}
        onOpenChange={() => undefined}
        model={buildModel({
          effectKind: 'message',
          title: 'Send Slack message',
          contentVisibility: 'withheld',
          structuredArgs: [{ key: 'text', value: 'should not render' }],
        })}
      />,
    );

    expect(document.body.textContent).toContain(
      'Content hidden for privacy. Rebel can still show where this goes and who can see it.',
    );
    expect(document.body.textContent).not.toContain('should not render');
  });

  it('shows recovery-specific error and retry test ids for withheld previews', () => {
    mounted = mount(
      <ActionPreviewDialog
        open={true}
        onOpenChange={() => undefined}
        state="error"
        errorMessage="Could not recover content."
        onRetry={() => undefined}
        model={buildModel({
          effectKind: 'data-capture',
          contentVisibility: 'withheld',
          structuredArgs: [{ key: 'text', value: 'sensitive value' }],
        })}
      />,
    );

    expect(document.body.querySelector('[data-testid="action-preview-recovery-error"]')?.textContent).toContain(
      'Could not recover content.',
    );
    expect(document.body.querySelector('[data-testid="action-preview-recovery-retry-button"]')).not.toBeNull();
  });

  it('removes decision CTAs when approval is no longer waiting', () => {
    mounted = mount(
      <ActionPreviewDialog
        open={true}
        onOpenChange={() => undefined}
        state="no-longer-waiting"
        model={buildModel({ effectKind: 'message', title: 'Send Slack message' })}
      />,
    );

    expect(document.body.querySelector('[data-testid="action-preview-discard-button"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="action-preview-allow-button"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="action-preview-cancel-button"]')?.textContent).toBe('Close');
  });

  it('makes Allow and remember the primary CTA and has no Cancel in the decision state', () => {
    mounted = mount(
      <ActionPreviewDialog
        open={true}
        onOpenChange={() => undefined}
        model={buildModel({ effectKind: 'message', title: 'Send Slack message' })}
        onAllow={() => undefined}
        onAllowAndRemember={() => undefined}
        onDiscard={() => undefined}
        showAllowAndRemember={true}
      />,
    );

    // Cancel is gone from the decision state — the header close (X) is the dismiss path.
    expect(document.body.querySelector('[data-testid="action-preview-cancel-button"]')).toBeNull();

    const allow = document.body.querySelector('[data-testid="action-preview-allow-button"]');
    const allowAndRemember = document.body.querySelector('[data-testid="action-preview-allow-and-remember-button"]');
    expect(allow).not.toBeNull();
    expect(allowAndRemember).not.toBeNull();

    // Allow and remember carries the primary accent; the one-time Allow steps back to outline.
    expect(allowAndRemember?.className).toContain('btn-default');
    expect(allow?.className).toContain('btn-outline');

    // Primary sits last (rightmost) in the footer.
    expect(
      (allow as HTMLElement).compareDocumentPosition(allowAndRemember as HTMLElement)
        & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keeps Allow as the primary CTA when there is no Allow and remember', () => {
    mounted = mount(
      <ActionPreviewDialog
        open={true}
        onOpenChange={() => undefined}
        model={buildModel({ effectKind: 'message', title: 'Send Slack message' })}
        onAllow={() => undefined}
        onDiscard={() => undefined}
        showAllowAndRemember={false}
      />,
    );

    expect(document.body.querySelector('[data-testid="action-preview-cancel-button"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="action-preview-allow-and-remember-button"]')).toBeNull();
    const allow = document.body.querySelector('[data-testid="action-preview-allow-button"]');
    expect(allow?.className).toContain('btn-default');
  });

  it('hides optional footer actions when handlers are missing', () => {
    mounted = mount(
      <ActionPreviewDialog
        open={true}
        onOpenChange={() => undefined}
        model={buildModel({ effectKind: 'message', title: 'Send Slack message' })}
        showAllowForConversation={true}
        showAllowAndRemember={true}
      />,
    );

    expect(document.body.querySelector('[data-testid="action-preview-allow-for-conversation-button"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="action-preview-allow-and-remember-button"]')).toBeNull();
  });
});

describe('DataCapturePreview', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
  });

  it('shows space and sharing, keeps excerpts collapsed until expanded', () => {
    mounted = mount(
      <DataCapturePreview
        model={buildModel({
          effectKind: 'data-capture',
          blastRadius: {
            where: [{ label: 'Chief-of-Staff', evidence: 'derived' }],
            whoCanSeeIt: [{ label: 'Shared workspace', evidence: 'explicit' }],
            afterwards: [{ label: 'Can edit after saving', evidence: 'derived' }],
          },
          structuredArgs: [
            { key: 'what will be saved', value: 'Captured summary from planning call.' },
            { key: 'excerpt 1', value: 'Customers asked for tighter onboarding analytics.' },
          ],
          safeRawArgs: {
            where: 'Chief-of-Staff',
            path: '/memory/chief-of-staff/260529_1430_meeting_q3-review.md',
            sharing: 'Shared workspace',
            isNew: true,
            summary: 'Captured summary from planning call.',
            excerpts: ['Customers asked for tighter onboarding analytics.'],
          },
        })}
      />,
    );

    expect(mounted.container.querySelector('[data-testid="data-capture-preview-space"]')?.textContent).toContain('Chief-of-Staff');
    expect(mounted.container.querySelector('[data-testid="data-capture-preview-sharing"]')?.textContent).toContain('Shared workspace');
    expect(mounted.container.querySelector('[data-testid="data-capture-preview-new-indicator"]')?.textContent).toContain('New');
    expect(mounted.container.textContent).not.toContain('Customers asked for tighter onboarding analytics.');

    const toggle = mounted.container.querySelector('[data-testid="data-capture-preview-excerpts-toggle"]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      toggle?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(mounted.container.querySelector('[data-testid="data-capture-preview-excerpts"]')).not.toBeNull();
    expect(mounted.container.textContent).toContain('Customers asked for tighter onboarding analytics.');
  });

  it('fails closed when content visibility is withheld', () => {
    mounted = mount(
      <DataCapturePreview
        model={buildModel({
          effectKind: 'data-capture',
          contentVisibility: 'withheld',
          structuredArgs: [{ key: 'what will be saved', value: 'sensitive detail that must stay hidden' }],
          safeRawArgs: {
            where: 'Chief-of-Staff',
            path: '/memory/chief-of-staff/260529_1430_meeting_q3-review.md',
            sharing: 'Company-wide',
            isNew: true,
            summary: 'sensitive detail that must stay hidden',
            excerpts: ['sensitive detail that must stay hidden'],
          },
        })}
      />,
    );

    expect(mounted.container.querySelector('[data-testid="data-capture-preview-withheld"]')?.textContent).toContain('Content hidden for privacy');
    expect(mounted.container.textContent).not.toContain('sensitive detail that must stay hidden');
  });
});
