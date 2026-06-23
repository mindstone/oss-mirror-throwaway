import { FileText, Flag, Folder, MessageSquare, X } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import styles from './ComposerContextChip.module.css';

export type ComposerContextChipKind = 'mode' | 'file' | 'directory' | 'conversation' | 'finishLine';

export type ComposerContextChipProps = {
  label: string;
  kind: ComposerContextChipKind;
  onRemove?: () => void;
  /** Optional override for the chip's `aria-label` (defaults to `label`). */
  ariaLabel?: string;
  /** Optional accessible tooltip content. Uses the app Tooltip, not native `title`. */
  title?: string;
};

export function ComposerContextChip({ label, kind, onRemove, ariaLabel, title }: ComposerContextChipProps) {
  const Icon = kind === 'directory'
    ? Folder
    : kind === 'file'
      ? FileText
      : kind === 'conversation'
        ? MessageSquare
        : kind === 'finishLine'
          ? Flag
          : null;

  const chip = (
    <span
      className={styles.chip}
      aria-label={ariaLabel}
    >
      {Icon && <Icon size={12} className={styles.icon} aria-hidden />}
      <span className={styles.label}>{label}</span>
      {onRemove && (
        <button
          type="button"
          className={styles.remove}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onRemove}
          aria-label={`Remove ${ariaLabel ?? label}`}
        >
          <X size={11} aria-hidden />
        </button>
      )}
    </span>
  );

  if (!title) {
    return chip;
  }

  return (
    <Tooltip content={title} placement="top" delayShow={150}>
      {chip}
    </Tooltip>
  );
}
