import * as React from 'react';
import { createContext, useContext, useState, useCallback, useId } from 'react';
import { cn } from '../../lib/utils';
import styles from './Tabs.module.css';

/**
 * Tabs component for tabbed navigation and content switching.
 * Uses controlled value with context to manage active tab.
 *
 * @example
 * <Tabs defaultValue="tab1">
 *   <TabsList>
 *     <TabsTrigger value="tab1">Tab 1</TabsTrigger>
 *     <TabsTrigger value="tab2">Tab 2</TabsTrigger>
 *   </TabsList>
 *   <TabsContent value="tab1">Content 1</TabsContent>
 *   <TabsContent value="tab2">Content 2</TabsContent>
 * </Tabs>
 */

type TabsContextValue = {
  value: string;
  onValueChange: (value: string) => void;
  baseId: string;
};

const TabsContext = createContext<TabsContextValue | null>(null);

const useTabs = () => {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error('Tabs components must be used within a Tabs provider');
  }
  return ctx;
};

export interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The controlled value of the active tab */
  value?: string;
  /** The default active tab value */
  defaultValue?: string;
  /** Callback when the active tab changes */
  onValueChange?: (value: string) => void;
}

export const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(
  ({ className, value: controlledValue, defaultValue = '', onValueChange, children, ...props }, ref) => {
    const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
    const baseId = useId();
    const isControlled = controlledValue !== undefined;
    const value = isControlled ? controlledValue : uncontrolledValue;

    const handleValueChange = useCallback(
      (newValue: string) => {
        if (!isControlled) {
          setUncontrolledValue(newValue);
        }
        onValueChange?.(newValue);
      },
      [isControlled, onValueChange]
    );

    return (
      <TabsContext.Provider value={{ value, onValueChange: handleValueChange, baseId }}>
        <div ref={ref} className={cn(styles.tabs, className)} {...props}>
          {children}
        </div>
      </TabsContext.Provider>
    );
  }
);
Tabs.displayName = 'Tabs';

export interface TabsListProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Visual variant of the tab list */
  variant?: 'default' | 'pills' | 'underline';
}

export const TabsList = React.forwardRef<HTMLDivElement, TabsListProps>(
  ({ className, variant = 'default', ...props }, ref) => {
    return (
      <div
        ref={ref}
        role="tablist"
        className={cn(styles.list, styles[`list--${variant}`], className)}
        {...props}
      />
    );
  }
);
TabsList.displayName = 'TabsList';

export interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** The unique value associated with this tab */
  value: string;
}

export const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ className, value, ...props }, ref) => {
    const { value: activeValue, onValueChange, baseId } = useTabs();
    const isActive = activeValue === value;
    const triggerId = `${baseId}-trigger-${value}`;
    const panelId = `${baseId}-panel-${value}`;

    const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const tablist = event.currentTarget.closest('[role="tablist"]');
      const tabs = tablist
        ? Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        : [];
      const currentIndex = tabs.indexOf(event.currentTarget);

      if (currentIndex === -1 || tabs.length === 0) {
        props.onKeyDown?.(event);
        return;
      }

      const focusAt = (index: number) => {
        const next = tabs[index];
        if (!next) return;
        next.focus();
        next.click();
      };

      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault();
          focusAt((currentIndex + 1) % tabs.length);
          return;
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault();
          focusAt((currentIndex - 1 + tabs.length) % tabs.length);
          return;
        case 'Home':
          event.preventDefault();
          focusAt(0);
          return;
        case 'End':
          event.preventDefault();
          focusAt(tabs.length - 1);
          return;
        default:
          props.onKeyDown?.(event);
      }
    };

    return (
      <button
        ref={ref}
        type="button"
        role="tab"
        id={triggerId}
        aria-selected={isActive}
        aria-controls={panelId}
        tabIndex={isActive ? 0 : -1}
        data-state={isActive ? 'active' : 'inactive'}
        className={cn(styles.trigger, isActive && styles['trigger--active'], className)}
        onClick={() => onValueChange(value)}
        {...props}
        onKeyDown={handleKeyDown}
      />
    );
  }
);
TabsTrigger.displayName = 'TabsTrigger';

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The value that matches the TabsTrigger value */
  value: string;
}

export const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(
  ({ className, value, ...props }, ref) => {
    const { value: activeValue, baseId } = useTabs();

    if (activeValue !== value) return null;

    const triggerId = `${baseId}-trigger-${value}`;
    const panelId = `${baseId}-panel-${value}`;

    return (
      <div
        ref={ref}
        role="tabpanel"
        id={panelId}
        aria-labelledby={triggerId}
        data-state="active"
        className={cn(styles.content, className)}
        {...props}
      />
    );
  }
);
TabsContent.displayName = 'TabsContent';
