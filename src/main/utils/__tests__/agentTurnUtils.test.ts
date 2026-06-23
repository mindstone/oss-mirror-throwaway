import { describe, it, expect } from 'vitest';
import {
  appendAttachmentsToPrompt,
  attachSkillMetadataToTextAttachments,
  buildResponseShapeContractForPrompt,
  buildUserMessageContext,
  collectSkillModelRecommendations,
  computeEffectiveEffort,
  createUserMessageGenerator,
  extractImageContentFromToolResult,
  isApiOutputMessage,
  isSkillAttachmentPath,
  resolveSkillModelRecommendations,
} from '../agentTurnUtils';
import type { AgentAttachmentPayload, ImageAttachmentPayload, DocumentAttachmentPayload, ThinkingEffort } from '@shared/types';
import type { ModelProfile } from '@shared/types/settings';

type SkillEffort = 'low' | 'medium' | 'high' | 'max';

interface CharacterizedTurnEffortInputs {
  shellEnv?: string;
  sessionEffort?: ThinkingEffort;
  modelId?: string;
  modelEfforts?: Partial<Record<string, ThinkingEffort>>;
  globalEffort?: ThinkingEffort;
  profileEffort?: string;
  skillEfforts?: SkillEffort[];
}

const parseCharacterizedShellEffort = (value: string | undefined): ThinkingEffort | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh'
    ? normalized
    : undefined;
};

const characterizeCurrentAgentTurnEffort = ({
  shellEnv,
  sessionEffort,
  modelId = 'claude-sonnet-4-6',
  modelEfforts,
  globalEffort,
  profileEffort,
  skillEfforts = [],
}: CharacterizedTurnEffortInputs): ThinkingEffort => {
  // CHARACTERIZATION: mirrors the pre-A4a agentTurnExecute.ts precedence exactly:
  // shell env > session override > profile override > max(per-model/global/default, skill floor).
  const perModelEffort = modelEfforts?.[modelId] ?? globalEffort ?? 'high';
  return parseCharacterizedShellEffort(shellEnv)
    ?? sessionEffort
    ?? computeEffectiveEffort(perModelEffort, profileEffort, skillEfforts)
    ?? perModelEffort;
};

describe('buildUserMessageContext', () => {
  it('returns bare user message when no sections are provided', () => {
    const result = buildUserMessageContext({}, 'Hello world');
    expect(result).toBe('Hello world');
  });

  it('returns bare user message when all sections are undefined', () => {
    const result = buildUserMessageContext({
      meetingContext: undefined,
      relevantConversations: undefined,
      suggestedTools: undefined,
      designContext: undefined,
      ourComponents: undefined,
      relevantFiles: undefined,
    }, 'Just a question');
    expect(result).toBe('Just a question');
  });

  it('returns bare user message when all sections are empty strings', () => {
    const result = buildUserMessageContext({
      meetingContext: '',
      relevantConversations: '',
      suggestedTools: '',
      designContext: '',
      ourComponents: '',
      relevantFiles: '',
    }, 'Plain message');
    expect(result).toBe('Plain message');
  });

  it('wraps a single section with XML tags and adds <user-request>', () => {
    const result = buildUserMessageContext(
      { relevantFiles: 'File content here' },
      'What does this file do?',
    );
    expect(result).toBe(
      '<relevant-files>\nFile content here\n</relevant-files>\n\n<user-request>\nWhat does this file do?\n</user-request>',
    );
  });

  it('renders all sections in correct order', () => {
    const result = buildUserMessageContext(
      {
        meetingContext: 'Meeting info',
        relevantConversations: 'Past conversations',
        suggestedTools: 'Tool suggestions',
        designContext: 'Persona and journey context',
        ourComponents: 'Component system guidance',
        relevantFiles: 'File snippets',
        responseShapeContract: 'Answer briefly',
      },
      'Help me with this',
    );

    const expectedOrder = [
      '<meeting-context>',
      'Meeting info',
      '</meeting-context>',
      '',
      '<relevant-conversations>',
      'Past conversations',
      '</relevant-conversations>',
      '',
      '<suggested-tools>',
      'Tool suggestions',
      '</suggested-tools>',
      '',
      '<design-context>',
      'Persona and journey context',
      '</design-context>',
      '',
      '<our-components>',
      'Component system guidance',
      '</our-components>',
      '',
      '<relevant-files>',
      'File snippets',
      '</relevant-files>',
      '',
      '<response-shape-contract>',
      'Answer briefly',
      '</response-shape-contract>',
      '',
      '<user-request>',
      'Help me with this',
      '</user-request>',
    ];
    expect(result).toBe(expectedOrder.join('\n'));
  });

  it('skips undefined sections while preserving order of present ones', () => {
    const result = buildUserMessageContext(
      {
        suggestedTools: 'Some tools',
        designContext: 'Research context',
        ourComponents: 'Shared components first',
        relevantFiles: 'Some files',
      },
      'My request',
    );
    expect(result).toContain('<suggested-tools>');
    expect(result).toContain('<design-context>');
    expect(result).toContain('<our-components>');
    expect(result).toContain('<relevant-files>');
    expect(result).not.toContain('<meeting-context>');
    expect(result).not.toContain('<relevant-conversations>');
    expect(result).toContain('<user-request>');
    // Verify order: tools before design-context before our-components before files
    const toolsIdx = result.indexOf('<suggested-tools>');
    const designIdx = result.indexOf('<design-context>');
    const componentsIdx = result.indexOf('<our-components>');
    const filesIdx = result.indexOf('<relevant-files>');
    const requestIdx = result.indexOf('<user-request>');
    expect(toolsIdx).toBeLessThan(designIdx);
    expect(designIdx).toBeLessThan(componentsIdx);
    expect(componentsIdx).toBeLessThan(filesIdx);
    expect(filesIdx).toBeLessThan(requestIdx);
  });

  it('preserves multiline content within sections', () => {
    const fileContent = '### [1] src/config.ts (relevance: 92%)\n```typescript\nconst x = 1;\n```';
    const result = buildUserMessageContext(
      { relevantFiles: fileContent },
      'Explain this',
    );
    expect(result).toContain(fileContent);
  });

  it('does not double-wrap already-tagged content', () => {
    const toolsContent = '- `server/tool` - Does something';
    const result = buildUserMessageContext(
      { suggestedTools: toolsContent },
      'Use these tools',
    );
    // Should have exactly one opening and one closing tag
    expect((result.match(/<suggested-tools>/g) || []).length).toBe(1);
    expect((result.match(/<\/suggested-tools>/g) || []).length).toBe(1);
  });

  it('handles only meeting context being present', () => {
    const result = buildUserMessageContext(
      { meetingContext: 'Live meeting context' },
      'What was just discussed?',
    );
    expect(result).toBe(
      '<meeting-context>\nLive meeting context\n</meeting-context>\n\n<user-request>\nWhat was just discussed?\n</user-request>',
    );
  });
});

describe('buildResponseShapeContractForPrompt', () => {
  it('detects review and confirmation prompts', () => {
    const contract = buildResponseShapeContractForPrompt(
      'I want you to go through the v1 we have made and make sure you know these are the main metrics we need to capture!',
    );

    expect(contract).toContain('compact alignment brief only');
    expect(contract).toContain('Stay under 120 words');
    expect(contract).toContain('Do not use headings, markdown tables, or long inventories.');
  });

  it('places response shape contracts before the user request when rendered', () => {
    const result = buildUserMessageContext(
      {
        relevantFiles: 'File context',
        responseShapeContract: 'Final chat response contract: compact alignment brief only.',
      },
      'Check this is right',
    );

    expect(result).toContain(
      '<response-shape-contract>\nFinal chat response contract: compact alignment brief only.\n</response-shape-contract>\n\n<user-request>\nCheck this is right\n</user-request>',
    );
  });

  it('does not inject when the user explicitly asks for a full audit in chat', () => {
    expect(
      buildResponseShapeContractForPrompt('Give me a complete audit table in chat for the V1 metrics'),
    ).toBeUndefined();
  });
});

describe('createUserMessageGenerator', () => {
  it('includes conversation history prefix in text block when provided', async () => {
    const history = '<conversation_history>\nTest history\n</conversation_history>\n\n';
    const userPrompt = 'What about this document?';
    const generator = createUserMessageGenerator(
      history + userPrompt,
      [],
      [],
      [{
        id: 'doc-1',
        name: 'test.pdf',
        type: 'document',
        mimeType: 'application/pdf',
        base64Data: 'dGVzdA==',
        sizeBytes: 4,
      } satisfies DocumentAttachmentPayload]
    );

    const result = await generator.next();
    expect(result.done).toBe(false);

    const message = result.value;
    expect(message.type).toBe('user');
    expect(message.message.role).toBe('user');
    expect(message.message.content[0].type).toBe('text');
    const textBlock = message.message.content[0] as { type: 'text'; text: string };
    expect(textBlock.text.startsWith(history)).toBe(true);
    expect(textBlock.text).toContain(userPrompt);
    expect(message.message.content).toHaveLength(2); // text + document
    expect(message.message.content[1].type).toBe('document');
  });

  it('produces single message with all content blocks', async () => {
    const generator = createUserMessageGenerator(
      'Hello',
      [],
      [{
        id: 'img-1',
        name: 'photo.png',
        type: 'image',
        mimeType: 'image/png',
        base64Data: 'aW1n',
        sizeBytes: 3,
      } satisfies ImageAttachmentPayload],
      [{
        id: 'doc-1',
        name: 'file.pdf',
        type: 'document',
        mimeType: 'application/pdf',
        base64Data: 'cGRm',
        sizeBytes: 3,
      } satisfies DocumentAttachmentPayload]
    );

    const result = await generator.next();
    expect(result.done).toBe(false);
    expect(result.value.message.content).toHaveLength(3); // text + image + document
    expect(result.value.message.content[0].type).toBe('text');
    expect(result.value.message.content[1].type).toBe('image');
    expect(result.value.message.content[2].type).toBe('document');

    const done = await generator.next();
    expect(done.done).toBe(true);
  });
});

describe('extractImageContentFromToolResult', () => {
  it('extracts MCP-format image blocks (data + mimeType at top level)', () => {
    const content = [
      { type: 'text', text: 'some result' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ];
    const result = extractImageContentFromToolResult(content);
    expect(result).toEqual([
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ]);
  });

  it('extracts Anthropic API-format image blocks (source.data + source.media_type)', () => {
    const content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ];
    const result = extractImageContentFromToolResult(content);
    expect(result).toEqual([
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ]);
  });

  it('extracts MCP resource-format image blocks (resource.blob + resource.mimeType)', () => {
    const content = [
      {
        type: 'resource',
        resource: { uri: 'file:///img.png', mimeType: 'image/png', blob: 'iVBORw0KGgo=' },
      },
    ];
    const result = extractImageContentFromToolResult(content);
    expect(result).toEqual([
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ]);
  });

  it('handles mixed MCP and Anthropic format blocks', () => {
    const content = [
      { type: 'image', data: 'mcpData', mimeType: 'image/jpeg' },
      { type: 'text', text: 'ignored' },
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'anthropicData' } },
    ];
    const result = extractImageContentFromToolResult(content);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'image', data: 'mcpData', mimeType: 'image/jpeg' });
    expect(result[1]).toEqual({ type: 'image', data: 'anthropicData', mimeType: 'image/webp' });
  });

  it('rejects unsupported MIME types', () => {
    const content = [
      { type: 'image', data: 'data', mimeType: 'image/bmp' },
      { type: 'image', source: { type: 'base64', media_type: 'image/tiff', data: 'data' } },
    ];
    const result = extractImageContentFromToolResult(content);
    expect(result).toEqual([]);
  });

  it('returns empty array for non-array input', () => {
    expect(extractImageContentFromToolResult(null)).toEqual([]);
    expect(extractImageContentFromToolResult('string')).toEqual([]);
    expect(extractImageContentFromToolResult(undefined)).toEqual([]);
  });

  it('skips blocks with missing data', () => {
    const content = [
      { type: 'image', data: '', mimeType: 'image/png' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
    ];
    const result = extractImageContentFromToolResult(content);
    expect(result).toEqual([]);
  });
});

describe('skill attachment metadata extraction', () => {
  it('parses frontmatter metadata for SKILL.md attachments but not regular markdown files', () => {
    const attachments: AgentAttachmentPayload[] = [
      {
        id: 'skill-1',
        name: 'SKILL.md',
        path: '/tmp/skills/writing/email-helper/SKILL.md',
        relativePath: 'skills/writing/email-helper/SKILL.md',
        size: 0,
        content: `---
description: Email helper
model: opus
effort: high
output_shape:
  default_surface: file_artifact
  chat_contract: concise_summary
  artifact_expected: true
  max_chat_words: 180
  source_policy: artifact_sources
---
Body`,
      },
      {
        id: 'note-1',
        name: 'notes.md',
        path: '/tmp/skills/writing/email-helper/notes.md',
        relativePath: 'skills/writing/email-helper/notes.md',
        size: 0, content: '---\ndescription: Not a skill\nmodel: sonnet\neffort: low\n---\nBody',
      },
    ];

    const result = attachSkillMetadataToTextAttachments(attachments);
    expect(result[0].skillMetadata).toEqual({
      model: 'opus',
      effort: 'high',
      outputShape: {
        default_surface: 'file_artifact',
        chat_contract: 'concise_summary',
        artifact_expected: true,
        max_chat_words: 180,
        source_policy: 'artifact_sources',
      },
    });
    expect(result[1].skillMetadata).toBeUndefined();
  });

  it('identifies skill paths using SKILL.md + recognized skill-directory patterns', () => {
    expect(isSkillAttachmentPath('skills/meetings/meeting-prep/SKILL.md')).toBe(true);
    expect(isSkillAttachmentPath('skills/meetings/meeting-prep/notes.md')).toBe(false);
    expect(isSkillAttachmentPath('docs/project/SKILL.md')).toBe(false);
  });
});

describe('skill metadata prompt annotation', () => {
  it('includes model/effort annotation only when metadata is present', () => {
    const prompt = appendAttachmentsToPrompt('Help me', [
      {
        id: 'a1',
        name: 'SKILL.md',
        path: '/tmp/skills/research/deep-dive/SKILL.md',
        relativePath: 'skills/research/deep-dive/SKILL.md',
        size: 0, content: 'Skill content',
        skillMetadata: { model: 'opus', effort: 'high' },
      },
    ]);

    expect(prompt).toContain('[Skill metadata: model recommendation = opus, effort = high]');
  });

  it('includes only present skill metadata fields', () => {
    const prompt = appendAttachmentsToPrompt('Help me', [
      {
        id: 'a2',
        name: 'SKILL.md',
        path: '/tmp/skills/research/deep-dive/SKILL.md',
        relativePath: 'skills/research/deep-dive/SKILL.md',
        size: 0, content: 'Skill content',
        skillMetadata: { model: 'sonnet' },
      },
    ]);

    expect(prompt).toContain('[Skill metadata: model recommendation = sonnet]');
    expect(prompt).not.toContain('effort =');
  });

  it('includes a compact output routing hint for artifact-shaped skills', () => {
    const prompt = appendAttachmentsToPrompt('Help me', [
      {
        id: 'a3',
        name: 'SKILL.md',
        path: '/tmp/skills/research/deep-dive/SKILL.md',
        relativePath: 'skills/research/deep-dive/SKILL.md',
        size: 0,
        content: 'Skill content',
        skillMetadata: {
          outputShape: {
            default_surface: 'file_artifact',
            chat_contract: 'concise_summary',
            artifact_expected: true,
            max_chat_words: 180,
            source_policy: 'artifact_sources',
          },
        },
      },
    ]);

    expect(prompt).toContain(
      '[Skill metadata: output routing = durable artifact; chat should contain a concise summary and artifact handoff, chat max words = 180, sources belong in the artifact]'
    );
  });

  it('renders source_policy none for future skill contracts', () => {
    const prompt = appendAttachmentsToPrompt('Help me', [
      {
        id: 'a4',
        name: 'SKILL.md',
        path: '/tmp/skills/quick-answer/SKILL.md',
        relativePath: 'skills/quick-answer/SKILL.md',
        size: 0,
        content: 'Skill content',
        skillMetadata: {
          outputShape: {
            default_surface: 'chat_answer',
            chat_contract: 'direct_answer',
            source_policy: 'none',
          },
        },
      },
    ]);

    expect(prompt).toContain(
      '[Skill metadata: output routing = direct answer in chat, sources not needed in chat]'
    );
  });
});

describe('resolveSkillModelRecommendations', () => {
  const makeProfile = (overrides: Partial<ModelProfile> & { id: string; name: string }): ModelProfile => ({
    serverUrl: 'http://localhost:1234',
    createdAt: Date.now(),
    model: 'test-model',
    ...overrides,
  });

  it('matches profile names case-insensitively and uses first duplicate match', () => {
    const profiles: ModelProfile[] = [
      makeProfile({ id: 'first', name: 'GPT-5.5', model: 'gpt-5.5-high' }),
      makeProfile({ id: 'second', name: 'gpt-5.5', model: 'gpt-5.5-low' }),
    ];

    const recommendations = ['OpUs', 'gpt-5.5', 'Unknown-Model', 'GPT-5.5'];
    const resolution = resolveSkillModelRecommendations(recommendations, profiles);

    expect(resolution.claudeAliases).toEqual(['opus']);
    expect(resolution.profileMatches.map((profile) => profile.id)).toEqual(['first']);
    expect(resolution.unresolvedModels).toEqual(['Unknown-Model']);
  });

  it('collects unique model recommendations from attachment metadata', () => {
    const attachments = attachSkillMetadataToTextAttachments([
      {
        id: 'skill-1',
        name: 'SKILL.md',
        path: '/tmp/skills/writing/email-helper/SKILL.md',
        relativePath: 'skills/writing/email-helper/SKILL.md',
        size: 0, content: '---\ndescription: helper\nmodel: GPT-5.5\n---\nBody',
      },
      {
        id: 'skill-2',
        name: 'SKILL.md',
        path: '/tmp/skills/research/deep-dive/SKILL.md',
        relativePath: 'skills/research/deep-dive/SKILL.md',
        size: 0, content: '---\ndescription: helper\nmodel: gpt-5.5\n---\nBody',
      },
    ]);

    expect(collectSkillModelRecommendations(attachments)).toEqual(['GPT-5.5']);
  });
});

describe('computeEffectiveEffort', () => {
  it('boosts medium user effort to xhigh when any skill requests max', () => {
    expect(computeEffectiveEffort('medium', undefined, ['max'])).toBe('xhigh');
  });

  it('does not downgrade xhigh user effort when skill effort is lower', () => {
    expect(computeEffectiveEffort('xhigh', undefined, ['low'])).toBe('xhigh');
  });

  it('uses the highest effort across multiple skills', () => {
    expect(computeEffectiveEffort('low', undefined, ['medium', 'high', 'low'])).toBe('high');
  });

  it('prioritizes profile effort over user and skill efforts', () => {
    expect(computeEffectiveEffort('low', 'medium', ['max'])).toBe('medium');
  });

  it('keeps user effort unchanged when there are no skill efforts', () => {
    expect(computeEffectiveEffort('high', undefined, [])).toBe('high');
  });

  it('uses skill effort when user effort is unset', () => {
    expect(computeEffectiveEffort(undefined, undefined, ['high'])).toBe('high');
  });
});

describe('agent turn reasoning effort precedence — characterization', () => {
  it('uses the hard default when every effort source is unset', () => {
    expect(characterizeCurrentAgentTurnEffort({})).toBe('high');
  });

  it('uses global effort over the default', () => {
    expect(characterizeCurrentAgentTurnEffort({ globalEffort: 'medium' })).toBe('medium');
  });

  it('uses per-model effort over global effort', () => {
    expect(characterizeCurrentAgentTurnEffort({
      modelId: 'claude-opus-4-8',
      modelEfforts: { 'claude-opus-4-8': 'xhigh' },
      globalEffort: 'low',
    })).toBe('xhigh');
  });

  it('treats skill effort as a floor over per-model/global/default effort', () => {
    expect(characterizeCurrentAgentTurnEffort({
      globalEffort: 'low',
      skillEfforts: ['medium', 'high'],
    })).toBe('high');
  });

  it('does not let skill effort downgrade the per-model/global/default effort', () => {
    expect(characterizeCurrentAgentTurnEffort({
      modelId: 'claude-opus-4-8',
      modelEfforts: { 'claude-opus-4-8': 'xhigh' },
      globalEffort: 'low',
      skillEfforts: ['low'],
    })).toBe('xhigh');
  });

  it('uses profile effort over skill and per-model/global/default effort', () => {
    expect(characterizeCurrentAgentTurnEffort({
      modelId: 'claude-opus-4-8',
      modelEfforts: { 'claude-opus-4-8': 'xhigh' },
      globalEffort: 'low',
      profileEffort: 'medium',
      skillEfforts: ['max'],
    })).toBe('medium');
  });

  it('maps profile effort max to xhigh', () => {
    expect(characterizeCurrentAgentTurnEffort({
      globalEffort: 'low',
      profileEffort: 'max',
    })).toBe('xhigh');
  });

  it('uses session override over profile, skill, per-model, global, and default effort', () => {
    expect(characterizeCurrentAgentTurnEffort({
      sessionEffort: 'low',
      modelId: 'claude-opus-4-8',
      modelEfforts: { 'claude-opus-4-8': 'xhigh' },
      globalEffort: 'medium',
      profileEffort: 'high',
      skillEfforts: ['max'],
    })).toBe('low');
  });

  it('uses valid shell env override over every other effort source', () => {
    expect(characterizeCurrentAgentTurnEffort({
      shellEnv: ' Medium ',
      sessionEffort: 'low',
      modelId: 'claude-opus-4-8',
      modelEfforts: { 'claude-opus-4-8': 'xhigh' },
      globalEffort: 'high',
      profileEffort: 'xhigh',
      skillEfforts: ['max'],
    })).toBe('medium');
  });

  it('ignores invalid shell env override and falls through to session override', () => {
    expect(characterizeCurrentAgentTurnEffort({
      shellEnv: 'max',
      sessionEffort: 'medium',
      profileEffort: 'xhigh',
    })).toBe('medium');
  });
});

// =============================================================================
// isApiOutputMessage — gates messageCount activity guard in agentTurnExecutor
// =============================================================================

describe('isApiOutputMessage', () => {
  // Synthetic framework messages — must NOT count as activity (otherwise a
  // transient error right after init or "Planning approach..." status surfaces
  // as a hard error instead of being silently retried).
  // See rebel://conversation/10d9eec1-18ea-4591-8b0e-39cf19c9a36d.
  it('returns false for system:init (yielded before any API call)', () => {
    expect(isApiOutputMessage({ type: 'system', subtype: 'init' })).toBe(false);
  });

  it('returns false for system:status (e.g. "Planning approach...", retry status)', () => {
    expect(isApiOutputMessage({ type: 'system', subtype: 'status', message: 'Planning approach...' })).toBe(false);
  });

  it('returns false for system:warning (e.g. MCP unavailable)', () => {
    expect(isApiOutputMessage({ type: 'system', subtype: 'warning', warningMessage: 'MCP down' })).toBe(false);
  });

  // Real API output — MUST count so the guards prevent duplicate replies on retry.
  it('returns true for assistant messages (real API output, must not be duplicated)', () => {
    expect(isApiOutputMessage({ type: 'assistant', message: { role: 'assistant', content: [] } })).toBe(true);
  });

  it('returns true for user tool_result messages', () => {
    expect(isApiOutputMessage({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } })).toBe(true);
  });

  it('returns true for the final result message', () => {
    expect(isApiOutputMessage({ type: 'result', subtype: 'success' })).toBe(true);
  });

  // stream_event text/thinking deltas are user-visible streaming output and must
  // count as activity — retrying after they've been emitted would duplicate output.
  it('returns true for stream_event messages (streaming text/thinking deltas)', () => {
    expect(isApiOutputMessage({ type: 'stream_event', event: { type: 'content_block_delta' } })).toBe(true);
  });

  // Defensive defaults — unknown/missing types should err on the safe side
  // ("count as activity") so an unanticipated message subtype never causes a
  // duplicate reply.
  it('returns true (default) when type is missing', () => {
    expect(isApiOutputMessage({ subtype: 'init' })).toBe(true);
  });

  it('returns true (default) for null/undefined input', () => {
    expect(isApiOutputMessage(null)).toBe(true);
    expect(isApiOutputMessage(undefined)).toBe(true);
  });

  it('returns true (default) for non-object input', () => {
    expect(isApiOutputMessage('not an object')).toBe(true);
    expect(isApiOutputMessage(42)).toBe(true);
  });
});
