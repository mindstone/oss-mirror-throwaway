/**
 * TipTap `mention` node — atomic, inline, rendered as a `ComposerContextChip`.
 *
 * One node type covers all five mention flavours we serialise to markdown (command, file,
 * conversation, model, operator). The flavour is discriminated by `attrs.kind`. Stage 1 of
 * `docs/plans/260429_composer_rich_chips_input.md` only inserts the `command` flavour through the
 * suggestion adapter; the other three are reserved attribute shapes so the schema stays stable
 * across stages.
 *
 * Wire-format contract: the node's `addStorage().markdown.serialize` calls into
 * `tokenForMention()` from `promptDoc.ts`, which is the single source of truth for how a chip
 * round-trips back to markdown. The hydrator in `markdownToDoc()` and the editor in this file MUST
 * stay in lock-step on token shapes; the shared helper guarantees that.
 */

import type { JSONContent, NodeViewProps } from '@tiptap/core';
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { ComposerContextChip, type ComposerContextChipKind } from './ComposerContextChip';
import { tokenForMention, type MentionAttrs } from '../utils/promptDoc';

const NODE_NAME = 'mention' as const;

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    [NODE_NAME]: {
      insertMention: (attrs: MentionAttrs) => ReturnType;
    };
  }
}

function chipKindForMention(attrs: MentionAttrs): ComposerContextChipKind {
  switch (attrs.kind) {
    case 'command':
      return 'mode';
    case 'file':
      return attrs.nodeKind === 'directory' ? 'directory' : 'file';
    case 'conversation':
      return 'conversation';
    case 'model':
      return 'mode';
    case 'operator':
      return 'mode';
  }
}

function MentionChipView({ node, getPos, editor, deleteNode }: NodeViewProps) {
  const attrs = node.attrs as MentionAttrs;
  const kind = chipKindForMention(attrs);
  const handleRemove = () => {
    if (typeof getPos === 'function') {
      const pos = getPos();
      if (typeof pos === 'number') {
        editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
        return;
      }
    }
    deleteNode();
  };

  return (
    <NodeViewWrapper as="span" data-mention-kind={attrs.kind}>
      <ComposerContextChip
        label={attrs.label}
        kind={kind}
        title={attrs.kind === 'operator' && attrs.missing ? 'This Operator is no longer available' : undefined}
        onRemove={handleRemove}
      />
    </NodeViewWrapper>
  );
}

export const MentionNode = Node.create({
  name: NODE_NAME,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      kind: {
        default: 'command',
        parseHTML: (element) => element.getAttribute('data-mention-kind') ?? 'command',
        renderHTML: (attrs) => ({ 'data-mention-kind': attrs.kind }),
      },
      label: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-mention-label') ?? '',
        renderHTML: (attrs) => ({ 'data-mention-label': attrs.label }),
      },
      command: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-mention-command'),
        renderHTML: (attrs) => (attrs.command ? { 'data-mention-command': attrs.command } : {}),
      },
      relativePath: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-mention-relative-path'),
        renderHTML: (attrs) =>
          attrs.relativePath ? { 'data-mention-relative-path': attrs.relativePath } : {},
      },
      conversationId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-mention-conversation-id'),
        renderHTML: (attrs) =>
          attrs.conversationId ? { 'data-mention-conversation-id': attrs.conversationId } : {},
      },
      conversationTitle: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-mention-conversation-title'),
        renderHTML: (attrs) =>
          attrs.conversationTitle
            ? { 'data-mention-conversation-title': attrs.conversationTitle }
            : {},
      },
      profileName: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-mention-profile-name'),
        renderHTML: (attrs) =>
          attrs.profileName ? { 'data-mention-profile-name': attrs.profileName } : {},
      },
      operatorSlug: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-mention-operator-slug'),
        renderHTML: (attrs) =>
          attrs.operatorSlug ? { 'data-mention-operator-slug': attrs.operatorSlug } : {},
      },
      operatorId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-mention-operator-id'),
        renderHTML: (attrs) =>
          attrs.operatorId ? { 'data-mention-operator-id': attrs.operatorId } : {},
      },
      operatorName: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-mention-operator-name'),
        renderHTML: (attrs) =>
          attrs.operatorName ? { 'data-mention-operator-name': attrs.operatorName } : {},
      },
      missing: {
        default: false,
        parseHTML: (element) => element.getAttribute('data-mention-missing') === 'true',
        renderHTML: (attrs) =>
          attrs.missing ? { 'data-mention-missing': 'true' } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: `span[data-mention-kind]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionChipView, {
      // The chip body is inert text-wise — typing/cursor interactions go through the editor on the
      // surrounding paragraph, not the node view. Setting `as: 'span'` lets the node sit on the
      // same baseline as the surrounding text without breaking the inline flow.
      as: 'span',
      contentDOMElementTag: undefined,
    });
  },

  /**
   * `@tiptap/markdown` discovers serialisers by reading `renderMarkdown` directly off the
   * extension. The function returns the canonical wire token via the shared `tokenForMention()`
   * helper, which is also used by `markdownToDoc()` so hydration and serialisation cannot drift.
   *
   * We deliberately do NOT define `parseMarkdown` / `markdownTokenizer` here. Hydration of saved
   * prompts goes through `markdownToDoc()` (in `promptDoc.ts`), not the marked-based parser, since
   * mentions are unstructured text from marked's perspective. Leaving the parser fields unset
   * means `editor.getJSON()` is the only authoritative source of mention state.
   */
  renderMarkdown(node: JSONContent): string {
    return tokenForMention(node.attrs as MentionAttrs);
  },

  addCommands() {
    return {
      insertMention:
        (attrs: MentionAttrs) =>
        ({ chain }) =>
          chain()
            .insertContent({ type: NODE_NAME, attrs })
            .run(),
    };
  },
});
