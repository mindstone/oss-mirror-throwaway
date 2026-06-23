/**
 * Composer — the side panel's message input (Stage 4, polished Stage 7).
 *
 * A textarea plus a send button. Enter submits the message; Shift+Enter
 * inserts a newline. Escape on an empty textarea blurs the input. The
 * textarea auto-grows up to a capped height (via CSS `max-height`) so long
 * drafts remain scrollable without eating the whole panel.
 *
 * Stage 7 adds auto-focus: when the composer mounts with `autoFocus` we
 * steal focus so the user can start typing the moment the side panel opens.
 * The SidePanel remounts the composer after Start Fresh (via a `key` bump)
 * so that also re-triggers focus.
 *
 * @see docs/plans/260421_embedded_chat_in_extension.md (Stages 4 + 7)
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';

export interface ComposerProps {
  /** Fires with the trimmed text when the user submits. No-op in Stage 4. */
  onSend: (text: string) => void;
  /** Disables the textarea and send button (e.g. Rebel is thinking, or not paired). */
  disabled?: boolean;
  /** Input placeholder. */
  placeholder?: string;
  /**
   * When true (default), focuses the textarea on mount so the user can
   * start typing immediately. Skipped when `disabled` is true to avoid
   * yanking focus to a dead surface (e.g. not-paired state).
   */
  autoFocus?: boolean;
}

function SendIcon(): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19V5" />
      <path d="M6 11l6-6 6 6" />
    </svg>
  );
}

export default function Composer(props: ComposerProps): ReactElement {
  const {
    onSend,
    disabled = false,
    placeholder = 'Ask about this page…',
    autoFocus = true,
  } = props;

  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-focus on mount so the user can start typing immediately. We only
  // focus when the composer is interactive (not disabled) — yanking focus
  // into a disabled textarea is both pointless and mildly user-hostile.
  // Remounting via a `key` bump (e.g. after Start Fresh) re-runs this.
  useEffect(() => {
    if (!autoFocus || disabled) return;
    const el = textareaRef.current;
    if (!el) return;
    // Defer to a microtask so the focus call happens after any initial
    // layout — avoids fighting browsers that try to focus their own default
    // target when the panel opens.
    queueMicrotask(() => {
      // Guard against the element being unmounted mid-microtask.
      if (textareaRef.current === el) el.focus();
    });
    // We intentionally only run this on mount. We don't refocus when
    // `disabled` flips back to false mid-conversation — that would steal
    // focus from the user while they're reading Rebel's response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-grow the textarea with the content (capped by CSS max-height).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
  }, [text, disabled, onSend]);

  const handleSubmit = useCallback(
    (ev: FormEvent): void => {
      ev.preventDefault();
      submit();
    },
    [submit],
  );

  const handleKeyDown = useCallback(
    (ev: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.nativeEvent.isComposing) {
        ev.preventDefault();
        submit();
        return;
      }
      // Escape on an empty textarea blurs the composer — lets the user
      // back out to the transcript without typing anything. When there IS
      // text we let Escape fall through (the browser's default is a no-op
      // here; if we later add a "clear draft" affordance this is the seam).
      if (ev.key === 'Escape' && text.length === 0) {
        ev.preventDefault();
        textareaRef.current?.blur();
      }
    },
    [submit, text],
  );

  const canSend = text.trim().length > 0 && !disabled;

  return (
    <form className="composer" onSubmit={handleSubmit} data-testid="composer">
      <div className="composer-field" data-disabled={disabled}>
        <textarea
          ref={textareaRef}
          className="composer-textarea"
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          rows={1}
          data-testid="composer-textarea"
          aria-label="Message Rebel"
        />
        <button
          type="submit"
          className="composer-send"
          disabled={!canSend}
          title="Send (Enter)"
          aria-label="Send message"
          data-testid="composer-send"
        >
          <SendIcon />
        </button>
      </div>
    </form>
  );
}
