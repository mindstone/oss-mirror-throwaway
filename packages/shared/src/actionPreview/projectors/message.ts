import type {
  ActionPreviewInput,
  ActionPreviewModel,
  BlastRadiusChip,
  GenericStructuredRow,
  Reversibility,
  RiskReason,
  StagedToolActionPreviewInput,
  ToolActionPreviewInput,
} from '../model';
import { projectGenericStructured } from './generic';

const SLACK_CHANNEL_ID_RE = /^[CG][A-Z0-9]+$/i;
const SLACK_DM_CHANNEL_ID_RE = /^D[A-Z0-9]+$/i;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]+$/i;
const SLACK_DM_HINT_RE = /(open[_-]?slack[_-]?dm|slack[\s_-]+(direct[\s_-]+message|dm))/i;
const SLACK_MESSAGE_HINT_RE = /(post|send|chat)[\s_-].*message/i;
const EMAIL_HINT_RE = /\b(email|gmail|outlook|mail)\b/i;
const MAX_MESSAGE_BODY_LENGTH = 4096;
const MAX_MESSAGE_BLOCKS_LENGTH = 8192;

type MessageKind = 'slack-channel' | 'slack-dm' | 'email';

function chip(label: string, evidence: BlastRadiusChip['evidence'] = 'explicit'): BlastRadiusChip {
  return { label, evidence };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Reads the email `is_html` / `isHtml` tool arg (snake_case and camelCase
 * aliases both occur upstream). Accepts a boolean or the string forms
 * "true"/"false" that some tool callers emit. Defaults to false (plain text).
 */
function readHtmlFlag(sourceArgs: Record<string, unknown>): boolean {
  const raw = sourceArgs.is_html ?? sourceArgs.isHtml;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  return false;
}

export function normalizeSlackUserId(value: unknown): string | null {
  const raw = toNonEmptyString(value);
  if (!raw) return null;
  const mention = raw.match(/^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/i);
  const candidate = (mention?.[1] ?? raw).toUpperCase();
  return SLACK_USER_ID_RE.test(candidate) ? candidate : null;
}

function isSlackLike(input: ToolActionPreviewInput | StagedToolActionPreviewInput): boolean {
  const text = [
    input.packageId ?? '',
    input.reason ?? '',
    input.kind === 'tool' ? `${input.effectiveToolId ?? ''} ${input.toolName}` : `${input.toolId} ${input.displayName ?? ''}`,
  ].join(' ');
  return /\bslack\b/i.test(text);
}

function isEmailLike(input: ToolActionPreviewInput | StagedToolActionPreviewInput): boolean {
  const text = [
    input.packageId ?? '',
    input.reason ?? '',
    input.kind === 'tool' ? `${input.effectiveToolId ?? ''} ${input.toolName}` : `${input.toolId} ${input.displayName ?? ''}`,
  ].join(' ');
  return EMAIL_HINT_RE.test(text);
}

function hasAnyArgKey(args: Record<string, unknown>, keys: readonly string[]): boolean {
  const lowerKeys = Object.keys(args).map((key) => key.toLowerCase());
  return keys.some((key) => lowerKeys.includes(key));
}

function hasSlackChannelArg(args: Record<string, unknown>): boolean {
  return typeof args.channel === 'string'
    || typeof args.channelId === 'string'
    || typeof args.channel_id === 'string';
}

function hasSlackDmSignal(input: ToolActionPreviewInput | StagedToolActionPreviewInput, args: Record<string, unknown>): boolean {
  const channel = toNonEmptyString(args.channel ?? args.channelId ?? args.channel_id);
  const searchable = input.kind === 'tool'
    ? `${input.effectiveToolId ?? ''} ${input.toolName} ${input.reason ?? ''}`
    : `${input.toolId} ${input.displayName ?? ''} ${input.reason ?? ''}`;
  const hasRecipientArg = normalizeSlackUserId(args.user)
    || normalizeSlackUserId(args.user_id)
    || normalizeSlackUserId(args.userId)
    || normalizeSlackUserId(args.intended_recipient)
    || normalizeSlackUserId(args.intendedRecipient)
    || normalizeSlackUserId(args.recipient_user_id)
    || normalizeSlackUserId(args.recipientUserId);

  return Boolean(
    (channel && SLACK_DM_CHANNEL_ID_RE.test(channel))
    || hasRecipientArg
    || SLACK_DM_HINT_RE.test(searchable),
  );
}

function hasSlackMessageShape(args: Record<string, unknown>): boolean {
  return hasAnyArgKey(args, ['channel', 'channel_id', 'channelId', 'user', 'user_id', 'userId', 'text', 'blocks']);
}

function hasEmailMessageShape(args: Record<string, unknown>): boolean {
  return hasAnyArgKey(args, ['to', 'recipient', 'email', 'subject', 'body', 'html', 'text', 'message']);
}

export function detectMessageKind(input: ToolActionPreviewInput | StagedToolActionPreviewInput): MessageKind | null {
  const args = asRecord(input.args);

  if (isSlackLike(input)) {
    const searchable = input.kind === 'tool'
      ? `${input.effectiveToolId ?? ''} ${input.toolName} ${input.reason ?? ''}`
      : `${input.toolId} ${input.displayName ?? ''} ${input.reason ?? ''}`;
    if (hasSlackDmSignal(input, args)) {
      return 'slack-dm';
    }
    if (hasSlackChannelArg(args) || hasSlackMessageShape(args) || SLACK_MESSAGE_HINT_RE.test(searchable)) {
      return 'slack-channel';
    }
  }

  if (isEmailLike(input) && hasEmailMessageShape(args)) {
    return 'email';
  }

  return null;
}

function normalizeResolvedName(name: string | undefined): string | null {
  const resolved = toNonEmptyString(name);
  if (!resolved) return null;
  const stripped = resolved.replace(/^#+/, '').trim();
  return stripped.length > 0 ? stripped : null;
}

function sanitizeSlackScalar(
  value: string,
  resolvedRecipientLabel: string | null,
  resolvedChannelName: string | null,
): string {
  const trimmed = value.trim();
  if (SLACK_CHANNEL_ID_RE.test(trimmed)) {
    return resolvedChannelName ? `#${resolvedChannelName}` : 'Slack channel';
  }
  if (SLACK_DM_CHANNEL_ID_RE.test(trimmed)) {
    return 'Direct message';
  }
  if (normalizeSlackUserId(trimmed)) {
    return resolvedRecipientLabel ?? 'Direct message recipient';
  }
  return value;
}

function sanitizeSlackValues(
  value: unknown,
  resolvedRecipientLabel: string | null,
  resolvedChannelName: string | null,
): unknown {
  if (typeof value === 'string') {
    return sanitizeSlackScalar(value, resolvedRecipientLabel, resolvedChannelName);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeSlackValues(entry, resolvedRecipientLabel, resolvedChannelName));
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      out[key] = sanitizeSlackValues(entry, resolvedRecipientLabel, resolvedChannelName);
    }
    return out;
  }
  return value;
}

function readTextValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function truncateMessageValue(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

function readMessageBody(value: unknown, limit: number = MAX_MESSAGE_BODY_LENGTH): string | null {
  const direct = readTextValue(value);
  if (direct) return truncateMessageValue(direct, limit);
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    const serialized = JSON.stringify(value);
    if (!serialized) return null;
    return truncateMessageValue(serialized, limit);
  }
  return null;
}

function readEmailRecipientList(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.split(',').map((part) => part.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => readEmailRecipientList(entry));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const direct = readTextValue(record.email)
      ?? readTextValue(record.address)
      ?? readTextValue(record.value)
      ?? readTextValue(record.name);
    return direct ? [direct] : [];
  }
  return [];
}

function recipientCountLabel(count: number): string {
  return count === 1 ? '1 recipient' : `${count} recipients`;
}

function buildMessageRows(
  kind: MessageKind,
  sourceArgs: Record<string, unknown>,
  contentVisibility: ActionPreviewModel['contentVisibility'],
): GenericStructuredRow[] {
  if (contentVisibility !== 'safe') return [];

  const rows: GenericStructuredRow[] = [];
  if (kind === 'email') {
    const subject = readMessageBody(sourceArgs.subject);
    if (subject) rows.push({ key: 'subject', value: subject });
    const body = readMessageBody(
      sourceArgs.body ?? sourceArgs.text ?? sourceArgs.message ?? sourceArgs.html,
      MAX_MESSAGE_BODY_LENGTH,
    );
    if (body) {
      // The `html` arg alias is always HTML; otherwise honour the explicit
      // is_html / isHtml flag. The renderer sanitizes HTML before display.
      const isHtml = sourceArgs.body == null
        && sourceArgs.text == null
        && sourceArgs.message == null
        && sourceArgs.html != null
        ? true
        : readHtmlFlag(sourceArgs);
      rows.push({ key: 'body', value: body, isHtml });
    }
    return rows;
  }

  const text = readMessageBody(
    sourceArgs.text ?? sourceArgs.message ?? sourceArgs.body,
    MAX_MESSAGE_BODY_LENGTH,
  );
  if (text) rows.push({ key: 'text', value: text });
  const blocks = readMessageBody(sourceArgs.blocks, MAX_MESSAGE_BLOCKS_LENGTH);
  if (blocks) rows.push({ key: 'blocks', value: blocks });
  return rows;
}

function buildMessageSafeRawArgs(
  kind: MessageKind,
  sourceArgs: Record<string, unknown>,
  baseSafeRawArgs: Record<string, unknown>,
  contentVisibility: ActionPreviewModel['contentVisibility'],
): Record<string, unknown> {
  if (contentVisibility !== 'safe') return baseSafeRawArgs;

  const messageSafeRawArgs: Record<string, unknown> = {};
  if (kind === 'email') {
    const subject = readMessageBody(sourceArgs.subject);
    if (subject) messageSafeRawArgs.subject = subject;
    const body = readMessageBody(
      sourceArgs.body ?? sourceArgs.text ?? sourceArgs.message ?? sourceArgs.html,
      MAX_MESSAGE_BODY_LENGTH,
    );
    if (body) messageSafeRawArgs.body = body;
  } else {
    const text = readMessageBody(
      sourceArgs.text ?? sourceArgs.message ?? sourceArgs.body,
      MAX_MESSAGE_BODY_LENGTH,
    );
    if (text) messageSafeRawArgs.text = text;
    const blocks = readMessageBody(sourceArgs.blocks, MAX_MESSAGE_BLOCKS_LENGTH);
    if (blocks) messageSafeRawArgs.blocks = blocks;
  }

  if (Object.keys(messageSafeRawArgs).length === 0) {
    return baseSafeRawArgs;
  }
  return {
    ...baseSafeRawArgs,
    ...messageSafeRawArgs,
  };
}

export function projectMessage(input: ActionPreviewInput): ActionPreviewModel {
  const base = projectGenericStructured(input, 'message');
  if (input.kind !== 'tool' && input.kind !== 'staged-tool') {
    return base;
  }

  const messageKind = detectMessageKind(input);
  if (!messageKind) {
    return base;
  }

  const args = asRecord(input.args);
  const resolvedRecipientLabel = toNonEmptyString(input.resolvedRecipientLabel);
  const resolvedChannelName = normalizeResolvedName(input.resolvedChannelName);
  const sanitizedSourceArgs = messageKind.startsWith('slack')
    ? asRecord(sanitizeSlackValues(args, resolvedRecipientLabel, resolvedChannelName))
    : args;

  const sanitizedSafeRawArgs = messageKind.startsWith('slack')
    ? asRecord(sanitizeSlackValues(base.safeRawArgs, resolvedRecipientLabel, resolvedChannelName))
    : base.safeRawArgs;
  const messageSafeRawArgs = buildMessageSafeRawArgs(
    messageKind,
    sanitizedSourceArgs,
    sanitizedSafeRawArgs,
    base.contentVisibility,
  );

  const where: BlastRadiusChip[] = [];
  const whoCanSeeIt: BlastRadiusChip[] = [];
  const afterwards: BlastRadiusChip[] = [];
  const riskReasons: RiskReason[] = [];
  let reversibility: Reversibility | null = null;
  let title = 'Send message';

  if (messageKind === 'slack-dm') {
    const destination = resolvedRecipientLabel ?? 'Direct message';
    where.push(chip(destination, resolvedRecipientLabel ? 'explicit' : 'derived'));
    if (resolvedRecipientLabel) {
      whoCanSeeIt.push(chip(`Just ${resolvedRecipientLabel}`));
    }
    reversibility = 'Can edit after posting';
    afterwards.push(chip(reversibility, 'derived'));
    riskReasons.push('Leaves Rebel');
    title = 'Send Slack message';
  } else if (messageKind === 'slack-channel') {
    const destination = resolvedChannelName ? `#${resolvedChannelName}` : 'Slack channel';
    where.push(chip(destination, resolvedChannelName ? 'explicit' : 'derived'));
    reversibility = 'Can edit after posting';
    afterwards.push(chip(reversibility, 'derived'));
    riskReasons.push('Shared', 'Leaves Rebel');
    title = 'Send Slack message';
  } else {
    const recipients = readEmailRecipientList(args.to ?? args.recipient ?? args.email);
    if (recipients.length > 0) {
      where.push(chip(recipients.join(', ')));
      whoCanSeeIt.push(chip(recipientCountLabel(recipients.length), 'derived'));
    }
    reversibility = 'Hard to undo';
    afterwards.push(chip(reversibility, 'derived'));
    riskReasons.push('Leaves Rebel');
    title = 'Send email';
  }

  return {
    ...base,
    title,
    blastRadius: { where, whoCanSeeIt, afterwards },
    reversibility,
    riskReasons: Array.from(new Set(riskReasons)),
    structuredArgs: buildMessageRows(messageKind, sanitizedSourceArgs, base.contentVisibility),
    safeRawArgs: messageSafeRawArgs,
  };
}
