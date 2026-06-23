import { useId, useMemo, useState } from 'react';
import type { ActionPreviewModel } from '@rebel/shared';
import { Badge, Button } from '@renderer/components/ui';
import styles from './DataCapturePreview.module.css';

const PRIVACY_COPY = 'Content hidden for privacy';

function rowValue(model: ActionPreviewModel, key: string): string | null {
  const match = model.structuredArgs.find((row) => row.key.toLowerCase() === key.toLowerCase());
  return match?.value ?? null;
}

function safeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeBoolean(value: unknown): boolean {
  return value === true;
}

function deriveExcerpts(model: ActionPreviewModel): string[] {
  const fromSafeArgs = safeStringArray(model.safeRawArgs.excerpts);
  if (fromSafeArgs.length > 0) return fromSafeArgs;

  return model.structuredArgs
    .filter((row) => row.key.toLowerCase().startsWith('excerpt '))
    .map((row) => row.value);
}

export interface DataCapturePreviewProps {
  model: ActionPreviewModel;
}

export const DataCapturePreview = ({ model }: DataCapturePreviewProps) => {
  const whereLabel = safeString(model.safeRawArgs.where) ?? model.blastRadius.where[0]?.label ?? 'Unknown space';
  const pathLabel = safeString(model.safeRawArgs.path) ?? safeString(model.safeRawArgs.location);
  const audienceLabel = safeString(model.safeRawArgs.sharing) ?? model.blastRadius.whoCanSeeIt[0]?.label ?? null;
  const isNew = safeBoolean(model.safeRawArgs.isNew);
  const summary = useMemo(
    () => safeString(model.safeRawArgs.summary) ?? rowValue(model, 'what will be saved'),
    [model],
  );
  const excerpts = useMemo(() => deriveExcerpts(model), [model]);
  const excerptListId = useId();
  const [expanded, setExpanded] = useState(false);
  const safeToRenderContent = model.contentVisibility === 'safe';

  return (
    <section className={styles.root} data-testid="data-capture-preview">
      <div className={styles.metaSection}>
        <p className={styles.metaRow} data-testid="data-capture-preview-space">
          <span className={styles.metaLabel}>Space</span>
          <span className={styles.metaValue}>{whereLabel}</span>
        </p>
        {pathLabel ? (
          <p className={styles.metaRow} data-testid="data-capture-preview-path">
            <span className={styles.metaLabel}>Path</span>
            <span className={styles.metaValue}>{pathLabel}</span>
          </p>
        ) : null}
        {audienceLabel ? (
          <p className={styles.metaRow} data-testid="data-capture-preview-sharing">
            <span className={styles.metaLabel}>Who can see it</span>
            <span className={styles.metaValue}>{audienceLabel}</span>
          </p>
        ) : null}
      </div>

      {isNew ? (
        <Badge
          variant="outline"
          size="sm"
          className={styles.newBadge}
          data-testid="data-capture-preview-new-indicator"
        >
          New
        </Badge>
      ) : null}

      {!safeToRenderContent ? (
        <p className={styles.withheldCopy} data-testid="data-capture-preview-withheld">
          {PRIVACY_COPY}
        </p>
      ) : (
        <div className={styles.body}>
          <div className={styles.summaryBlock}>
            <h4 className={styles.bodyHeading}>What will be saved</h4>
            <p className={styles.summaryText} data-testid="data-capture-preview-summary">
              {summary ?? 'No summary was provided for this source capture.'}
            </p>
          </div>

          {excerpts.length > 0 ? (
            <div className={styles.excerptsBlock}>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setExpanded((prev) => !prev)}
                aria-expanded={expanded}
                aria-controls={excerptListId}
                data-testid="data-capture-preview-excerpts-toggle"
              >
                {expanded ? 'Hide excerpts' : `Show excerpts (${excerpts.length})`}
              </Button>
              {expanded ? (
                <ol
                  id={excerptListId}
                  className={styles.excerptsList}
                  data-testid="data-capture-preview-excerpts"
                >
                  {excerpts.map((excerpt, index) => (
                    <li key={`${index}-${excerpt}`} className={styles.excerptItem}>
                      {excerpt}
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
};
