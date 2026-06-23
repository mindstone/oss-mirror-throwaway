// @vitest-environment happy-dom
import React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Editor } from '@tiptap/core';
import { TipTapMarkdownEditor } from './TipTapMarkdownEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: ReactDOMClient.Root | null = null;

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

// Lifecycle contract (guards the Stage-2 init restructure, REBEL-64W/5KJ):
// onEditorReady must observe the editor with the REAL markdown already loaded —
// not the transient empty init doc. If readiness fired before the guarded
// content load, annotation/outline consumers would bind to an empty document
// and never retry (GPT stage-2 review F1).
describe('TipTapMarkdownEditor init lifecycle ordering', () => {
  it('onEditorReady sees the loaded markdown, not an empty doc', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);

    let readyMarkdown: string | null = null;
    const onReady = (editor: Editor) => { readyMarkdown = editor.getMarkdown(); };

    await act(async () => {
      root!.render(
        React.createElement(TipTapMarkdownEditor, {
          value: '# Heading\n\nSome **content** here.',
          onChange: () => {},
          onEditorReady: onReady,
        }),
      );
      // let TipTap's deferred create/mount callbacks flush
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(readyMarkdown).not.toBeNull();
    expect(readyMarkdown ?? '').toContain('# Heading');
    expect(readyMarkdown ?? '').toContain('**content**');
  });
});
