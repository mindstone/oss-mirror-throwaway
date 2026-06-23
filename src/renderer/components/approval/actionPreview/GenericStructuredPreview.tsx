import type { ActionEffectKind, ActionPreviewModel } from '@rebel/shared';
import styles from './ActionPreview.module.css';

export interface GenericStructuredPreviewProps {
  model: ActionPreviewModel;
  rendererKey?: ActionEffectKind;
  withheldCopy?: string;
}

export const GenericStructuredPreview = ({
  model,
  rendererKey,
  withheldCopy = 'Content hidden for privacy',
}: GenericStructuredPreviewProps) => {
  if (model.contentVisibility !== 'safe') {
    return (
      <section
        className={styles.genericPreview}
        data-testid="generic-structured-preview"
        data-renderer-key={rendererKey ?? model.effectKind}
      >
        <p className={styles.withheldCopy}>{withheldCopy}</p>
      </section>
    );
  }

  return (
    <section
      className={styles.genericPreview}
      data-testid="generic-structured-preview"
      data-renderer-key={rendererKey ?? model.effectKind}
    >
      {model.structuredArgs.length === 0 ? (
        <p className={styles.emptyRows}>Details unavailable.</p>
      ) : (
        <dl className={styles.rows}>
          {model.structuredArgs.map((row) => (
            <div key={`${row.key}-${row.value}`} className={styles.row}>
              <dt className={styles.rowKey}>{row.key}</dt>
              <dd className={styles.rowValue}>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
};
