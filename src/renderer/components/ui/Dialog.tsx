import * as React from 'react';
import { useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';
import styles from './Dialog.module.css';

/**
 * Dialog component for modal dialogs with overlay backdrop.
 * Supports close on escape key and click outside.
 *
 * @example
 * <Dialog open={isOpen} onOpenChange={setIsOpen}>
 *   <DialogContent>
 *     <DialogHeader>
 *       <DialogTitle>Dialog Title</DialogTitle>
 *       <DialogDescription>Description text</DialogDescription>
 *     </DialogHeader>
 *     <DialogBody>Content here</DialogBody>
 *     <DialogFooter>
 *       <Button variant="ghost" onClick={onCancel}>Cancel</Button>
 *       <Button onClick={onConfirm}>Confirm</Button>
 *     </DialogFooter>
 *   </DialogContent>
 * </Dialog>
 */

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  /** When true, clicking outside the dialog will not close it */
  disableOutsideClose?: boolean;
  /** When true, pressing Escape will not close the dialog */
  disableEscapeClose?: boolean;
  /** Additional class for the overlay element (useful for z-index overrides) */
  overlayClassName?: string;
  /** ID of the visible title that labels the dialog. */
  ariaLabelledBy?: string;
  /** ID of the element that describes the dialog (applied to the role="dialog" node). */
  ariaDescribedBy?: string;
}

export const Dialog = ({ open, onOpenChange, children, disableOutsideClose, disableEscapeClose, overlayClassName, ariaLabelledBy, ariaDescribedBy }: DialogProps) => {
  const handleEscape = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !disableEscapeClose) {
        event.preventDefault();
        onOpenChange(false);
      }
    },
    [onOpenChange, disableEscapeClose]
  );

  useEffect(() => {
    if (!open) return;
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [open, handleEscape]);

  if (!open) return null;

  // Portal to document.body to escape stacking context created by parent elements.
  // This ensures the dialog appears above all other UI elements (like the sidebar).
  return createPortal(
    <div
      className={cn(styles.overlay, overlayClassName)}
      role="dialog"
      aria-modal
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      onClick={disableOutsideClose ? undefined : () => onOpenChange(false)}
    >
      {children}
    </div>,
    document.body
  );
};
Dialog.displayName = 'Dialog';

export interface DialogContentProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

export const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  ({ className, size = 'md', children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(styles.content, styles[`content--${size}`], className)}
        onClick={(e) => e.stopPropagation()}
        {...props}
      >
        {children}
      </div>
    );
  }
);
DialogContent.displayName = 'DialogContent';

export interface DialogHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  /** When provided, renders a close (X) button in the header */
  onClose?: () => void;
  /** Disables the close (X) button while keeping the affordance visible. */
  closeDisabled?: boolean;
}

export const DialogHeader = React.forwardRef<HTMLDivElement, DialogHeaderProps>(
  ({ className, icon, onClose, closeDisabled, children, ...props }, ref) => {
    return (
      <header ref={ref} className={cn(styles.header, className)} {...props}>
        {icon && (
          <div className={styles.icon} aria-hidden>
            {icon}
          </div>
        )}
        <div className={styles.heading}>{children}</div>
        {onClose && (
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            disabled={closeDisabled}
            aria-label="Close dialog"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        )}
      </header>
    );
  }
);
DialogHeader.displayName = 'DialogHeader';

export const DialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h2 ref={ref} className={cn(styles.title, className)} {...props} />
));
DialogTitle.displayName = 'DialogTitle';

export const DialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn(styles.description, className)} {...props} />
));
DialogDescription.displayName = 'DialogDescription';

export const DialogBody = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn(styles.body, className)} {...props} />
  )
);
DialogBody.displayName = 'DialogBody';

export const DialogFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <footer ref={ref} className={cn(styles.footer, className)} {...props} />
  )
);
DialogFooter.displayName = 'DialogFooter';
