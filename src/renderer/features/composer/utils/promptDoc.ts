/**
 * Lossless transforms between the markdown prompt string the agent backend already understands and
 * the ProseMirror/TipTap `JSONContent` shape rendered by `TipTapPromptEditor`.
 *
 * Only the `'command'` mention kind (mode commands like `@CHIEF_DESIGNER `, `@designContext `, etc.)
 * is recognised in Stage 1 of `docs/plans/260429_composer_rich_chips_input.md`. The other three
 * mention shapes (`` @`relative/path` ``, `@[Title](rebel://conversation/{id})`,
 * `` @model:`Profile` ``) are intentionally left as plain text in the doc until Stage 2 wires them
 * up — the textarea code path keeps handling them today.
 *
 * Contract (locked by `promptDoc.test.ts`):
 *   `docToMarkdown(markdownToDoc(prompt)) === prompt` for every `prompt` we accept.
 *   `tokenForMention(node.attrs)` is the single source of truth for mention serialisation; the
 *   `Mention` node's storage `serialize` function calls into this helper so the editor and the
 *   hydrator can never disagree on the wire format.
 *
 * The helpers do not depend on TipTap at runtime so they remain unit-testable in plain JSDOM.
 */

import type { JSONContent } from '@tiptap/core';
import { sanitiseCorruptedDraftText } from './draftSanitisation';
import type { ComposerWireMarkdown } from './composerMarkdown';

export type { ComposerWireMarkdown } from './composerMarkdown';

/**
 * Mode-command triggers exposed to users in the composer. Mirrors `SEARCH_MODES` in
 * `AgentComposer.tsx`. Order does not matter for matching because each trigger is uniquely prefixed
 * — but we keep this list narrow on purpose: any new command must be registered here so the
 * tokeniser hydrates it as a chip rather than leaving it as plain text.
 *
 * Exported for `TipTapPromptEditor`'s `normaliseCommandMentions` (Stage 3 of
 * `docs/plans/260501_composer_tiptap_atmention_bugfix.md` — H10 transactional
 * chip conversion): keystroke-time chip conversion shares the same trigger
 * list as markdown hydration, so a future trigger added here automatically
 * participates in both surfaces.
 */
export const KNOWN_COMMAND_TRIGGERS = [
  'CHIEF_DESIGNER',
  'DESIGN_SYSTEM_REVIEWER',
  'designContext',
  'skills',
  'files',
  'conversations',
] as const;

export type CommandTrigger = (typeof KNOWN_COMMAND_TRIGGERS)[number];

/**
 * Attributes carried by a TipTap `mention` node. Stage 1 only persists the `command` flavour; the
 * rest of the union is reserved for Stage 2 so the schema stays stable across stages.
 */
export type MentionAttrs =
  | {
      kind: 'command';
      label: string;
      command: CommandTrigger;
    }
  | {
      kind: 'file';
      label: string;
      relativePath: string;
      nodeKind?: 'file' | 'directory';
    }
  | {
      kind: 'conversation';
      label: string;
      conversationId: string;
      conversationTitle: string;
    }
  | {
      kind: 'model';
      label: string;
      profileName: string;
    }
  | {
      kind: 'operator';
      label: string;
      operatorSlug: string;
      operatorId?: string;
      operatorName?: string;
      missing?: boolean;
    };

export type OperatorMentionResolution =
  | {
      operatorId: string;
      operatorName: string;
      label?: string;
    }
  | null;

export interface MarkdownToDocOptions {
  resolveOperatorMention?: (operatorSlug: string) => OperatorMentionResolution;
}

/**
 * Serialise a mention node's attributes back to the canonical markdown token. This is the single
 * source of truth for the wire format — both the `Mention` node's `addStorage().markdown.serialize`
 * and the round-trip tests must call into this function so they cannot drift apart.
 */
export function tokenForMention(attrs: MentionAttrs): string {
  switch (attrs.kind) {
    case 'command':
      return `@${attrs.command} `;
    case 'file':
      return `@\`${attrs.relativePath}\``;
    case 'conversation': {
      const escapedTitle = attrs.conversationTitle
        .replace(/\\/g, '\\\\')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
        .replace(/\n/g, ' ');
      return `@[${escapedTitle}](rebel://conversation/${attrs.conversationId})`;
    }
    case 'model': {
      const sanitisedProfileName = attrs.profileName.replace(/[^\w\s.-]/g, '').trim();
      return `@model:\`${sanitisedProfileName || attrs.profileName}\``;
    }
    case 'operator':
      return `@operator:${attrs.operatorSlug}`;
  }
}

/**
 * Build the regex that matches our mode-command tokens at any caret position. The pattern requires
 * a trailing space so we don't eagerly consume an in-progress trigger (e.g. `@CHIEF_DESIGNER` with
 * no space after, mid-typing) — the suggestion plugin handles that case.
 */
const COMMAND_TRIGGER_REGEX = new RegExp(`@(${KNOWN_COMMAND_TRIGGERS.join('|')}) `);
const FILE_MENTION_REGEX = /@`([^`]+)`/;
const MODEL_MENTION_REGEX = /@model:`([^`]+)`/;
const OPERATOR_MENTION_REGEX = /@operator:([a-z0-9-]+)/;
const CONVERSATION_MENTION_REGEX = /@\[([^\]]+)\]\(rebel:\/\/conversation\/([^)]+)\)/;

interface CommandMatch {
  index: number;
  matchedToken: string;
  attrs: MentionAttrs;
}

/**
 * Find the first command-trigger token in `text`. Returns `null` if no recognised token is present.
 */
function findFirstCommandToken(text: string): CommandMatch | null {
  const match = text.match(COMMAND_TRIGGER_REGEX);
  if (!match || match.index == null) return null;
  return {
    index: match.index,
    matchedToken: match[0],
    attrs: {
      kind: 'command',
      label: `@${match[1]}`,
      command: match[1] as CommandTrigger,
    },
  };
}

function getPathDisplayName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function unescapeMarkdownLabel(label: string): string {
  return label.replace(/\\([\\[\]()])/g, '$1');
}

function findFirstMentionToken(text: string, options: MarkdownToDocOptions = {}): CommandMatch | null {
  const candidates: CommandMatch[] = [];
  const command = findFirstCommandToken(text);
  if (command) candidates.push(command);

  const file = text.match(FILE_MENTION_REGEX);
  if (file?.index != null) {
    const relativePath = file[1] ?? '';
    candidates.push({
      index: file.index,
      matchedToken: file[0],
      attrs: {
        kind: 'file',
        label: getPathDisplayName(relativePath),
        relativePath,
      },
    });
  }

  const model = text.match(MODEL_MENTION_REGEX);
  if (model?.index != null) {
    const profileName = model[1] ?? '';
    candidates.push({
      index: model.index,
      matchedToken: model[0],
      attrs: {
        kind: 'model',
        label: `@model:${profileName}`,
        profileName,
      },
    });
  }

  const operator = text.match(OPERATOR_MENTION_REGEX);
  if (operator?.index != null) {
    const operatorSlug = operator[1] ?? '';
    const resolved = options.resolveOperatorMention?.(operatorSlug) ?? null;
    candidates.push({
      index: operator.index,
      matchedToken: operator[0],
      attrs: resolved
        ? {
            kind: 'operator',
            label: resolved.label ?? resolved.operatorName,
            operatorSlug,
            operatorId: resolved.operatorId,
            operatorName: resolved.operatorName,
          }
        : {
            kind: 'operator',
            label: 'Operator not found in this Space',
            operatorSlug,
            missing: true,
          },
    });
  }

  const conversation = text.match(CONVERSATION_MENTION_REGEX);
  if (conversation?.index != null) {
    const conversationTitle = unescapeMarkdownLabel(conversation[1] ?? 'Conversation');
    const conversationId = conversation[2] ?? '';
    candidates.push({
      index: conversation.index,
      matchedToken: conversation[0],
      attrs: {
        kind: 'conversation',
        label: conversationTitle,
        conversationTitle,
        conversationId,
      },
    });
  }

  return candidates.sort((a, b) => a.index - b.index)[0] ?? null;
}

/**
 * Convert a markdown prompt line into a sequence of `text` and `mention` ProseMirror nodes.
 *
 * The line is scanned left-to-right. When a recognised command token is found (e.g.
 * `@CHIEF_DESIGNER `, including its trailing space), the text before it is emitted as a `text`
 * node, the trigger is emitted as a `mention` atom, and scanning continues from the character
 * after the trigger's trailing space — which means the trailing space is *consumed* by the chip
 * (the chip carries its own visual gap). This matches today's textarea behaviour where
 * `tokenForMention({ kind: 'command', ... })` returns `@CMD ` (with the trailing space).
 */
function tokenisePromptLineToInline(line: string, options: MarkdownToDocOptions = {}): JSONContent[] {
  const inline: JSONContent[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    const remaining = line.slice(cursor);
    const match = findFirstMentionToken(remaining, options);
    if (!match) {
      // No more command tokens — flush the rest as a text node.
      inline.push({ type: 'text', text: remaining });
      break;
    }

    if (match.index > 0) {
      inline.push({ type: 'text', text: remaining.slice(0, match.index) });
    }

    inline.push({
      type: 'mention',
      attrs: match.attrs,
    });

    cursor += match.index + match.matchedToken.length;
  }
  return inline;
}

/**
 * Hydrate a markdown prompt string into a TipTap doc. Empty lines become empty paragraphs to
 * preserve user-typed blank lines.
 *
 * C1 — single source of truth for sanitisation; pure function, no logging here.
 * The corrupted-draft sanitiser (`sanitiseCorruptedDraftText`) runs as the first
 * step so every entry path to the composer's hydration (initial mount, draft
 * load, edit-rerun message body, picker-driven `setMarkdown`, contract-test
 * fixture round-trip) cleans NBSP-family entities for free. Logging and
 * `sanitisedAt` short-circuit machinery live at the persistence boundaries
 * (Stage 6) where session metadata exists. See
 * `docs/plans/260501_composer_tiptap_atmention_bugfix.md` for the C1/C2
 * amendments.
 */
export function markdownToDoc(prompt: string, options: MarkdownToDocOptions = {}): JSONContent {
  const sanitised = sanitiseCorruptedDraftText(prompt);
  if (sanitised.length === 0) {
    return {
      type: 'doc',
      content: [{ type: 'paragraph' }],
    };
  }

  const lines = sanitised.split('\n');
  const paragraphs: JSONContent[] = lines.map((line) => {
    const inline = tokenisePromptLineToInline(line, options);
    return inline.length > 0 ? { type: 'paragraph', content: inline } : { type: 'paragraph' };
  });

  return {
    type: 'doc',
    content: paragraphs,
  };
}

/**
 * Serialise a TipTap doc back to the canonical markdown prompt. Returns the
 * `ComposerWireMarkdown` brand — the string went through the schema-aware
 * walker that mirrors the override-enabled `editor.getMarkdown()` wire format.
 *
 * Stage 1 implementation walks the doc directly to keep the round-trip surface
 * small; the keystroke hot path uses `editor.getMarkdown()` (with the overrides
 * from `composerEditorFactory.ts` active) wrapped by `getCurrentPromptMarkdown`.
 */
export function docToMarkdown(doc: JSONContent): ComposerWireMarkdown {
  // eslint-disable-next-line no-restricted-syntax -- sanctioned brand producer: docToMarkdown serialises a sanitised TipTap doc; see composerMarkdown.ts for brand contract.
  if (!doc.content) return '' as ComposerWireMarkdown;
  // eslint-disable-next-line no-restricted-syntax -- sanctioned brand producer: docToMarkdown serialises a sanitised TipTap doc; see composerMarkdown.ts for brand contract.
  return doc.content
    .map((paragraph) => paragraphToMarkdown(paragraph))
    .join('\n') as ComposerWireMarkdown;
}

function paragraphToMarkdown(node: JSONContent): string {
  if (!node.content) return '';
  return node.content
    .map((inline) => {
      if (inline.type === 'text') return inline.text ?? '';
      if (inline.type === 'mention' && inline.attrs) {
        return tokenForMention(inline.attrs as MentionAttrs);
      }
      if (inline.type === 'hardBreak') return '\n';
      return '';
    })
    .join('');
}

/**
 * Convert a ProseMirror absolute position to the equivalent character index in the markdown prompt
 * string returned by `docToMarkdown`. Used to bridge the suggestion plugin (which reports PM
 * positions) and `useMentionAutocomplete.findMentionTrigger` (which expects a string + caret).
 *
 * ProseMirror position model:
 *  - position 0 sits before the first child of the doc
 *  - each non-leaf node contributes +1 for its open boundary and +1 for its close boundary
 *  - each text character contributes +1
 *  - each atom (leaf) node contributes +1
 *
 * Atom mention nodes count as the length of their serialised token in the markdown index, so the
 * caret position the picker sees lines up with what the user perceives as a single chip.
 */
export function pmPosToMarkdownIndex(doc: JSONContent, pmPos: number): number {
  let pmCursor = 0;
  let mdCursor = 0;

  if (pmCursor === pmPos) return mdCursor;

  const paragraphs = doc.content ?? [];
  for (let i = 0; i < paragraphs.length; i += 1) {
    if (i > 0) {
      mdCursor += 1;
    }

    // Open-paragraph boundary.
    pmCursor += 1;
    if (pmCursor === pmPos) return mdCursor;

    const paragraph = paragraphs[i];
    const inlines = paragraph?.content ?? [];
    for (const inline of inlines) {
      if (inline.type === 'text') {
        const text = inline.text ?? '';
        for (let c = 0; c < text.length; c += 1) {
          pmCursor += 1;
          mdCursor += 1;
          if (pmCursor === pmPos) return mdCursor;
        }
      } else if (inline.type === 'mention' && inline.attrs) {
        const token = tokenForMention(inline.attrs as MentionAttrs);
        pmCursor += 1;
        mdCursor += token.length;
        if (pmCursor === pmPos) return mdCursor;
      } else if (inline.type === 'hardBreak') {
        pmCursor += 1;
        mdCursor += 1;
        if (pmCursor === pmPos) return mdCursor;
      }
    }

    // Close-paragraph boundary.
    pmCursor += 1;
    if (pmCursor === pmPos) return mdCursor;
  }

  return mdCursor;
}

/**
 * Inverse of `pmPosToMarkdownIndex`: convert a markdown character offset into a ProseMirror
 * position. This is intentionally small and schema-aware for Stage 1: `paragraph`, `text`,
 * `mention`, and `hardBreak` only. Unknown inline nodes are skipped rather than guessed because
 * silently inventing offsets would corrupt mention range replacement.
 *
 * When a markdown index falls inside a mention token's serialised text, the function returns the
 * closest atom boundary: before the chip for offsets in the first half, after the chip for offsets
 * in the second half. Stage 1 uses this for replacing active typed `@...` trigger ranges; those
 * ranges are plain text before replacement, so the atom-boundary fallback is only a safety net.
 */
export function markdownIndexToPmPos(doc: JSONContent, markdownIndex: number): number {
  const target = Math.max(0, markdownIndex);
  let pmCursor = 0;
  let mdCursor = 0;

  if (target === 0) return 1; // inside the first paragraph, before its first inline child

  const paragraphs = doc.content ?? [];
  for (let i = 0; i < paragraphs.length; i += 1) {
    if (i > 0) {
      if (mdCursor === target) return pmCursor;
      mdCursor += 1;
    }

    pmCursor += 1; // open paragraph
    const paragraph = paragraphs[i];
    const inlines = paragraph?.content ?? [];

    for (const inline of inlines) {
      if (inline.type === 'text') {
        const text = inline.text ?? '';
        for (let c = 0; c < text.length; c += 1) {
          if (mdCursor === target) return pmCursor;
          pmCursor += 1;
          mdCursor += 1;
        }
      } else if (inline.type === 'mention' && inline.attrs) {
        const token = tokenForMention(inline.attrs as MentionAttrs);
        if (mdCursor === target) return pmCursor;
        if (target > mdCursor && target < mdCursor + token.length) {
          const midpoint = mdCursor + token.length / 2;
          return target < midpoint ? pmCursor : pmCursor + 1;
        }
        pmCursor += 1;
        mdCursor += token.length;
      } else if (inline.type === 'hardBreak') {
        if (mdCursor === target) return pmCursor;
        pmCursor += 1;
        mdCursor += 1;
      }
    }

    if (mdCursor === target) return pmCursor;
    pmCursor += 1; // close paragraph
  }

  return pmCursor;
}
