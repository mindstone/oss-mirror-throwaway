import type { ChangeEvent } from 'react';
import { Textarea as UiTextarea } from '@renderer/components/ui';

export interface PluginTextareaProps {
  value?: string;
  onChange?: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
}

export function Textarea({ value, onChange, placeholder, disabled, rows }: PluginTextareaProps) {
  return (
    <UiTextarea
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      rows={rows}
    />
  );
}
