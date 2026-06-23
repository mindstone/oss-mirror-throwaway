import * as React from 'react';
import { cn } from '../../lib/utils';
import styles from './Input.module.css';

/**
 * Input component for form text fields.
 * Supports various sizes and states (error, disabled).
 *
 * @example
 * <Input placeholder="Enter text..." />
 * <Input size="lg" error />
 */

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Size variant of the input */
  inputSize?: 'sm' | 'md' | 'lg';
  /** Error state styling */
  error?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', inputSize = 'md', error, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        className={cn(
          styles.input,
          styles[`input--${inputSize}`],
          error && styles['input--error'],
          className
        )}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

/**
 * Textarea component for multi-line text input.
 *
 * @example
 * <Textarea placeholder="Enter description..." rows={4} />
 */

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Error state styling */
  error?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, error, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(styles.textarea, error && styles['textarea--error'], className)}
        {...props}
      />
    );
  }
);
Textarea.displayName = 'Textarea';

/**
 * Label component for form fields.
 *
 * @example
 * <Label htmlFor="email">Email address</Label>
 */

export const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => {
    return <label ref={ref} className={cn(styles.label, className)} {...props} />;
  }
);
Label.displayName = 'Label';
