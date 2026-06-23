// ExternalContext schema lives in @rebel/shared (the cross-runtime npm-style package)
// because it's consumed across desktop, cloud, mobile, and web-companion. Moving this
// back into src/shared/ would break the cloud Docker build (the web-companion bundle's
// walk-up path doesn't reach a node_modules/zod from src/shared/...). See:
//   docs/plans/260506_fix_ci_failures_round2.md
//   docs/plans/260502_unified_external_conversation_architecture.md (architecture context)
import { z } from 'zod';

export const BrowserTabContext = z.object({
  kind: z.literal('browser-tab'),
  identity: z.object({
    tabId: z.number(),
    origin: z.string(),
    pathname: z.string(),
  }),
  metadata: z.object({
    url: z.string(),
    title: z.string().optional(),
    search: z.string().optional(),
    hash: z.string().optional(),
    windowId: z.number().optional(),
  }),
});

export const OfficeDocumentContext = z.object({
  kind: z.literal('office-document'),
  identity: z.object({
    host: z.string(),
    docId: z.string(),
  }),
  metadata: z.object({
    title: z.string().optional(),
    url: z.string().optional(),
  }),
});

export const SlackChannelTypeSchema = z.enum(['channel', 'group', 'im', 'mpim']);
export type SlackChannelType = z.infer<typeof SlackChannelTypeSchema>;

export interface SlackThreadContextMetadata {
  userName: string | null;
  channelName: string | null;
  teamName: string | null;
  permalink: string | null;
  userId?: string;
  userDisplayName?: string | null;
  digestFilteredCount?: number;
  channelType?: SlackChannelType;
}

export const SlackContextMetadata = z.object({
  userId: z.string().optional(),
  userDisplayName: z.string().nullable().optional(),
  userName: z.string().nullable().optional(),
  channelName: z.string().nullable().optional(),
  teamName: z.string().nullable().optional(),
  permalink: z.string().url().nullable().optional(),
  digestFilteredCount: z.number().int().nonnegative().optional(),
  channelType: SlackChannelTypeSchema.optional(),
});

export const SlackThreadContext = z.object({
  kind: z.literal('slack-thread'),
  identity: z.object({
    teamId: z.string(),
    channelId: z.string(),
    threadTs: z.string(),
  }),
  metadata: SlackContextMetadata,
});

export const SlackMentionPollContext = z.object({
  kind: z.literal('slack-mention-poll'),
  identity: z.object({
    teamId: z.string(),
    channelId: z.string(),
    threadTs: z.string(),
    mentionEventId: z.string(),
  }),
  metadata: SlackContextMetadata,
});

export const ExternalContext = z.discriminatedUnion('kind', [
  BrowserTabContext,
  OfficeDocumentContext,
  SlackThreadContext,
  SlackMentionPollContext,
]);

export type BrowserTabContext = z.infer<typeof BrowserTabContext>;
export type OfficeDocumentContext = z.infer<typeof OfficeDocumentContext>;
export type SlackThreadContext = z.infer<typeof SlackThreadContext>;
export type SlackMentionPollContext = z.infer<typeof SlackMentionPollContext>;
export type ExternalContext = z.infer<typeof ExternalContext>;

/**
 * Map an `ExternalContext` to the `SessionOrigin` that should be attributed
 * when broadcasting / starting a conversation seeded by that context. Slack
 * inbound stays on `inbound-trigger`; legacy browser-extension keeps its own
 * origin; office-document inherits the caller's origin (`undefined`).
 *
 * Single source of truth so all broadcast sites (externalConversationService,
 * agentTurnSubmissionService, slackWebhook replays) stay aligned.
 */
export function getOriginForExternalContext(
  ctx: ExternalContext,
): 'inbound-trigger' | 'browser-extension' | undefined {
  switch (ctx.kind) {
    case 'slack-thread':
    case 'slack-mention-poll':
      return 'inbound-trigger';
    case 'browser-tab':
      return 'browser-extension';
    case 'office-document':
      return undefined;
  }
}

/**
 * Single canonical projector. Adapters MUST NOT compute scope keys ad hoc.
 */
export function deriveScopeKey(ctx: ExternalContext): string {
  switch (ctx.kind) {
    case 'browser-tab':
      return `${ctx.kind}:${ctx.identity.tabId}:${ctx.identity.origin}:${ctx.identity.pathname}`;
    case 'office-document':
      return `${ctx.kind}:${ctx.identity.host}:${ctx.identity.docId}`;
    case 'slack-thread':
      return `${ctx.kind}:${ctx.identity.teamId}:${ctx.identity.channelId}:${ctx.identity.threadTs}`;
    case 'slack-mention-poll':
      return `${ctx.kind}:${ctx.identity.mentionEventId}`;
  }
}
