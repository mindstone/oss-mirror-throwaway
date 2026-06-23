import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { Flag } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import { FINISH_LINE_MAX_LENGTH, normalizeFinishLine } from '@core/utils/finishLine';
import styles from './FinishLineEditor.module.css';

export type FinishLineEditorProps = {
  initialValue: string;
  onSave: (value: string) => void;
  onCancel: () => void;
  onClear: () => void;
};

const PLACEHOLDER = 'Example: The brief is ready to send, with risks called out.';
const HELPER_EMPTY = 'No finish line. Rebel will use its usual judgment.';
const HELPER_FILLED = 'Rebel stops when this is met.';
const COUNTER_THRESHOLD = 400;

const FinishLineEditorComponent = ({
  initialValue,
  onSave,
  onCancel,
  onClear,
}: FinishLineEditorProps) => {
  const [draft, setDraft] = useState(initialValue);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setDraft(initialValue);
  }, [initialValue]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  const trimmedLength = useMemo(() => draft.length, [draft]);
  const showCounter = trimmedLength > COUNTER_THRESHOLD;
  const atCap = trimmedLength >= FINISH_LINE_MAX_LENGTH;
  const helperText = trimmedLength > 0 ? HELPER_FILLED : HELPER_EMPTY;
  const hasInitialValue = initialValue.trim().length > 0;

  const handleChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    if (next.length > FINISH_LINE_MAX_LENGTH) {
      setDraft(next.slice(0, FINISH_LINE_MAX_LENGTH));
    } else {
      setDraft(next);
    }
  }, []);

  const commitSave = useCallback(() => {
    const normalized = normalizeFinishLine(draft);
    onSave(normalized ?? '');
  }, [draft, onSave]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        commitSave();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    },
    [commitSave, onCancel],
  );

  return (
    <div
      className={styles.editor}
      data-testid="finish-line-editor"
      role="group"
      aria-label="Finish line criterion"
    >
      <div className={styles.headerRow}>
        <Flag size={12} aria-hidden="true" className={styles.headerIcon} />
        <span>Finish line</span>
      </div>
      <textarea
        ref={textareaRef}
        className={styles.textarea}
        value={draft}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={PLACEHOLDER}
        rows={3}
        maxLength={FINISH_LINE_MAX_LENGTH}
        aria-label="Finish line criterion"
        aria-describedby="finish-line-helper"
        data-testid="finish-line-editor-textarea"
      />
      <div className={styles.helperRow}>
        <p id="finish-line-helper" className={styles.helper}>
          {helperText}
        </p>
        {showCounter && (
          <span
            className={`${styles.counter}${atCap ? ` ${styles.counterAtCap}` : ''}`}
            aria-live="polite"
          >
            {trimmedLength}/{FINISH_LINE_MAX_LENGTH}
          </span>
        )}
      </div>
      <div className={styles.actions}>
        {hasInitialValue && (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className={styles.actionsLeft}
            onClick={onClear}
            data-testid="finish-line-clear"
          >
            Clear
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          data-testid="finish-line-cancel"
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={commitSave}
          data-testid="finish-line-save"
        >
          Save
        </Button>
      </div>
    </div>
  );
};

export const FinishLineEditor = memo(FinishLineEditorComponent);
FinishLineEditor.displayName = 'FinishLineEditor';
