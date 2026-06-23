import { useCallback } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import { Badge, Button, Notice, Spinner } from '@renderer/components/ui';
import { useRecentDiagnosticContext } from '../../hooks/useRecentDiagnosticContext';
import { SettingSection } from '../SettingSection';
import { DiagnosticEventRow } from './DiagnosticEventRow';
import { RawDiagnosticLogsDisclosure } from './RawDiagnosticLogsDisclosure';
import styles from '../SettingsSurface.module.css';

const EMPTY_COPY = 'All quiet. Nothing notable in the last 24 hours.';
const ERROR_COPY = "Couldn't load recent activity. Rebel can keep working, but this view is unavailable right now.";
const READER_UNAVAILABLE_COPY = "Recent activity isn't available on this surface. Rebel can keep working — this view just isn't supported here.";
const LOADING_COPY = 'Checking recent activity...';

export function RecentDiagnosticActivitySection() {
  const {
    status,
    events,
    logs,
    lastFetchedAt,
    refresh,
    copyForSupport,
  } = useRecentDiagnosticContext();

  const handleCopyForSupport = useCallback(() => {
    void copyForSupport();
  }, [copyForSupport]);

  return (
    <SettingSection
      title="Recent activity"
      description="The last few significant events Rebel has flagged. Useful when something feels off."
      data-section="recentActivity"
    >
      <div className={styles.flexColLarge}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div className={styles.flexCenter}>
            <Badge variant="muted" size="sm">Last 24h</Badge>
            <span className={styles.diagInfoText}>
              {lastFetchedAt ? `Last refreshed ${formatRelativeTime(lastFetchedAt)}` : 'Last refreshed —'}
            </span>
          </div>
          <div className={styles.flexCenter}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void refresh()}
              disabled={status === 'loading'}
            >
              <RefreshCw size={14} />
              Refresh
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopyForSupport}
            >
              <Copy size={14} />
              Copy for support
            </Button>
          </div>
        </div>

        {status === 'loading' ? (
          <div className={styles.flexCenter}>
            <Spinner size="sm" />
            <span className={styles.diagInfoText}>{LOADING_COPY}</span>
          </div>
        ) : null}

        {status === 'error' ? (
          <div className={styles.flexColLarge}>
            <Notice tone="warning" density="compact">
              {ERROR_COPY}
            </Notice>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
              style={{ alignSelf: 'flex-start' }}
            >
              Try again
            </Button>
          </div>
        ) : null}

        {status === 'empty' ? (
          <p className={styles.emptyState}>{EMPTY_COPY}</p>
        ) : null}

        {status === 'readerUnavailable' ? (
          <Notice tone="info" density="compact">
            {READER_UNAVAILABLE_COPY}
          </Notice>
        ) : null}

        {status === 'populated' ? (
          <>
            <div role="list" className={styles.activityLogList} aria-label="Recent diagnostic activity">
              {events.map((event, index) => (
                <DiagnosticEventRow
                  // The semantic tuple (kind+ts+tid+sid) is not unique: two events
                  // of the same kind in the same millisecond with no tid/sid
                  // collide (observed for `mcp_transition`). `events` is a
                  // read-only snapshot replaced wholesale on refresh, so the map
                  // index is a stable, unique-by-construction disambiguator.
                  key={`${event.kind}-${event.ts}-${event.tid ?? ''}-${event.sid ?? ''}-${index}`}
                  event={event}
                />
              ))}
            </div>
            <RawDiagnosticLogsDisclosure markdown={logs} />
          </>
        ) : null}
      </div>
    </SettingSection>
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
