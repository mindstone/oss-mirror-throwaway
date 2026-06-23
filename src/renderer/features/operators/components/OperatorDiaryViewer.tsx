import { useEffect, useMemo, useState } from 'react';
import { Clock3 } from 'lucide-react';
import type { OperatorMetadata } from '@shared/ipc/channels/operators';
import styles from '../OperatorsPanel.module.css';

export interface OperatorDiaryViewerProps {
  operator: OperatorMetadata;
  initialDiary?: string;
}

function splitDiaryEntries(diary: string): string[] {
  return diary
    .split(/\n(?=#{1,3}\s|\d{4}-\d{2}-\d{2}|---)/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function OperatorDiaryViewer({ operator, initialDiary }: OperatorDiaryViewerProps) {
  const [diary, setDiary] = useState(initialDiary ?? '');
  const [loading, setLoading] = useState(initialDiary === undefined);
  const [error, setError] = useState<string | null>(null);
  const operatorLabel = operator.displayName ?? operator.name;

  useEffect(() => {
    let cancelled = false;
    setError(null);

    if (initialDiary !== undefined) {
      setDiary(initialDiary);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    void window.operatorsApi.getDiary({ operatorId: operator.id })
      .then((response) => {
        if (!cancelled) {
          setDiary(response.diary);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [initialDiary, operator.id]);

  const entries = useMemo(() => splitDiaryEntries(diary), [diary]);

  return (
    <section className={styles.diaryViewer} data-testid="operator-diary-viewer">
      <div className={styles.sectionHeaderRow}>
        <div>
          <p className={styles.sectionEyebrow}>Recently asked</p>
          <h3 className={styles.sectionTitle}>{operatorLabel}</h3>
        </div>
      </div>

      {loading && <p className={styles.mutedText}>Loading notes…</p>}
      {error && <p className={styles.errorText}>Couldn&apos;t load recent questions: {error}</p>}
      {!loading && !error && entries.length === 0 && (
        <p className={styles.emptyInline}>No questions asked yet.</p>
      )}
      {!loading && !error && entries.length > 0 && (
        <ol className={styles.diaryTimeline}>
          {entries.map((entry, index) => (
            <li key={`${operator.id}-diary-${index}`} className={styles.diaryEntry}>
              <Clock3 size={14} aria-hidden />
              <pre>{entry}</pre>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
