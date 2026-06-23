/**
 * Agent Turn Utilities
 *
 * Pure helper functions for agent turn processing:
 * - User message context assembly (XML-tagged sections)
 * - Attachment formatting for prompts
 * - Content extraction from agent messages
 * - Image content extraction from tool results
 */

import path from 'node:path';
import { logger } from '@core/logger';
import type {
  AgentAttachmentPayload,
  ImageAttachmentPayload,
  DocumentAttachmentPayload,
  ExtractedPdfAttachmentPayload,
  OfficeDocumentAttachmentPayload,
  TextFileAttachmentPayload,
  BinaryFileAttachmentPayload,
  AnyAttachmentPayload,
} from '@shared/types';
import type { ModelProfile, ThinkingEffort } from '@shared/types/settings';
import { resolveReasoningEffort, type SkillReasoningEffort } from '@shared/utils/reasoningEffortResolver';
import {
  isImageAttachment,
  isDocumentAttachment,
  isExtractedPdfAttachment,
  isOfficeDocumentAttachment,
  isTextFileAttachment,
  isBinaryFileAttachment,
  isTextAttachment,
} from '@shared/types';
import { parseSkillFrontmatterFromContent } from '../services/skillsService';

export type ImageContentBlock = import('@shared/types').ImageContentBlock;

export type SkillMetadataEffort = SkillReasoningEffort;

export interface SkillAttachmentMetadata {
  model?: string;
  effort?: SkillMetadataEffort;
  outputShape?: {
    default_surface?: 'chat_summary' | 'chat_answer' | 'file_artifact' | 'interactive_view' | 'expandable_report';
    chat_contract?: 'concise_summary' | 'direct_answer' | 'decision_brief' | 'blocker_only';
    artifact_expected?: boolean;
    max_chat_words?: number;
    source_policy?: 'inline_key_sources' | 'artifact_sources' | 'none';
  };
}

export interface TextAttachmentWithSkillMetadata extends AgentAttachmentPayload {
  skillMetadata?: SkillAttachmentMetadata;
}

type ClaudeSkillAlias = 'haiku' | 'sonnet' | 'opus';

export interface SkillModelResolution {
  claudeAliases: ClaudeSkillAlias[];
  /** Resolved non-Claude profiles. Currently annotation-only (not used for
   *  ad-hoc agent registration) to avoid suppressing tier routing.
   *  See docs/plans/260328_skill_model_frontmatter.md — Stage 2 review. */
  profileMatches: ModelProfile[];
  unresolvedModels: string[];
}

/**
 * Compute turn effort with floor semantics:
 * profile effort override > max(user effort, max skill effort) > unset
 */
export function computeEffectiveEffort(
  userEffort: ThinkingEffort | undefined,
  profileEffort: string | undefined,
  skillEfforts: Array<'low' | 'medium' | 'high' | 'max'>,
): ThinkingEffort | undefined {
  return resolveReasoningEffort({
    globalEffort: userEffort,
    profileEffort,
    skillEfforts,
  });
}

// =============================================================================
// User Message Context Assembly
// =============================================================================

/**
 * Sections that can be injected into the user message, rendered in display order.
 * Each section wraps its content in an XML tag (e.g., `<relevant-files>...</relevant-files>`).
 */
export interface UserMessageContextSections {
  focusContext?: string;
  meetingContext?: string;
  relevantConversations?: string;
  suggestedTools?: string;
  prefetchedDocuments?: string;
  designContext?: string;
  ourComponents?: string;
  relevantFiles?: string;
  responseShapeContract?: string;
}

const REVIEW_CONFIRMATION_PATTERN =
  /\b(?:go through|make sure (?:you )?(?:know|understand)|check (?:this|it|that) (?:is|looks|seems)?\s*(?:right|correct|aligned)|does (?:this|it|that) (?:match|align)|what (?:are|am i|we) missing|what (?:shouldn't|should not) (?:be|we have)|have (?:that|we) (?:shouldn't|should not))\b/i;

const EXPLICIT_FULL_AUDIT_PATTERN =
  /\b(?:full|complete|comprehensive|detailed)\s+(?:audit|inventory|breakdown|table|report|analysis)\b|\b(?:in chat|paste|include)\s+(?:the )?(?:full|complete|entire)\b/i;

export const buildResponseShapeContractForPrompt = (userMessage: string): string | undefined => {
  if (!REVIEW_CONFIRMATION_PATTERN.test(userMessage)) return undefined;
  if (EXPLICIT_FULL_AUDIT_PATTERN.test(userMessage)) return undefined;

  return [
    'This looks like a review/confirmation request.',
    'Final chat response contract: compact alignment brief only.',
    '- Start with the verdict.',
    '- Include only the few important mismatches, missing items, or risks.',
    '- Do not enumerate every item checked just to prove you checked it.',
    '- Do not use headings, markdown tables, or long inventories.',
    '- Stay under 120 words unless the user explicitly asks for a full audit/report/table in chat.',
  ].join('\n');
};

/**
 * Build a user message with optional context sections wrapped in XML tags.
 *
 * Ordering follows Anthropic's long-context guidance: reference material first,
 * user request last. When no context sections are present, returns the bare
 * user message (no wrapping).
 *
 * Section order: meeting-context > relevant-conversations > suggested-tools > prefetched-documents > design-context > our-components > relevant-files > response-shape-contract > user-request
 */
export function buildUserMessageContext(
  sections: UserMessageContextSections,
  userMessage: string,
): string {
  const orderedParts: { tag: string; content: string | undefined }[] = [
    { tag: 'focus-context', content: sections.focusContext },
    { tag: 'meeting-context', content: sections.meetingContext },
    { tag: 'relevant-conversations', content: sections.relevantConversations },
    { tag: 'suggested-tools', content: sections.suggestedTools },
    { tag: 'prefetched-documents', content: sections.prefetchedDocuments },
    { tag: 'design-context', content: sections.designContext },
    { tag: 'our-components', content: sections.ourComponents },
    { tag: 'relevant-files', content: sections.relevantFiles },
    { tag: 'response-shape-contract', content: sections.responseShapeContract },
  ];

  const rendered = orderedParts
    .filter((p): p is { tag: string; content: string } => !!p.content)
    .map(p => `<${p.tag}>\n${p.content}\n</${p.tag}>`);

  if (rendered.length === 0) {
    return userMessage;
  }

  return `${rendered.join('\n\n')}\n\n<user-request>\n${userMessage}\n</user-request>`;
}

// =============================================================================
// Attachment Processing
// =============================================================================

// Attachment processing constants
export const MAX_RENDERER_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_CHAR_LENGTH = 120000;

// Code fence language mapping for syntax highlighting
export const CODE_FENCE_MAP: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  md: 'markdown',
  mdx: 'markdown',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  html: 'html',
  css: 'css',
  scss: 'scss',
  sql: 'sql',
  cs: 'csharp',
  cpp: 'cpp',
  c: 'c',
};

// Supported image MIME types for tool result extraction
export const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

/** Pattern for space-level skill directories (Chief-of-Staff, Personal, work spaces) */
const SPACE_SKILLS_PATTERN = /^(Chief-of-Staff|Personal|work[\\/][^\\/]+[\\/][^\\/]+)[\\/]skills([\\/]|$)/i;

/** Pattern for platform-level skill directories (rebel-system) */
const PLATFORM_SKILLS_PATTERN = /^rebel-system[\\/]skills([\\/]|$)/i;

/** Pattern for workspace-level skill directories (skills/ at root) */
const WORKSPACE_SKILLS_PATTERN = /^skills([\\/]|$)/i;

/** SKILL.md suffix check (cross-platform separators) */
const SKILL_MD_PATH_PATTERN = /(^|[\\/])SKILL\.md$/i;

/** Claude aliases supported by Anthropic-native subagent registration */
const CLAUDE_SKILL_ALIASES: ReadonlySet<ClaudeSkillAlias> = new Set(['haiku', 'sonnet', 'opus']);

const normalizeSkillPathForMatching = (inputPath: string): string =>
  inputPath.trim().replace(/^[.][\\/]/, '').replace(/^[/\\]+/, '');

const isSkillPath = (candidatePath: string): boolean =>
  SPACE_SKILLS_PATTERN.test(candidatePath) ||
  PLATFORM_SKILLS_PATTERN.test(candidatePath) ||
  WORKSPACE_SKILLS_PATTERN.test(candidatePath);

const getSkillPathCandidate = (attachment: AgentAttachmentPayload): string =>
  attachment.relativePath || attachment.path || attachment.name;

export const isSkillAttachmentPath = (candidatePath: string): boolean => {
  const normalizedPath = normalizeSkillPathForMatching(candidatePath);
  if (!normalizedPath) return false;
  return SKILL_MD_PATH_PATTERN.test(normalizedPath) && isSkillPath(normalizedPath);
};

/**
 * Parse model/effort metadata only for SKILL.md attachments under recognized skill directories.
 */
export const parseSkillAttachmentMetadata = (
  attachment: AgentAttachmentPayload
): SkillAttachmentMetadata | undefined => {
  const candidatePath = getSkillPathCandidate(attachment);
  if (!isSkillAttachmentPath(candidatePath)) {
    return undefined;
  }

  const frontmatter = parseSkillFrontmatterFromContent(attachment.content);
  if (!frontmatter) {
    return undefined;
  }

  const model = typeof frontmatter.model === 'string' ? frontmatter.model.trim() : '';
  const effort = frontmatter.effort;
  const outputShape = frontmatter.output_shape;
  if (!model && !effort && !outputShape) {
    return undefined;
  }

  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(outputShape ? { outputShape } : {}),
  };
};

/**
 * Attach parsed skill metadata once during attachment processing.
 */
export const attachSkillMetadataToTextAttachments = (
  attachments: AgentAttachmentPayload[]
): TextAttachmentWithSkillMetadata[] =>
  attachments.map((attachment) => {
    const skillMetadata = parseSkillAttachmentMetadata(attachment);
    if (!skillMetadata) {
      return attachment;
    }
    return {
      ...attachment,
      skillMetadata,
    };
  });

/**
 * Collect unique model recommendations from parsed skill metadata (first casing wins).
 */
export const collectSkillModelRecommendations = (
  attachments: TextAttachmentWithSkillMetadata[]
): string[] => {
  const models: string[] = [];
  const seen = new Set<string>();

  for (const attachment of attachments) {
    const model = attachment.skillMetadata?.model?.trim();
    if (!model) continue;
    const normalized = model.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    models.push(model);
  }

  return models;
};

/**
 * Resolve skill model recommendations into Claude aliases, local model profiles, and unresolved values.
 * Profile matching is case-insensitive against ModelProfile.name, first match wins.
 */
export const resolveSkillModelRecommendations = (
  modelRecommendations: string[],
  profiles: ModelProfile[]
): SkillModelResolution => {
  const claudeAliases: ClaudeSkillAlias[] = [];
  const profileMatches: ModelProfile[] = [];
  const unresolvedModels: string[] = [];
  const seenValues = new Set<string>();
  const seenProfiles = new Set<string>();

  for (const rawRecommendation of modelRecommendations) {
    const modelName = rawRecommendation.trim();
    if (!modelName) continue;

    const normalizedModelName = modelName.toLowerCase();
    if (seenValues.has(normalizedModelName)) continue;
    seenValues.add(normalizedModelName);

    if (CLAUDE_SKILL_ALIASES.has(normalizedModelName as ClaudeSkillAlias)) {
      claudeAliases.push(normalizedModelName as ClaudeSkillAlias);
      continue;
    }

    const matchedProfile = profiles.find(
      (profile) => profile.name.trim().toLowerCase() === normalizedModelName
    );
    if (matchedProfile) {
      if (!seenProfiles.has(matchedProfile.id)) {
        seenProfiles.add(matchedProfile.id);
        profileMatches.push(matchedProfile);
      }
      continue;
    }

    unresolvedModels.push(modelName);
  }

  return {
    claudeAliases,
    profileMatches,
    unresolvedModels,
  };
};

/**
 * Sanitize attachment labels by replacing newlines and backticks with slashes.
 */
export const sanitizeAttachmentLabel = (value: string): string =>
  value.replace(/[\r\n`]+/g, '/');

const buildSkillMetadataAnnotation = (skillMetadata?: SkillAttachmentMetadata): string | null => {
  if (!skillMetadata) return null;

  const values: string[] = [];
  if (skillMetadata.model) {
    values.push(`model recommendation = ${sanitizeAttachmentLabel(skillMetadata.model)}`);
  }
  if (skillMetadata.effort) {
    values.push(`effort = ${skillMetadata.effort}`);
  }
  if (skillMetadata.outputShape) {
    const { default_surface, chat_contract, artifact_expected, max_chat_words, source_policy } = skillMetadata.outputShape;
    const isArtifactSurface =
      default_surface === 'file_artifact' ||
      default_surface === 'interactive_view' ||
      default_surface === 'expandable_report' ||
      artifact_expected === true;
    if (isArtifactSurface) {
      values.push('output routing = durable artifact; chat should contain a concise summary and artifact handoff');
    } else if (default_surface === 'chat_answer' || chat_contract === 'direct_answer') {
      values.push('output routing = direct answer in chat');
    } else if (default_surface === 'chat_summary' || chat_contract) {
      values.push('output routing = concise chat summary');
    }
    if (typeof max_chat_words === 'number') {
      values.push(`chat max words = ${max_chat_words}`);
    }
    if (source_policy === 'artifact_sources') {
      values.push('sources belong in the artifact');
    } else if (source_policy === 'inline_key_sources') {
      values.push('include only key sources in chat');
    } else if (source_policy === 'none') {
      values.push('sources not needed in chat');
    }
  }

  if (values.length === 0) {
    return null;
  }

  return `[Skill metadata: ${values.join(', ')}]`;
};

/**
 * Infer the code fence language from a file name's extension.
 */
export const inferFenceLanguage = (fileName: string): string => {
  const ext = path.extname(fileName)?.replace('.', '').toLowerCase();
  if (!ext) {
    return '';
  }
  return CODE_FENCE_MAP[ext] ?? (ext.length <= 8 ? ext : '');
};

/**
 * Append file attachments to a prompt as code-fenced blocks.
 */
export const appendAttachmentsToPrompt = (
  prompt: string,
  attachments: TextAttachmentWithSkillMetadata[],
  sourcePathMap?: Map<string, string>
): string => {
  if (!attachments || attachments.length === 0) {
    return prompt;
  }
  const serialized = attachments
    .map((attachment, index) => {
      const language = inferFenceLanguage(attachment.name);
      const fence = `\u0060\u0060\u0060${language ? language : ''}`;
      const sourcePath = sourcePathMap?.get(attachment.id) ?? attachment.path;
      const parts = [
        `Attachment ${index + 1}: ${sanitizeAttachmentLabel(attachment.relativePath)}`,
      ];
      if (sourcePath) {
        parts.push(`[Source file: ${sourcePath}]`);
      }
      const metadataAnnotation = buildSkillMetadataAnnotation(attachment.skillMetadata);
      if (metadataAnnotation) {
        parts.push(metadataAnnotation);
      }
      parts.push(fence, attachment.content, '```');
      return parts.join('\n');
    })
    .join('\n\n');
  return `${prompt}\n\n[Attached Files]\n${serialized}`;
};

/**
 * Extract plain text from agent message content blocks.
 * Handles text blocks, input_text blocks, and recursively processes tool_result blocks.
 */
export const extractTextFromContent = (content: unknown): string => {
  try {
    if (!Array.isArray(content)) return '';
    return content
      .filter((block) => block && typeof block === 'object')
      .flatMap((block: Record<string, unknown>) => {
        try {
          if (block.type === 'text' && typeof block.text === 'string') {
            return block.text;
          }
          if (block.type === 'input_text' && typeof block.text === 'string') {
            return block.text;
          }
          if (block.type === 'tool_result' && Array.isArray(block.content)) {
            return extractTextFromContent(block.content).split('\n');
          }
        } catch (blockError) {
          logger.debug(
            { err: blockError, blockType: block?.type },
            'Error extracting text from content block'
          );
        }
        return [];
      })
      .join('\n')
      .trim();
  } catch (error) {
    logger.error({ err: error }, 'Error in extractTextFromContent');
    return '';
  }
};

/**
 * Extract image content blocks from tool result content.
 * Handles two formats:
 *   - MCP format:      { type: 'image', data: string, mimeType: string }
 *   - Anthropic format: { type: 'image', source: { type: 'base64', media_type: string, data: string } }
 * Filters for supported MIME types and validates structure.
 */
export const extractImageContentFromToolResult = (content: unknown): ImageContentBlock[] => {
  try {
    if (!Array.isArray(content)) return [];
    return content
      .filter((block): block is Record<string, unknown> => {
        if (!block || typeof block !== 'object') return false;
        const b = block as Record<string, unknown>;

        if (b.type === 'image') {
          // MCP format: data + mimeType at top level
          if (typeof b.data === 'string' && b.data && typeof b.mimeType === 'string') {
            return SUPPORTED_IMAGE_MIME_TYPES.has(b.mimeType.toLowerCase());
          }

          // Anthropic API format: source.data + source.media_type
          const src = b.source as Record<string, unknown> | undefined;
          if (src && typeof src === 'object' && typeof src.data === 'string' && src.data && typeof src.media_type === 'string') {
            return SUPPORTED_IMAGE_MIME_TYPES.has(src.media_type.toLowerCase());
          }

          logger.debug(
            { blockKeys: Object.keys(block as object) },
            'Image block with unrecognised structure in tool result'
          );
          return false;
        }

        // MCP embedded resource with image blob
        if (b.type === 'resource') {
          const resource = b.resource as Record<string, unknown> | undefined;
          if (resource && typeof resource === 'object' && typeof resource.blob === 'string' && resource.blob && typeof resource.mimeType === 'string') {
            return SUPPORTED_IMAGE_MIME_TYPES.has(resource.mimeType.toLowerCase());
          }
        }

        return false;
      })
      .map((block) => {
        // MCP format
        if (typeof block.data === 'string' && typeof block.mimeType === 'string') {
          return { type: 'image' as const, data: block.data, mimeType: block.mimeType };
        }
        // MCP embedded resource with image blob
        if (block.type === 'resource') {
          const resource = block.resource as Record<string, unknown>;
          return { type: 'image' as const, data: resource.blob as string, mimeType: (resource.mimeType as string).toLowerCase() };
        }
        // Anthropic API format
        const src = block.source as Record<string, unknown>;
        return { type: 'image' as const, data: src.data as string, mimeType: src.media_type as string };
      });
  } catch (error) {
    logger.debug({ err: error }, 'Error extracting image content from tool result');
    return [];
  }
};

// =============================================================================
// Image Attachment Utilities
// =============================================================================

/** Maximum image file size in bytes (10MB) */
export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;

/** Optimal max dimension for performance (avoids resize latency) */
export const OPTIMAL_MAX_DIMENSION = 1568;

/** Maximum number of image attachments per turn */
export const MAX_IMAGE_ATTACHMENTS = 5;

/**
 * Separate mixed attachments into text, image, document, extracted PDF, office, text file, and binary arrays.
 */
export const separateAttachments = (
  attachments: AnyAttachmentPayload[]
): {
  textAttachments: AgentAttachmentPayload[];
  imageAttachments: ImageAttachmentPayload[];
  documentAttachments: DocumentAttachmentPayload[];
  extractedPdfAttachments: ExtractedPdfAttachmentPayload[];
  officeAttachments: OfficeDocumentAttachmentPayload[];
  textFileAttachments: TextFileAttachmentPayload[];
  binaryAttachments: BinaryFileAttachmentPayload[];
} => {
  const textAttachments: AgentAttachmentPayload[] = [];
  const imageAttachments: ImageAttachmentPayload[] = [];
  const documentAttachments: DocumentAttachmentPayload[] = [];
  const extractedPdfAttachments: ExtractedPdfAttachmentPayload[] = [];
  const officeAttachments: OfficeDocumentAttachmentPayload[] = [];
  const textFileAttachments: TextFileAttachmentPayload[] = [];
  const binaryAttachments: BinaryFileAttachmentPayload[] = [];

  for (const attachment of attachments) {
    if (isImageAttachment(attachment)) {
      imageAttachments.push(attachment);
    } else if (isDocumentAttachment(attachment)) {
      documentAttachments.push(attachment);
    } else if (isExtractedPdfAttachment(attachment)) {
      extractedPdfAttachments.push(attachment);
    } else if (isOfficeDocumentAttachment(attachment)) {
      officeAttachments.push(attachment);
    } else if (isTextFileAttachment(attachment)) {
      textFileAttachments.push(attachment);
    } else if (isBinaryFileAttachment(attachment)) {
      binaryAttachments.push(attachment);
    } else if (isTextAttachment(attachment)) {
      textAttachments.push(attachment);
    }
  }

  return {
    textAttachments,
    imageAttachments,
    documentAttachments,
    extractedPdfAttachments,
    officeAttachments,
    textFileAttachments,
    binaryAttachments,
  };
};

/**
 * Append office document attachments to a prompt as formatted text blocks.
 */
const OFFICE_TYPE_LABELS: Record<OfficeDocumentAttachmentPayload['officeType'], string> = {
  word: 'Word Document',
  excel: 'Excel Spreadsheet',
  powerpoint: 'PowerPoint Presentation',
  rtf: 'RTF Document',
};

export const appendOfficeAttachmentsToPrompt = (
  prompt: string,
  officeAttachments: OfficeDocumentAttachmentPayload[],
  sourcePathMap?: Map<string, string>
): string => {
  if (!officeAttachments || officeAttachments.length === 0) {
    return prompt;
  }
  const serialized = officeAttachments
    .map((attachment, index) => {
      const typeLabel = OFFICE_TYPE_LABELS[attachment.officeType] ?? 'Office Document';
      const sourcePath = sourcePathMap?.get(attachment.id);
      const parts = [
        `Attachment ${index + 1}: ${attachment.name} (${typeLabel})`,
      ];
      if (sourcePath) {
        parts.push(`[Source file: ${sourcePath}]`);
      }
      return [...parts, '```', attachment.extractedText, '```'].join('\n');
    })
    .join('\n\n');
  return `${prompt}\n\n[Attached Office Documents]\n${serialized}`;
};

/**
 * Append extracted PDF attachments to a prompt as formatted text blocks.
 * Used for large PDFs where text extraction was used instead of base64 encoding.
 */
export const appendExtractedPdfAttachmentsToPrompt = (
  prompt: string,
  extractedPdfAttachments: ExtractedPdfAttachmentPayload[],
  sourcePathMap?: Map<string, string>
): string => {
  if (!extractedPdfAttachments || extractedPdfAttachments.length === 0) {
    return prompt;
  }
  const serialized = extractedPdfAttachments
    .map((attachment, index) => {
      const pageInfo = attachment.pageCount ? ` (${attachment.pageCount} pages)` : '';
      const sourcePath = sourcePathMap?.get(attachment.id);
      const parts = [
        `Attachment ${index + 1}: ${attachment.name}${pageInfo} [PDF - text extracted, images not included]`,
      ];
      if (sourcePath) {
        parts.push(`[Source file: ${sourcePath}]`);
      }
      return [...parts, '```', attachment.extractedText, '```'].join('\n');
    })
    .join('\n\n');
  return `${prompt}\n\n[Attached PDF Documents - Text Only]\n${serialized}`;
};

/** Maximum number of text file attachments per turn */
export const MAX_TEXT_FILE_ATTACHMENTS = 5;

/** Maximum size of text file content in bytes */
export { MAX_EXTRACTED_TEXT_BYTES as MAX_TEXT_FILE_CONTENT_BYTES } from '@shared/attachmentLimits';

/**
 * Append text file attachments to a prompt as formatted text blocks.
 */
export const appendTextFileAttachmentsToPrompt = (
  prompt: string,
  textFileAttachments: TextFileAttachmentPayload[],
  sourcePathMap?: Map<string, string>
): string => {
  if (!textFileAttachments || textFileAttachments.length === 0) {
    return prompt;
  }
  const serialized = textFileAttachments
    .map((attachment, index) => {
      const ext = path.extname(attachment.name).slice(1).toLowerCase();
      const langHint = CODE_FENCE_MAP[ext] || ext || '';
      const sourcePath = sourcePathMap?.get(attachment.id);
      const parts = [
        `Attachment ${index + 1}: ${attachment.name}`,
      ];
      if (sourcePath) {
        parts.push(`[Source file: ${sourcePath}]`);
      }
      return [...parts, `\`\`\`${langHint}`, attachment.content, '```'].join('\n');
    })
    .join('\n\n');
  return `${prompt}\n\n[Attached Files]\n${serialized}`;
};

/**
 * Append binary file attachments to a prompt.
 * Binary files have no extractable content — only name, type, and source path.
 */
export const appendBinaryAttachmentsToPrompt = (
  prompt: string,
  binaryAttachments: BinaryFileAttachmentPayload[],
  sourcePathMap?: Map<string, string>
): string => {
  if (!binaryAttachments || binaryAttachments.length === 0) {
    return prompt;
  }
  const serialized = binaryAttachments
    .map((attachment, index) => {
      const ext = path.extname(attachment.name).slice(1).toUpperCase() || 'BINARY';
      const sizeMB = (attachment.sizeBytes / (1024 * 1024)).toFixed(1);
      const parts = [`Attachment ${index + 1}: ${attachment.name} (${ext}, ${sizeMB}MB)`];
      const sourcePath = sourcePathMap?.get(attachment.id);
      if (sourcePath) {
        parts.push(`[Source file: ${sourcePath}]`);
      }
      return parts.join('\n');
    })
    .join('\n\n');
  return `${prompt}\n\n[Attached Binary Files — no content extraction available, use file path to access]\n${serialized}`;
};

/** Content block types for user messages */
type TextBlock = { type: 'text'; text: string };
type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
type DocumentBlock = { type: 'document'; source: { type: 'base64'; media_type: string; data: string } };
type ContentBlock = TextBlock | ImageBlock | DocumentBlock;

/**
 * Create an async generator that yields a single user message with text, images, and documents.
 * This enables using the streaming input mode for media attachment support while
 * maintaining single-message semantics.
 */
export async function* createUserMessageGenerator(
  textPrompt: string,
  textAttachments: TextAttachmentWithSkillMetadata[],
  imageAttachments: ImageAttachmentPayload[],
  documentAttachments: DocumentAttachmentPayload[] = [],
  sourcePathMap?: Map<string, string>
): AsyncGenerator<{
  type: 'user';
  message: {
    role: 'user';
    content: ContentBlock[];
  };
}> {
  const textContent = appendAttachmentsToPrompt(textPrompt, textAttachments, sourcePathMap);

  const contentBlocks: ContentBlock[] = [{ type: 'text' as const, text: textContent }];

  // Add image attachments
  for (const img of imageAttachments) {
    contentBlocks.push({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: img.mimeType,
        data: img.base64Data,
      },
    });
  }

  // Add document attachments (PDFs)
  for (const doc of documentAttachments) {
    contentBlocks.push({
      type: 'document' as const,
      source: {
        type: 'base64' as const,
        media_type: doc.mimeType,
        data: doc.base64Data,
      },
    });
  }

  // Add source path information for media attachments
  if (sourcePathMap && sourcePathMap.size > 0) {
    const pathLines: string[] = [];
    for (const img of imageAttachments) {
      const sourcePath = sourcePathMap.get(img.id);
      if (sourcePath) {
        pathLines.push(`${img.name}: ${sourcePath}`);
      }
    }
    for (const doc of documentAttachments) {
      const sourcePath = sourcePathMap.get(doc.id);
      if (sourcePath) {
        pathLines.push(`${doc.name}: ${sourcePath}`);
      }
    }
    if (pathLines.length > 0) {
      contentBlocks.push({
        type: 'text' as const,
        text: `\n[Source files for attached media]\n${pathLines.join('\n')}`,
      });
    }
  }

  logger.debug(
    {
      textLength: textContent.length,
      imageCount: imageAttachments.length,
      documentCount: documentAttachments.length,
      totalBlocks: contentBlocks.length,
    },
    'Creating user message with media attachments'
  );

  yield {
    type: 'user' as const,
    message: {
      role: 'user' as const,
      content: contentBlocks,
    },
  };
}

// =============================================================================
// Activity Classification
// =============================================================================

/**
 * Returns true if the agent message represents real API output (assistant text,
 * tool calls/results, or the final result message) — i.e. content the user has
 * already seen and would be duplicated by silently retrying the turn.
 *
 * Returns false for synthetic framework messages (`type: 'system'`), which are
 * emitted by Rebel Core itself (init metadata, status progress, MCP warnings)
 * and are safe to re-emit on retry.
 *
 * Used by `agentTurnExecutor.ts` to gate the `messageCount` activity counter
 * that drives the silent-retry guards in `turnErrorRecovery.ts`. Counting only
 * real API output preserves the invariant "don't retry if real content was
 * emitted" while letting transient errors that occur after only synthetic
 * progress (e.g. `system:init` + a "Planning approach..." status) be retried
 * silently — the original failure mode reported in
 * `rebel://conversation/10d9eec1-18ea-4591-8b0e-39cf19c9a36d` (transient
 * OpenRouter Connection error after provider switch).
 *
 * Default for missing/unknown types is `true` (defensive — count as activity)
 * so that any future message subtype not yet considered errs on the safe side
 * of "don't risk a duplicate reply."
 */
export const isApiOutputMessage = (message: unknown): boolean => {
  if (!message || typeof message !== 'object') return true;
  const type = (message as { type?: unknown }).type;
  return type !== 'system';
};

// =============================================================================
// Error Helpers
// =============================================================================

export { getErrorMessage } from '@core/utils/getErrorMessage';

export const getErrorName = (error: unknown): string | undefined => {
  if (error instanceof Error) {
    return error.name;
  }
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
};

export const getRawErrorMessage = (error: unknown): string => {
  if (typeof error === 'object' && error !== null) {
    const rawMessage = (error as { __rawMessage?: unknown }).__rawMessage;
    return typeof rawMessage === 'string' ? rawMessage : '';
  }
  return '';
};

/** Extract provider name from a ModelError or similar error with a provider field. */
export const getErrorProvider = (error: unknown): string | undefined => {
  if (typeof error === 'object' && error !== null) {
    const provider = (error as { provider?: unknown }).provider;
    return typeof provider === 'string' ? provider : undefined;
  }
  return undefined;
};
