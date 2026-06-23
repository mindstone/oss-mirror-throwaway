import * as React from 'react';
import { cn } from '../../lib/utils';
import styles from './Select.module.css';

/**
 * Native select component with styled appearance.
 * For simple dropdowns without complex features.
 *
 * @example
 * <Select value={selected} onChange={e => setSelected(e.target.value)}>
 *   <option value="opt1">Option 1</option>
 *   <option value="opt2">Option 2</option>
 * </Select>
 */

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** Size variant of the select */
  selectSize?: 'sm' | 'md' | 'lg';
  /** Error state styling */
  error?: boolean;
  /** Optional class for the outer wrapper */
  wrapperClassName?: string;
  /** Optional style for the outer wrapper */
  wrapperStyle?: React.CSSProperties;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, selectSize = 'md', error, children, wrapperClassName, wrapperStyle, ...props }, ref) => {
    return (
      <div className={cn(styles.wrapper, wrapperClassName)} style={wrapperStyle}>
        <select
          ref={ref}
          className={cn(
            styles.select,
            styles[`select--${selectSize}`],
            error && styles['select--error'],
            className
          )}
          {...props}
        >
          {children}
        </select>
        <div className={styles.chevron} aria-hidden>
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M4 6L8 10L12 6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>
    );
  }
);
Select.displayName = 'Select';

/**
 * Option group for Select component.
 *
 * @example
 * <Select>
 *   <SelectGroup label="Fruits">
 *     <option value="apple">Apple</option>
 *   </SelectGroup>
 * </Select>
 */

export interface SelectGroupProps extends React.OptgroupHTMLAttributes<HTMLOptGroupElement> {}

export const SelectGroup = React.forwardRef<HTMLOptGroupElement, SelectGroupProps>(
  ({ className, ...props }, ref) => {
    return <optgroup ref={ref} className={cn(styles.group, className)} {...props} />;
  }
);
SelectGroup.displayName = 'SelectGroup';
