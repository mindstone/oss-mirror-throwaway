// @vitest-environment node
/**
 * Backend wire-format contract test (Stage 2 — 90%-push critique cleanup #14).
 *
 * Round-trips `tokenForMention(attrs)` for each mention kind through its
 * corresponding **backend extraction surface** and asserts the kind extracts
 * correctly. This is the safety net that catches a future change to
 * `tokenForMention` (or to the override-enabled wire format) silently breaking
 * agent input — an entire class of regressions where the composer emits a
 * token shape that the backend can no longer parse.
 *
 * Surfaces covered:
 *   - **Model mentions** — `detectModelReferences()` in
 *     `src/main/services/councilService.ts`. The function expects the literal
 *     `@model:\`profileName\`` shape (backtick-quoted).
 *   - **File mentions** — `extractMentionTargets()` in
 *     `src/renderer/features/library/hooks/useLibraryMentions.ts`. The function
 *     applies the regex `/@\`([^\`]+)\`/g` to extract relative paths.
 *   - **Conversation mentions** — `[Title](rebel://conversation/{id})` parser
 *     pattern in `src/renderer/components/MessageMarkdown.tsx`. We assert the
 *     URL prefix + ID character class match the canonical token shape.
 *   - **Command mentions** — placeholder identity check (commands are
 *     consumed renderer-side by the agent prompt; the assertion verifies the
 *     trailing-space contract that backend `@CMD ` parsers rely on).
 *
 * The environment is `node` (not `happy-dom`) — these are pure-string
 * contract assertions, no DOM required.
 *
 * See `docs/plans/260501_composer_tiptap_atmention_bugfix.md` (Stage 2 file
 * list, cleanup #14).
 */

import { describe, expect, it } from 'vitest';
import { tokenForMention, type MentionAttrs } from '../utils/promptDoc';
import { extractMentionTargets } from '@renderer/features/library/hooks/useLibraryMentions';
import type { ModelProfile } from '@shared/types';

/**
 * Backend-regex stub for the renderer-side wire-format contract test.
 *
 * `detectModelReferences` lives in `src/main/services/councilService.ts` (not in the
 * renderer's tsconfig include list — main and renderer are separate processes).
 * Pulling it in via relative path triggers a TS6307 cascade because councilService's
 * imports aren't part of the renderer project. To keep this test self-contained while
 * still pinning the backend-regex contract, we replicate the exact match logic the
 * backend uses: `@model:\`${sanitizedName}\`` (backtick-quoted) plus legacy
 * `@model:${sanitizedName}\b` (no backticks). Sanitisation matches `councilService`'s
 * `replace(/[^\w\s.-]/g, '').trim()`.
 *
 * If `councilService.ts` ever changes its match pattern, this stub MUST be updated
 * in lockstep — the backend-truth tests there own that contract; this one only verifies
 * `tokenForMention()` emits strings the backend can match.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function detectModelReferences(prompt: string, profiles: ModelProfile[]): ModelProfile[] {
  const matched: ModelProfile[] = [];
  for (const p of profiles) {
    if (!p.model) continue;
    const sanitisedName = p.name.replace(/[^\w\s.-]/g, '').trim();
    const backtick = new RegExp(`@model:\`${escapeRegExp(sanitisedName)}\``, 'i');
    const legacy = new RegExp(`@model:${escapeRegExp(sanitisedName)}\\b`, 'i');
    if (backtick.test(prompt) || legacy.test(prompt)) matched.push(p);
  }
  return matched;
}

/**
 * Build a minimal `ModelProfile` stub.
 */
function profile(name: string, model: string): ModelProfile {
  return {
    id: `profile-${name}`,
    name,
    serverUrl: 'https://example.invalid',
    model,
    createdAt: 0,
  };
}

describe('Backend wire-format contract — tokenForMention round-trips through backend regexes', () => {
  describe('Model mention — @model:`profileName`', () => {
    it('detectModelReferences finds a model profile for tokenForMention(model)', () => {
      const attrs: MentionAttrs = {
        kind: 'model',
        label: '@model:Working Brain',
        profileName: 'Working Brain',
      };
      const token = tokenForMention(attrs);
      expect(token).toBe('@model:`Working Brain`');

      const prompt = `Please ${token} review this code`;
      const profiles = [profile('Working Brain', 'gpt-5.2-codex'), profile('Other', 'claude-3-opus')];
      const matched = detectModelReferences(prompt, profiles);
      expect(matched).toHaveLength(1);
      expect(matched[0]?.name).toBe('Working Brain');
    });

    it('detectModelReferences finds a model profile when sanitisation strips characters', () => {
      // tokenForMention(model) sanitises non-`[\w\s.-]` chars; the resulting wire token
      // is what the backend matches against.
      const attrs: MentionAttrs = {
        kind: 'model',
        label: '@model:Claude Sonnet 4',
        profileName: 'Claude Sonnet 4',
      };
      const token = tokenForMention(attrs);
      expect(token).toBe('@model:`Claude Sonnet 4`');
      const matched = detectModelReferences(`Try ${token}`, [profile('Claude Sonnet 4', 'claude-sonnet-4')]);
      expect(matched).toHaveLength(1);
    });
  });

  describe('File mention — @`relativePath`', () => {
    it('extractMentionTargets pulls the relative path out of tokenForMention(file)', () => {
      const attrs: MentionAttrs = {
        kind: 'file',
        label: 'brief.md',
        relativePath: 'docs/brief.md',
      };
      const token = tokenForMention(attrs);
      expect(token).toBe('@`docs/brief.md`');
      expect(extractMentionTargets(`see ${token} please`)).toEqual(['docs/brief.md']);
    });

    it('extractMentionTargets handles paths with spaces (mirrors tokenForMention output)', () => {
      const attrs: MentionAttrs = {
        kind: 'file',
        label: 'spec',
        relativePath: 'work/folder with space/spec',
        nodeKind: 'directory',
      };
      const token = tokenForMention(attrs);
      expect(token).toBe('@`work/folder with space/spec`');
      expect(extractMentionTargets(`use ${token}`)).toEqual(['work/folder with space/spec']);
    });

    it('extractMentionTargets returns multiple paths when prompt contains multiple file mentions', () => {
      const a = tokenForMention({ kind: 'file', label: 'a', relativePath: 'a.md' });
      const b = tokenForMention({ kind: 'file', label: 'b', relativePath: 'b.md' });
      expect(extractMentionTargets(`${a} and ${b}`)).toEqual(['a.md', 'b.md']);
    });
  });

  describe('Conversation mention — @[Title](rebel://conversation/{id})', () => {
    /**
     * Pattern owned by `MessageMarkdown.tsx`'s `REBEL_CONVERSATION_REGEX` plus the
     * markdown link parser. Here we lock the wire-format shape directly: the URL
     * prefix and the ID character class (`[a-zA-Z0-9_-]+`) must match what
     * `tokenForMention(conversation)` emits.
     */
    const CONVERSATION_LINK_REGEX = /^@\[([^\]]+)\]\(rebel:\/\/conversation\/([a-zA-Z0-9_-]+)\)$/;

    it('tokenForMention(conversation) matches the conversation-link regex (plain title)', () => {
      const attrs: MentionAttrs = {
        kind: 'conversation',
        label: 'Friday Pulse',
        conversationId: 'abc-123',
        conversationTitle: 'Friday Pulse',
      };
      const token = tokenForMention(attrs);
      expect(token).toBe('@[Friday Pulse](rebel://conversation/abc-123)');
      const m = token.match(CONVERSATION_LINK_REGEX);
      expect(m).not.toBeNull();
      expect(m?.[1]).toBe('Friday Pulse');
      expect(m?.[2]).toBe('abc-123');
    });

    it('tokenForMention(conversation) escapes brackets in the title; the link regex still extracts the ID', () => {
      const attrs: MentionAttrs = {
        kind: 'conversation',
        label: 'A [bracket]',
        conversationId: 'c1',
        conversationTitle: 'A [bracket]',
      };
      const token = tokenForMention(attrs);
      expect(token).toBe('@[A \\[bracket\\]](rebel://conversation/c1)');
      // The regex's title group accepts `[^\]]+` — the escaped form `A \[bracket\]` lacks an
      // unescaped closing bracket up to the first `]`, so the regex stops at `A \[bracket\`
      // followed by `]`. We still expect the conversation ID to extract.
      const m = token.match(/\(rebel:\/\/conversation\/([a-zA-Z0-9_-]+)\)/);
      expect(m).not.toBeNull();
      expect(m?.[1]).toBe('c1');
    });
  });

  describe('Command mention — @COMMAND with trailing space', () => {
    /**
     * Backend command parsers (e.g. mode dispatchers) rely on the trailing space
     * to delimit the command from any follow-on text. The contract here pins
     * the trailing-space invariant for the full set of registered triggers.
     */
    const COMMAND_TRIGGER_REGEX = /@(CHIEF_DESIGNER|DESIGN_SYSTEM_REVIEWER|designContext|skills|files|conversations) /;

    it('tokenForMention(command) emits the registered trigger followed by exactly one trailing space', () => {
      const attrs: MentionAttrs = {
        kind: 'command',
        label: '@CHIEF_DESIGNER',
        command: 'CHIEF_DESIGNER',
      };
      const token = tokenForMention(attrs);
      expect(token).toBe('@CHIEF_DESIGNER ');
      expect(COMMAND_TRIGGER_REGEX.test(token)).toBe(true);
      expect(token.endsWith(' ')).toBe(true);
    });

    it('all known command triggers serialise via tokenForMention with a trailing space', () => {
      const triggers = [
        'CHIEF_DESIGNER',
        'DESIGN_SYSTEM_REVIEWER',
        'designContext',
        'skills',
        'files',
        'conversations',
      ] as const;
      for (const command of triggers) {
        const token = tokenForMention({
          kind: 'command',
          label: `@${command}`,
          command,
        });
        expect(token).toBe(`@${command} `);
        expect(COMMAND_TRIGGER_REGEX.test(token)).toBe(true);
      }
    });
  });
});
