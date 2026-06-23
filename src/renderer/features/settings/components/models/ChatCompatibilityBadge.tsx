import { AlertTriangle, CircleCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Tooltip } from '@renderer/components/ui';

export type ChatCompatibility = 'compatible' | 'incompatible' | 'unknown';

export interface ChatCompatibilityBadgeProps {
  compatibility?: ChatCompatibility;
  /** ISO timestamp of the last check. */
  checkedAt?: string;
  /** JSON-structured output compatibility verdict. */
  jsonCompatibility?: ChatCompatibility;
  /** ISO timestamp of the last JSON capability check. */
  jsonCheckedAt?: string;
  /** Reasoning/thinking support verdict. */
  thinkingCompatibility?: ChatCompatibility;
  /** ISO timestamp of the last thinking capability check. */
  thinkingCheckedAt?: string;
  /** Tool-use (function calling) compatibility verdict. */
  toolUseCompatibility?: ChatCompatibility;
  /** ISO timestamp of the last tool-use capability check. */
  toolUseCheckedAt?: string;
  /** Optional className hook so parents can swap to icon-only at narrow widths. */
  className?: string;
}

/**
 * Read-only status pill indicating whether a profile has been verified to
 * respond as a chat model.
 *
 * - `compatible`   → green "Works" pill with a check icon.
 * - `incompatible` → red "Not compatible" pill with a warning triangle.
 * - `unknown` / undefined → renders nothing.
 *
 * The pill text is always rendered; parents that need an icon-only fallback at
 * narrow widths pass a className that hides the label via CSS.
 */
export const ChatCompatibilityBadge = ({
  compatibility,
  checkedAt,
  jsonCompatibility,
  jsonCheckedAt,
  thinkingCompatibility,
  thinkingCheckedAt,
  toolUseCompatibility,
  toolUseCheckedAt,
  className,
}: ChatCompatibilityBadgeProps) => {
  const chatBadge = renderChatBadge({ compatibility, checkedAt, className });
  const jsonBadge = renderJsonBadge({ jsonCompatibility, jsonCheckedAt, className });
  const thinkingBadge = renderThinkingBadge({ thinkingCompatibility, thinkingCheckedAt, className });
  const toolUseBadge = renderToolUseBadge({ toolUseCompatibility, toolUseCheckedAt, className });
  if (!chatBadge && !jsonBadge && !thinkingBadge && !toolUseBadge) return null;

  return (
    <>
      {chatBadge}
      {toolUseBadge}
      {jsonBadge}
      {thinkingBadge}
    </>
  );
};

function renderChatBadge({
  compatibility,
  checkedAt,
  className,
}: Pick<ChatCompatibilityBadgeProps, 'compatibility' | 'checkedAt' | 'className'>): ReactNode {
  if (!compatibility || compatibility === 'unknown') return null;

  if (compatibility === 'compatible') {
    const tooltip = checkedAt
      ? `Last tested ${formatRelative(checkedAt)}`
      : 'Verified to respond as a chat model.';
    return (
      <Tooltip content={tooltip}>
        <Badge variant="success" size="sm" className={className}>
          <CircleCheck size={12} aria-hidden="true" />
          <span>Works</span>
        </Badge>
      </Tooltip>
    );
  }

  const incompatibleTooltip =
    "This model didn't respond like a chat model. Re-test or pick a different one.";
  return (
    <Tooltip content={incompatibleTooltip}>
      <Badge variant="destructive" size="sm" className={className}>
        <AlertTriangle size={12} aria-hidden="true" />
        <span>Not compatible</span>
      </Badge>
    </Tooltip>
  );
}

function renderJsonBadge({
  jsonCompatibility,
  jsonCheckedAt,
  className,
}: Pick<ChatCompatibilityBadgeProps, 'jsonCompatibility' | 'jsonCheckedAt' | 'className'>): ReactNode {
  if (!jsonCompatibility || jsonCompatibility === 'unknown') return null;

  if (jsonCompatibility === 'compatible') {
    const tooltip = jsonCheckedAt
      ? `Produces structured JSON responses. Tested ${formatRelative(jsonCheckedAt)}.`
      : 'Produces structured JSON responses.';
    return (
      <Tooltip content={tooltip}>
        <Badge variant="success" size="sm" className={className}>
          <CircleCheck size={12} aria-hidden="true" />
          <span>JSON</span>
        </Badge>
      </Tooltip>
    );
  }

  return (
    <Tooltip content="This model can't produce structured JSON. Some background tasks need JSON and will use a fallback model.">
      <Badge variant="warning" size="sm" className={className}>
        <AlertTriangle size={12} aria-hidden="true" />
        <span>No JSON</span>
      </Badge>
    </Tooltip>
  );
}

function renderThinkingBadge({
  thinkingCompatibility,
  thinkingCheckedAt,
  className,
}: Pick<ChatCompatibilityBadgeProps, 'thinkingCompatibility' | 'thinkingCheckedAt' | 'className'>): ReactNode {
  if (!thinkingCompatibility || thinkingCompatibility === 'unknown') return null;

  if (thinkingCompatibility === 'compatible') {
    const tooltip = thinkingCheckedAt
      ? `Supports reasoning/thinking levels. Tested ${formatRelative(thinkingCheckedAt)}.`
      : 'Supports reasoning/thinking levels.';
    return (
      <Tooltip content={tooltip}>
        <Badge variant="success" size="sm" className={className}>
          <CircleCheck size={12} aria-hidden="true" />
          <span>Thinking</span>
        </Badge>
      </Tooltip>
    );
  }

  return (
    <Tooltip content="Rebel isn't sending a thinking level to this model — a test found that it (or the gateway it runs through) rejects Rebel's thinking setting. If you fix the gateway, re-test to turn thinking back on.">
      <Badge variant="warning" size="sm" className={className}>
        <AlertTriangle size={12} aria-hidden="true" />
        <span>No Thinking</span>
      </Badge>
    </Tooltip>
  );
}

function renderToolUseBadge({
  toolUseCompatibility,
  toolUseCheckedAt,
  className,
}: Pick<ChatCompatibilityBadgeProps, 'toolUseCompatibility' | 'toolUseCheckedAt' | 'className'>): ReactNode {
  if (!toolUseCompatibility || toolUseCompatibility === 'unknown') return null;

  if (toolUseCompatibility === 'compatible') {
    const tooltip = toolUseCheckedAt
      ? `Supports tool use (function calling). Tested ${formatRelative(toolUseCheckedAt)}.`
      : 'Supports tool use (function calling).';
    return (
      <Tooltip content={tooltip}>
        <Badge variant="success" size="sm" className={className}>
          <CircleCheck size={12} aria-hidden="true" />
          <span>Tools</span>
        </Badge>
      </Tooltip>
    );
  }

  return (
    <Tooltip content="This model doesn't support tool use (function calling). Rebel needs tool use to work — pick a different model.">
      <Badge variant="destructive" size="sm" className={className}>
        <AlertTriangle size={12} aria-hidden="true" />
        <span>No Tools</span>
      </Badge>
    </Tooltip>
  );
}

/** Short, locale-friendly "x minutes ago" formatter. Falls back to ISO on error. */
function formatRelative(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return iso;
    const delta = Date.now() - then;
    if (delta < 60_000) return 'just now';
    if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
    if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
    return `${Math.round(delta / 86_400_000)}d ago`;
  } catch {
    return iso;
  }
}
