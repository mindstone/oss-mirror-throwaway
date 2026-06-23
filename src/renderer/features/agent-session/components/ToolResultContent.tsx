import { useMemo } from 'react';
import { Button } from '@renderer/components/ui';
import { useContentHydration } from '@renderer/hooks/useContentHydration';
import { normalizeContentResolutionReason } from '@core/types/contentResolutionReason';
import type { ContentRef } from '@shared/types/agent';

export interface ToolResultContentProps {
  sessionId: string;
  contentRef: ContentRef;
  fallbackSummary?: string;
}

function reasonToHumanLabel(reason: string): string {
  const normalized = normalizeContentResolutionReason(reason);
  switch (normalized) {
    case 'pending-upload':
      return 'Still uploading...';
    case 'missing':
      return 'Tool output not found';
    case 'fetch-failed':
      return "Couldn't load tool output";
    case 'truncated-for-budget':
      return 'Tool output unavailable';
    default:
      return 'Tool output unavailable';
  }
}

function truncateSummary(summary: string, maxChars: number): string {
  if (summary.length <= maxChars) return summary;
  return `${summary.slice(0, maxChars).trimEnd()}…`;
}

/**
 * `ToolResultContent` — renderer component that surfaces large opaque tool
 * outputs offloaded to the {@link ContentStore} as `content_ref` blocks.
 * Defaults to an inline `summary` preview; the full text is fetched
 * on demand via {@link useContentHydration} so unopened conversations do
 * not pay the IO cost.
 *
 * Failure states render a structured tile (never empty) so the silent-drop
 * class is impossible by construction.
 *
 * @see docs/plans/260518_cloud_sync_reconciliation_hardening.md § Stage B1b
 */
export function ToolResultContent({ sessionId, contentRef, fallbackSummary }: ToolResultContentProps) {
  const { state, hydrate, reset } = useContentHydration({ sessionId, contentRef });

  const previewText = useMemo(() => {
    const source = fallbackSummary || contentRef.summary || '';
    return truncateSummary(source, 500);
  }, [contentRef.summary, fallbackSummary]);

  if (state.kind === 'success') {
    return (
      <div className="rebel-tool-result-content rebel-tool-result-content--success">
        <pre className="whitespace-pre-wrap text-xs leading-relaxed">{state.text}</pre>
        <div className="mt-1 flex items-center gap-2 text-[10px] text-[color:var(--color-muted-foreground)]">
          <span>{Math.round(state.byteSize / 1024)} kb · {state.mimeType}</span>
          <Button variant="ghost" size="xs" onClick={reset}>Collapse</Button>
        </div>
      </div>
    );
  }

  if (state.kind === 'loading') {
    return (
      <div
        className="rebel-tool-result-content rebel-tool-result-content--loading"
        role="status"
        aria-live="polite"
        data-testid="tool-result-content-loading"
      >
        <div className="animate-pulse space-y-2">
          <div className="h-2 w-48 rounded bg-[color:var(--color-border)]" />
          <div className="h-2 w-64 rounded bg-[color:var(--color-border)]" />
          <div className="h-2 w-40 rounded bg-[color:var(--color-border)]" />
        </div>
      </div>
    );
  }

  if (state.kind === 'failed') {
    const label = reasonToHumanLabel(state.reason);
    const normalized = normalizeContentResolutionReason(state.reason);
    const canRetry = normalized === 'pending-upload' || normalized === 'fetch-failed';
    return (
      <div
        className="rebel-tool-result-content rebel-tool-result-content--failed text-xs"
        data-testid="tool-result-content-failure"
      >
        <div className="text-[color:var(--color-destructive)]">{label}</div>
        {previewText ? (
          <div className="mt-1 line-clamp-3 text-[color:var(--color-muted-foreground)]">{previewText}</div>
        ) : null}
        {canRetry ? (
          <Button variant="ghost" size="xs" className="mt-1" onClick={() => void hydrate()}>
            Try again
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rebel-tool-result-content rebel-tool-result-content--idle text-xs">
      {previewText ? (
        <div className="line-clamp-6 text-[color:var(--color-muted-foreground)]">{previewText}</div>
      ) : (
        <div className="text-[color:var(--color-muted-foreground)]">
          {Math.round(contentRef.byteSize / 1024)} kb of {contentRef.mimeType} output
        </div>
      )}
      <Button variant="ghost" size="xs" className="mt-1" onClick={() => void hydrate()}>
        Show full output
      </Button>
    </div>
  );
}
