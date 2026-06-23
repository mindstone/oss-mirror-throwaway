import type { AgentTurnMessage } from '@shared/types';
import { unwrapCompactionArtifact } from '@core/utils/compactionUtils';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import type { StreamingInvariantKind } from '@core/services/diagnostics/manifest';

const SKELETON_VIOLATION_TO_INVARIANT: Record<SkeletonInvariantViolationKind, StreamingInvariantKind> = {
  'empty-output': 'skeleton_empty_output',
  'no-user-text': 'skeleton_no_user_text',
  'tool-blocks-leaked': 'skeleton_tool_blocks_leaked',
};

const emitSkeletonInvariant = (kind: SkeletonInvariantViolationKind, occurrenceCount: number): void => {
  appendDiagnosticEvent({
    kind: 'streaming_invariant',
    data: {
      violation: SKELETON_VIOLATION_TO_INVARIANT[kind],
      occurrenceCount,
      repaired: false,
    },
  });
};

export const SKELETON_FALLBACK_USER_TEXT =
  '[Context recovery — original prompt unavailable; please re-state your request.]';

type SkeletonBlockLike = {
  type?: unknown;
  text?: unknown;
  content?: unknown;
};

type SkeletonContent<TBlock extends SkeletonBlockLike> = string | readonly TBlock[];

export interface SkeletonStripResult<TMessage> {
  messages: TMessage[];
  droppedToolResultCount: number;
  droppedToolUseCount: number;
  droppedThinkingCount: number;
  droppedImageCount: number;
  userTextPreserved: boolean;
}

export interface StripBlocksForSkeletonOptions<TMessage, TBlock extends SkeletonBlockLike> {
  getRole(message: TMessage): string;
  getContent(message: TMessage): SkeletonContent<TBlock>;
  buildMessage(message: TMessage, content: string | TBlock[]): TMessage;
  buildSentinelMessage(text: string): TMessage;
}

const isTextNonEmpty = (text: string): boolean => text.trim().length > 0;

const blockTypeOf = (block: SkeletonBlockLike): unknown => block.type;

const countImagesInToolResult = (content: unknown): number => {
  if (!Array.isArray(content)) return 0;
  return content.reduce((count, block) => {
    if (!block || typeof block !== 'object') return count;
    return count + (((block as { type?: unknown }).type === 'image') ? 1 : 0);
  }, 0);
};

const hasNonEmptyText = <TBlock extends SkeletonBlockLike>(
  content: SkeletonContent<TBlock>,
): boolean => {
  if (typeof content === 'string') return isTextNonEmpty(content);

  return content.some((block) => (
    block.type === 'text'
    && typeof block.text === 'string'
    && isTextNonEmpty(block.text)
  ));
};

export type SkeletonInvariantViolationKind =
  | 'empty-output'
  | 'no-user-text'
  | 'tool-blocks-leaked';

export class SkeletonOutputInvariantError extends Error {
  readonly kind: SkeletonInvariantViolationKind;

  constructor(kind: SkeletonInvariantViolationKind, message: string) {
    super(message);
    this.name = 'SkeletonOutputInvariantError';
    this.kind = kind;
  }
}

const assertSkeletonOutputInvariant = <TMessage, TBlock extends SkeletonBlockLike>(
  messages: readonly TMessage[],
  options: Pick<StripBlocksForSkeletonOptions<TMessage, TBlock>, 'getRole' | 'getContent'>,
): void => {
  if (messages.length === 0) {
    emitSkeletonInvariant('empty-output', 1);
    throw new SkeletonOutputInvariantError(
      'empty-output',
      'Skeleton invariant violated: output message history is empty.',
    );
  }

  const hasUserText = messages.some((message) => (
    options.getRole(message) === 'user'
    && hasNonEmptyText(options.getContent(message))
  ));
  if (!hasUserText) {
    emitSkeletonInvariant('no-user-text', 1);
    throw new SkeletonOutputInvariantError(
      'no-user-text',
      'Skeleton invariant violated: output must include a user message with non-empty text.',
    );
  }

  const leakedToolBlockCount = messages.reduce((count, message) => {
    const content = options.getContent(message);
    if (!Array.isArray(content)) return count;
    return count + content.filter((block) => (
      block.type === 'tool_use' || block.type === 'tool_result'
    )).length;
  }, 0);
  if (leakedToolBlockCount > 0) {
    emitSkeletonInvariant('tool-blocks-leaked', leakedToolBlockCount);
    throw new SkeletonOutputInvariantError(
      'tool-blocks-leaked',
      'Skeleton invariant violated: output still contains tool_use or tool_result blocks.',
    );
  }
};

export function stripBlocksForSkeleton<TMessage, TBlock extends SkeletonBlockLike>(
  messages: readonly TMessage[],
  options: StripBlocksForSkeletonOptions<TMessage, TBlock>,
): SkeletonStripResult<TMessage> {
  let droppedToolResultCount = 0;
  let droppedToolUseCount = 0;
  let droppedThinkingCount = 0;
  let droppedImageCount = 0;
  const result: TMessage[] = [];

  for (const message of messages) {
    const role = options.getRole(message);
    const content = options.getContent(message);

    if (role === 'user') {
      if (typeof content === 'string') {
        const unwrapped = unwrapCompactionArtifact(content);
        if (isTextNonEmpty(unwrapped)) {
          result.push(options.buildMessage(message, unwrapped));
        }
        continue;
      }

      const kept: TBlock[] = [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const unwrapped = unwrapCompactionArtifact(block.text);
          if (isTextNonEmpty(unwrapped)) {
            kept.push({ ...block, text: unwrapped } as TBlock);
          }
          continue;
        }

        const blockType = blockTypeOf(block);
        if (blockType === 'tool_use') {
          droppedToolUseCount += 1;
          continue;
        }

        if (blockType === 'thinking' || blockType === 'redacted_thinking') {
          droppedThinkingCount += 1;
          continue;
        }

        if (blockType === 'tool_result') {
          droppedToolResultCount += 1;
          droppedImageCount += countImagesInToolResult(block.content);
          continue;
        }

        if (blockType === 'image') {
          droppedImageCount += 1;
          continue;
        }
      }

      if (kept.length > 0) {
        result.push(options.buildMessage(message, kept));
      }
      continue;
    }

    if (typeof content === 'string') {
      if (isTextNonEmpty(content)) {
        result.push(options.buildMessage(message, content));
      }
      continue;
    }

    const kept: TBlock[] = [];
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        if (isTextNonEmpty(block.text)) {
          kept.push(block);
        }
        continue;
      }

      const blockType = blockTypeOf(block);
      if (blockType === 'tool_use') {
        droppedToolUseCount += 1;
        continue;
      }

      if (blockType === 'tool_result') {
        droppedToolResultCount += 1;
        droppedImageCount += countImagesInToolResult(block.content);
        continue;
      }

      if (blockType === 'thinking' || blockType === 'redacted_thinking') {
        droppedThinkingCount += 1;
        continue;
      }

      if (blockType === 'image') {
        droppedImageCount += 1;
        continue;
      }
    }

    if (kept.length > 0) {
      result.push(options.buildMessage(message, kept));
    }
  }

  const userTextPreserved = result.some((message) => (
    options.getRole(message) === 'user'
    && hasNonEmptyText(options.getContent(message))
  ));
  if (!userTextPreserved) {
    result.unshift(options.buildSentinelMessage(SKELETON_FALLBACK_USER_TEXT));
  }

  assertSkeletonOutputInvariant(result, options);

  return {
    messages: result,
    droppedToolResultCount,
    droppedToolUseCount,
    droppedThinkingCount,
    droppedImageCount,
    userTextPreserved,
  };
}

type AgentTurnMessageWithContent = AgentTurnMessage & {
  content?: string | SkeletonBlockLike[];
};

const getAgentTurnSkeletonContent = (
  message: AgentTurnMessage,
): SkeletonContent<SkeletonBlockLike> => {
  const content = (message as AgentTurnMessageWithContent).content;
  return typeof content === 'string' || Array.isArray(content) ? content : message.text;
};

const agentTurnTextFromSkeletonContent = (
  content: string | SkeletonBlockLike[],
): string => {
  if (typeof content === 'string') return content;

  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .filter(isTextNonEmpty)
    .join('\n\n');
};

export function stripAgentTurnMessagesForSkeleton(
  messages: readonly AgentTurnMessage[],
): SkeletonStripResult<AgentTurnMessage> {
  const firstMessage = messages[0];
  const fallbackTurnId = firstMessage?.turnId ?? 'recovery-skeleton';

  return stripBlocksForSkeleton<AgentTurnMessage, SkeletonBlockLike>(messages, {
    getRole: (message) => message.role,
    getContent: getAgentTurnSkeletonContent,
    buildMessage: (message, content) => {
      const clone: AgentTurnMessageWithContent = { ...message };
      delete clone.content;
      return {
        ...clone,
        text: agentTurnTextFromSkeletonContent(content),
      };
    },
    buildSentinelMessage: (text) => ({
      id: `${fallbackTurnId}-sentinel`,
      turnId: fallbackTurnId,
      role: 'user',
      text,
      createdAt: firstMessage?.createdAt ?? 0,
    }),
  });
}
