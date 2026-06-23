/**
 * EmptyState — the welcome surface shown before the first message (Stage 4).
 *
 * Captures the active tab's title/URL on mount and shows them as a subtle
 * context chip so the user can see what this conversation will be grounded
 * in. The chip renders gracefully when `chrome.tabs.query` is unavailable
 * (e.g. in tests) or the active tab has no accessible URL.
 *
 * Stage 4 is the shell — Stage 6 wires the real conversation start flow
 * using this same tab context.
 *
 * @see docs/plans/260421_embedded_chat_in_extension.md (Stage 4)
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { buildEmptyStateViewModel } from '@rebel/shared/chatUI';

interface PageContextSnapshot {
  title?: string;
  url?: string;
  fallbackTitle?: string;
}

interface EmptyStateProps {
  context?: PageContextSnapshot | null;
}

function PageIcon(): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
    </svg>
  );
}

async function capturePageContext(): Promise<PageContextSnapshot | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab) return null;
    const title = typeof tab.title === 'string' ? tab.title.trim() : '';
    const url = typeof tab.url === 'string' ? tab.url : '';
    if (!title && !url) return null;
    let host = '';
    try {
      if (url) host = new URL(url).host;
    } catch {
      host = '';
    }
    return {
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
      ...(host ? { fallbackTitle: host } : {}),
    };
  } catch {
    return null;
  }
}

export default function EmptyState({ context: providedContext }: EmptyStateProps = {}): ReactElement {
  const [capturedContext, setCapturedContext] = useState<PageContextSnapshot | null>(null);
  const context = providedContext ?? capturedContext;
  const viewModel = useMemo(
    () =>
      buildEmptyStateViewModel({
        subtitle: "Ask about the page you're on, or anything else you're working on.",
        ...(context?.title ? { pageTitle: context.title } : {}),
        ...(context?.url ? { pageUrl: context.url } : {}),
        ...(context?.fallbackTitle ? { fallbackContextTitle: context.fallbackTitle } : {}),
      }),
    [context],
  );

  useEffect(() => {
    if (providedContext !== undefined) return undefined;
    let cancelled = false;
    void capturePageContext().then((snapshot) => {
      if (!cancelled) setCapturedContext(snapshot);
    });
    return (): void => {
      cancelled = true;
    };
  }, [providedContext]);

  return (
    <div className="empty-state" data-testid="empty-state">
      {viewModel.context && (
        <div
          className="empty-state-context-chip"
          data-testid="empty-state-context-chip"
          title={viewModel.context.tooltip}
        >
          <PageIcon />
          <span className="empty-state-context-chip-text">
            {viewModel.context.primaryText}
          </span>
        </div>
      )}
      <h1 className="empty-state-title">{viewModel.title}</h1>
      {viewModel.subtitle && <p className="empty-state-subtitle">{viewModel.subtitle}</p>}
    </div>
  );
}
