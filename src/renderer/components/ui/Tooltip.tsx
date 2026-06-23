import * as React from 'react';
import { useRef } from 'react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  arrow,
  useHover,
  useFocus,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
  safePolygon,
  type Placement
} from '@floating-ui/react';
import { cn } from '../../lib/utils';
import styles from './Tooltip.module.css';

/**
 * Tooltip component for showing helpful hints on hover.
 * Wraps a trigger element and displays content on hover/focus.
 * Uses @floating-ui/react for viewport-aware positioning.
 *
 * @example
 * <Tooltip content="This is a helpful tip">
 *   <button>Hover me</button>
 * </Tooltip>
 */

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  /** The content to display in the tooltip */
  content: React.ReactNode;
  /** The trigger element */
  children: React.ReactElement;
  /** Placement of the tooltip relative to trigger */
  placement?: TooltipPlacement;
  /** Delay before showing tooltip in ms */
  delayShow?: number;
  /** Delay before hiding tooltip in ms */
  delayHide?: number;
  /** Whether the tooltip is disabled */
  disabled?: boolean;
  /** Maximum width of the tooltip (e.g., '500px', 'none'). Defaults to 320px. */
  maxWidth?: string;
  /** Allow interaction with tooltip content (buttons, links). Uses safePolygon to keep tooltip open while moving to it. */
  interactive?: boolean;
  /** Also toggle the tooltip when the trigger is clicked/tapped or keyboard-activated. */
  clickToToggle?: boolean;
  /** Open on initial render, primarily for visual states in Storybook/tests. */
  defaultOpen?: boolean;
}

export const Tooltip = ({
  content,
  children,
  placement = 'top',
  delayShow = 200,
  delayHide = 0,
  disabled = false,
  maxWidth,
  interactive = false,
  clickToToggle = false,
  defaultOpen = false,
}: TooltipProps) => {
  const [isOpen, setIsOpen] = React.useState(defaultOpen);
  const arrowRef = useRef<HTMLDivElement>(null);
  const pointerToggleHandledRef = useRef(false);

  const {
    refs,
    floatingStyles,
    context,
    middlewareData,
    placement: actualPlacement,
    isPositioned
  } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: placement as Placement,
    middleware: [
      offset(8),
      flip({
        fallbackAxisSideDirection: 'start',
        padding: 8
      }),
      shift({ padding: 8 }),
      arrow({ element: arrowRef, padding: 4 })
    ],
    whileElementsMounted: autoUpdate
  });

  const hover = useHover(context, {
    move: false,
    delay: {
      open: delayShow,
      close: delayHide
    },
    enabled: !disabled,
    ...(interactive ? { handleClose: safePolygon() } : {}),
  });

  const focus = useFocus(context, {
    enabled: !disabled
  });

  const dismiss = useDismiss(context, {
    ancestorScroll: true
  });

  const role = useRole(context, { role: 'tooltip' });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    focus,
    dismiss,
    role
  ]);

  if (disabled || !content) {
    return children;
  }

  const arrowX = middlewareData.arrow?.x;
  const arrowY = middlewareData.arrow?.y;
  const side = actualPlacement.split('-')[0] as 'top' | 'bottom' | 'left' | 'right';

  const staticSide = {
    top: 'bottom',
    right: 'left',
    bottom: 'top',
    left: 'right'
  }[side] as 'top' | 'bottom' | 'left' | 'right';

  const child = children as React.ReactElement<Record<string, unknown>>;
  const childProps = child.props;
  const referenceProps = getReferenceProps();
  const callReferenceHandler = (handler: unknown, event: React.SyntheticEvent): void => {
    if (typeof handler === 'function') {
      handler(event);
    }
  };
  const composedReferenceProps = {
    ...referenceProps,
    onClick: (event: React.MouseEvent) => {
      callReferenceHandler(referenceProps.onClick, event);
      const childOnClick = childProps.onClick;
      if (typeof childOnClick === 'function') {
        childOnClick(event);
      }
      if (clickToToggle && !disabled) {
        if (!pointerToggleHandledRef.current) {
          setIsOpen((value) => !value);
        }
        pointerToggleHandledRef.current = false;
      }
    },
    onPointerDown: (event: React.PointerEvent) => {
      callReferenceHandler(referenceProps.onPointerDown, event);
      const childOnPointerDown = childProps.onPointerDown;
      if (typeof childOnPointerDown === 'function') {
        childOnPointerDown(event);
      }
      if (clickToToggle && !disabled) {
        pointerToggleHandledRef.current = true;
        setIsOpen((value) => !value);
      }
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      callReferenceHandler(referenceProps.onKeyDown, event);
      const childOnKeyDown = childProps.onKeyDown;
      if (typeof childOnKeyDown === 'function') {
        childOnKeyDown(event);
      }
      if (clickToToggle && !disabled && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        setIsOpen((value) => !value);
      }
    },
    onBlur: (event: React.FocusEvent) => {
      callReferenceHandler(referenceProps.onBlur, event);
      const childOnBlur = childProps.onBlur;
      if (typeof childOnBlur === 'function') {
        childOnBlur(event);
      }
      if (clickToToggle && !disabled) {
        setIsOpen(false);
      }
    },
  };

  return (
    <>
      {React.cloneElement(child, {
        ref: refs.setReference,
        ...composedReferenceProps
      })}
      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={{ ...floatingStyles, ...(maxWidth ? { maxWidth } : {}) }}
            className={cn(
              styles.tooltip,
              styles[`tooltip--${side}`],
              isPositioned && styles['tooltip--positioned'],
              interactive && styles.tooltipInteractive
            )}
            {...getFloatingProps()}
          >
            {content}
            <div
              ref={arrowRef}
              className={styles.arrow}
              style={{
                left: arrowX != null ? `${arrowX}px` : '',
                top: arrowY != null ? `${arrowY}px` : '',
                [staticSide]: '-4px'
              }}
            />
          </div>
        </FloatingPortal>
      )}
    </>
  );
};
Tooltip.displayName = 'Tooltip';
