import { useId, useState } from 'react';
import { Activity, AlertTriangle, ChevronDown, ChevronRight, Info } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import { getFriendlyEventDisplay } from '@core/services/diagnostics/diagnosticEventDisplay';
import type { DiagnosticEventEntry } from '@shared/diagnostics/recentDiagnosticContext';
import styles from '../SettingsSurface.module.css';

export interface DiagnosticEventRowProps {
  event: DiagnosticEventEntry;
}

export function DiagnosticEventRow({ event }: DiagnosticEventRowProps) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const display = getFriendlyEventDisplay(
    event as unknown as Parameters<typeof getFriendlyEventDisplay>[0],
  );
  const Icon = display.tone === 'info' ? Info : display.tone === 'success' ? Activity : AlertTriangle;

  return (
    <div role="listitem" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className={styles.activityEntry}>
        <span
          className={styles.activityEntryIcon}
          style={{ color: toneColor(display.tone) }}
          aria-hidden="true"
        >
          <Icon size={16} />
        </span>
        <div className={styles.activityEntryContent}>
          <span className={styles.activityEntrySummary}>{display.summary}</span>
          <span className={styles.activityEntryMeta}>
            {display.displayKind}
            <span className={styles.activityEntryBadge}>{event.surface}</span>
            {event.tid ? <span>turn {event.tid}</span> : null}
          </span>
        </div>
        <span className={styles.activityEntryTimestamp}>{formatRelativeTime(event.ts)}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {expanded ? 'Hide details' : 'Show details'}
        </Button>
      </div>
      {expanded ? (
        <div
          id={detailsId}
          role="region"
          aria-label={`Raw diagnostic event: ${event.kind}`}
          style={{
            marginLeft: 32,
            padding: 12,
            border: '1px solid var(--color-border-soft)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-background-subtle)',
          }}
        >
          <p className={styles.diagInfoText} style={{ marginBottom: 8 }}>
            Raw kind: {event.kind}
          </p>
          <pre
            style={{
              margin: 0,
              maxHeight: 220,
              overflow: 'auto',
              fontFamily: 'var(--font-family-mono)',
              fontSize: 12,
              whiteSpace: 'pre-wrap',
            }}
          >
            <code>{JSON.stringify(event, null, 2)}</code>
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function toneColor(tone: ReturnType<typeof getFriendlyEventDisplay>['tone']): string {
  switch (tone) {
    case 'destructive':
      return 'var(--color-destructive)';
    case 'warning':
      return 'var(--color-warning)';
    case 'success':
      return 'var(--color-success)';
    case 'info':
      return 'var(--color-text-muted)';
    default: {
      const unhandled: never = tone;
      return unhandled;
    }
  }
}
