// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsNewDialog } from '../WhatsNewDialog';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@renderer/src/tracking', () => ({
  tracking: {
    whatsNew: {
      closed: vi.fn(),
      featureClicked: vi.fn(),
    },
  },
}));

type Mounted = {
  container: HTMLDivElement;
  unmount: () => void;
};

const originalMiscApi = window.miscApi;

function setChangelog(markdown: string): void {
  (window as unknown as {
    miscApi: { getChangelog: () => Promise<{ success: true; content: string }> };
  }).miscApi = {
    getChangelog: vi.fn(async () => ({ success: true as const, content: markdown })),
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountDialog(markdown: string): Promise<Mounted> {
  setChangelog(markdown);

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(
      <WhatsNewDialog
        open
        onOpenChange={() => undefined}
        currentVersion="1.0.0"
      />,
    );
  });
  await flushEffects();

  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function findAnchorByText(text: string): HTMLAnchorElement {
  const anchor = Array.from(document.body.querySelectorAll('a')).find(
    (candidate) => candidate.textContent === text,
  );
  if (!anchor) {
    throw new Error(`Expected anchor with text "${text}"`);
  }
  return anchor;
}

describe('WhatsNewDialog markdown links', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();

    if (originalMiscApi) {
      window.miscApi = originalMiscApi;
    } else {
      Reflect.deleteProperty(window, 'miscApi');
    }
  });

  it('renders ordinary https links with the same href', async () => {
    mounted = await mountDialog(`
## v1.0.0 - Today

### Highlights
- **Link handling** - Read the [release notes](https://example.com/releases/v1) with **bold** and \`code\`.
`);

    const link = findAnchorByText('release notes');
    expect(link.getAttribute('href')).toBe('https://example.com/releases/v1');
    expect(link.textContent).toBe('release notes');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('neutralizes javascript and file links without a dangerous href', async () => {
    mounted = await mountDialog(`
## v1.0.0 - Today

### Highlights
- **Blocked links** - Ignore [script](javascript:alert(1)) and [file](file:///etc/passwd).
`);

    const scriptLink = findAnchorByText('script');
    const fileLink = findAnchorByText('file');

    expect(scriptLink.hasAttribute('href')).toBe(false);
    expect(fileLink.hasAttribute('href')).toBe(false);
    expect(document.body.innerHTML).not.toMatch(/href="javascript:/i);
    expect(document.body.innerHTML).not.toMatch(/href="file:/i);
  });
});
