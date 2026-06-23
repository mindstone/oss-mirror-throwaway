// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

 
vi.mock('lucide-react', async () => {
  const ReactLocal = await vi.importActual<typeof import('react')>('react');
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    ReactLocal.createElement('svg', { 'data-icon': name, ...props });
  return {
    ChevronRight: createIcon('chevron-right'),
    ChevronDown: createIcon('chevron-down'),
  };
});

// Mock the CSS module so class comparisons use stable tokens.
 
vi.mock('../DocumentOutlinePanel.module.css', () => ({
  default: new Proxy({} as Record<string, string>, {
    get: (_t, k: string) => `outline-${k}`,
  }),
}));

import { DocumentOutlinePanel } from '../DocumentOutlinePanel';

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
  rerender: (ui: React.ReactElement) => void;
};

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
    rerender: (next) => {
      act(() => {
        root.render(next);
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

/**
 * Harness matching the parent-child wiring pattern used by DocumentRenderers.tsx:
 *
 *   <DocumentOutlinePanel key={documentPath ?? 'no-doc'} content={...} ... />
 *
 * Testing the child inside this harness proves the per-document remount contract
 * the C9.08 fix depends on. It intentionally does NOT test DocumentRenderers
 * directly because mounting the full parent requires fabricating a deep
 * editorResult tree that would dwarf the surface-area under test.
 */
function Harness({
  docPath,
  content,
}: {
  docPath: string | null;
  content: string;
}) {
  return (
    <DocumentOutlinePanel
      key={docPath ?? 'no-doc'}
      content={content}
      currentHeadingIndex={null}
      onSelectHeading={() => {}}
    />
  );
}

// Doc A has 4 headings: two siblings at level 1 (indices 0 and 1), with
// "Section 2" (index 1) having one subheading (index 2). Index 3 is a sibling
// of Section 2 to confirm only the right subtree is hidden.
const DOC_A = [
  '# Section 1',
  '',
  '# Section 2',
  '',
  '## Subsection 2.1',
  '',
  '# Section 3',
  '',
].join('\n');

// Doc B has 4 headings with different texts so we can prove no state leaked:
// index 1 is "Heading Beta" with descendant "Heading Gamma" (index 2).
const DOC_B = [
  '# Heading Alpha',
  '',
  '# Heading Beta',
  '',
  '## Heading Gamma',
  '',
  '# Heading Delta',
  '',
].join('\n');

describe('DocumentOutlinePanel', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('renders all headings visible by default', () => {
    mounted = mount(<Harness docPath="/docs/a.md" content={DOC_A} />);
    expect(mounted.container.textContent).toContain('Section 1');
    expect(mounted.container.textContent).toContain('Section 2');
    expect(mounted.container.textContent).toContain('Subsection 2.1');
    expect(mounted.container.textContent).toContain('Section 3');
  });

  it('toggleCollapsed hides descendants of a collapsed parent', () => {
    mounted = mount(<Harness docPath="/docs/a.md" content={DOC_A} />);

    // DOC_A: Section 1 has no children; Section 2 has one child; Section 3
    // has no children. So exactly one "Collapse section" chevron exists
    // (for Section 2).
    const chevrons = mounted.container.querySelectorAll(
      '[aria-label="Collapse section"]',
    );
    expect(chevrons.length).toBe(1);

    act(() => {
      (chevrons[0] as HTMLButtonElement).click();
    });

    // After collapsing Section 2, its descendant "Subsection 2.1" is hidden.
    // Section 2 itself is still visible, as are siblings Section 1 and 3.
    expect(mounted.container.textContent).toContain('Section 1');
    expect(mounted.container.textContent).toContain('Section 2');
    expect(mounted.container.textContent).toContain('Section 3');
    expect(mounted.container.textContent).not.toContain('Subsection 2.1');
  });

  it('CORE BUG: collapsed state is cleared on document change (different key)', () => {
    // Start with Doc A and collapse Section 2 (the only collapsible parent).
    mounted = mount(<Harness docPath="/docs/a.md" content={DOC_A} />);
    const collapseBtn = mounted.container.querySelector(
      '[aria-label="Collapse section"]',
    ) as HTMLButtonElement;
    expect(collapseBtn).not.toBeNull();
    act(() => {
      collapseBtn.click();
    });
    expect(mounted.container.textContent).not.toContain('Subsection 2.1');

    // Switch to Doc B — a different document. The `key` changes, React
    // unmounts the old instance and mounts a fresh one. The collapsed Set
    // (which contained index 1 from Doc A) must be discarded — otherwise
    // Doc B's index 1 ("Heading Beta") would silently render collapsed and
    // its descendant (Heading Gamma at index 2) would be hidden.
    mounted.rerender(<Harness docPath="/docs/b.md" content={DOC_B} />);

    // Doc B's full outline should be visible.
    expect(mounted.container.textContent).toContain('Heading Alpha');
    expect(mounted.container.textContent).toContain('Heading Beta');
    expect(mounted.container.textContent).toContain('Heading Gamma');
    expect(mounted.container.textContent).toContain('Heading Delta');

    // And the chevron for Beta should be "Collapse" (expanded), not
    // "Expand" (collapsed).
    const betaChevron = mounted.container.querySelector(
      '[aria-label="Collapse section"]',
    );
    expect(betaChevron).not.toBeNull();
  });

  it('preserves collapsed state when content is edited but documentPath is unchanged', () => {
    mounted = mount(<Harness docPath="/docs/a.md" content={DOC_A} />);

    const collapseBtn = mounted.container.querySelector(
      '[aria-label="Collapse section"]',
    ) as HTMLButtonElement;
    act(() => {
      collapseBtn.click();
    });
    expect(mounted.container.textContent).not.toContain('Subsection 2.1');

    // User edits the document — content changes, but it's still the same
    // document (same path, same key). Collapsed state should persist.
    const DOC_A_EDITED = DOC_A.replace(
      'Subsection 2.1',
      'Subsection 2.1 (edited)',
    );
    mounted.rerender(<Harness docPath="/docs/a.md" content={DOC_A_EDITED} />);

    // Section 2 is still collapsed, so the (edited) subsection is hidden.
    expect(mounted.container.textContent).not.toContain('Subsection 2.1');
  });

  it('renders empty state when content has no headings', () => {
    mounted = mount(
      <Harness docPath="/docs/empty.md" content="No headings here." />,
    );
    expect(mounted.container.textContent).toContain(
      'No headings in this document',
    );
  });
});
