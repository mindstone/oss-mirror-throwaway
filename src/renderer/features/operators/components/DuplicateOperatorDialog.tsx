import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import type { OperatorMetadata } from '@shared/ipc/channels/operators';
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input } from '@renderer/components/ui';
import styles from '../OperatorsPanel.module.css';

const HARD_MAX_DISPLAY_NAME = 120;

interface DuplicateOperatorDialogProps {
  operator: OperatorMetadata | null;
  open: boolean;
  busy: boolean;
  errorMessage?: string | null;
  onCancel: () => void;
  onConfirm: (newDisplayName: string) => void;
}

function defaultName(operator: OperatorMetadata): string {
  const base = operator.displayName ?? operator.name;
  return `${base} (Copy)`;
}

export function DuplicateOperatorDialog({
  operator,
  open,
  busy,
  errorMessage = null,
  onCancel,
  onConfirm,
}: DuplicateOperatorDialogProps): ReactNode {
  const [value, setValue] = useState(operator ? defaultName(operator) : '');

  useEffect(() => {
    if (open && operator) {
      setValue(defaultName(operator));
    }
  }, [open, operator]);

  if (!operator) return null;

  const trimmed = value.trim();
  const tooLong = trimmed.length > HARD_MAX_DISPLAY_NAME;
  const empty = trimmed.length === 0;
  const submitDisabled = busy || empty || tooLong;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitDisabled) return;
    onConfirm(trimmed);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }} disableOutsideClose={busy}>
      <DialogContent size="md" data-testid="operator-duplicate-dialog">
        <DialogHeader onClose={busy ? undefined : onCancel}>
          <DialogTitle>Duplicate {operator.displayName ?? operator.name}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <DialogBody>
            <label className={styles.renameField}>
              <span className={styles.renameFieldLabel}>New name</span>
              <Input
                type="text"
                value={value}
                onChange={(event) => setValue(event.currentTarget.value)}
                maxLength={HARD_MAX_DISPLAY_NAME + 1}
                disabled={busy}
                autoFocus
                data-testid="operator-duplicate-input"
              />
              <span className={styles.renameHint}>
                A new operator file will be created in the same Space. Up to {HARD_MAX_DISPLAY_NAME} characters.
              </span>
            </label>
            {errorMessage && (
              <p className={styles.errorText} data-testid="operator-duplicate-error">{errorMessage}</p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={submitDisabled} data-testid="operator-duplicate-confirm">
              {busy ? 'Duplicating…' : 'Duplicate'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
