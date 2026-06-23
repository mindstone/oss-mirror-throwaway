import { z } from 'zod';
import { createScopedLogger, type Logger } from '@core/logger';
import type { AppSettings } from '@shared/types';

export const SLACK_MESSAGE_METADATA_MAX_BYTES = 1024;

export const SlackMessageMetadataPayloadSchema = z.object({
  agentInstanceId: z.string().optional(),
  ownerUserId: z.string().optional(),
  threadScope: z.string().optional(),
}).passthrough();

export const SlackMessageMetadataSchema = z.object({
  event_type: z.string(),
  event_payload: SlackMessageMetadataPayloadSchema,
}).passthrough();

export type SlackMessageMetadata = z.infer<typeof SlackMessageMetadataSchema>;

export type SlackOutboundMetadataIntent =
  | 'thread_reply'
  | 'thread_open'
  | 'dm_reply';

export interface SlackOutboundMetadataContext {
  settings: Pick<AppSettings, 'experimental'> | null | undefined;
  workspace: {
    authedUserId?: string | null;
    teamId?: string | null;
  } | null | undefined;
  threadScope?: string | null;
  log?: Pick<Logger, 'warn'>;
}

const log = createScopedLogger({ service: 'slackOutboundMetadata' });

const EVENT_TYPE_BY_INTENT: Record<SlackOutboundMetadataIntent, string> = {
  thread_reply: 'rebel_thread_reply',
  thread_open: 'rebel_thread_open',
  dm_reply: 'rebel_dm_reply',
};

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getMetadataSizeBytes(metadata: SlackMessageMetadata): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(metadata), 'utf8');
  } catch {
    return null;
  }
}

export function buildOutboundMetadata(
  intent: SlackOutboundMetadataIntent,
  context: SlackOutboundMetadataContext,
): SlackMessageMetadata | null {
  const metadataLog = context.log ?? log;
  const agentInstanceId = normalizeNonEmptyString(context.settings?.experimental?.agentInstanceId);

  if (!agentInstanceId) {
    metadataLog.warn(
      {
        intent,
        eventType: EVENT_TYPE_BY_INTENT[intent],
      },
      'slack_outbound_metadata_missing_agent_instance_id',
    );
    return null;
  }

  const ownerUserId = normalizeNonEmptyString(context.workspace?.authedUserId);
  const threadScope = normalizeNonEmptyString(context.threadScope);
  const metadata = {
    event_type: EVENT_TYPE_BY_INTENT[intent],
    event_payload: {
      agentInstanceId,
      ...(ownerUserId ? { ownerUserId } : {}),
      ...(threadScope ? { threadScope } : {}),
    },
  } satisfies SlackMessageMetadata;

  const parsed = SlackMessageMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    metadataLog.warn(
      {
        intent,
        issues: parsed.error.issues.map((issue) => issue.path.join('.')),
      },
      'slack_outbound_metadata_schema_invalid',
    );
    return null;
  }

  const metadataBytes = getMetadataSizeBytes(parsed.data);
  if (metadataBytes == null) {
    metadataLog.warn(
      {
        intent,
        eventType: parsed.data.event_type,
      },
      'slack_outbound_metadata_non_serializable',
    );
    return null;
  }

  if (metadataBytes > SLACK_MESSAGE_METADATA_MAX_BYTES) {
    metadataLog.warn(
      {
        intent,
        eventType: parsed.data.event_type,
        metadataBytes,
        maxBytes: SLACK_MESSAGE_METADATA_MAX_BYTES,
      },
      'slack_outbound_metadata_oversize',
    );
    return null;
  }

  return parsed.data;
}
