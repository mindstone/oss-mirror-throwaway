/**
 * Plugin Input
 *
 * Simplified wrapper around `@renderer/components/ui/Input` for use by plugins.
 *
 * @see docs/plans/260322_plugin_extension_system.md — Stage 13
 */

import type { ChangeEvent } from 'react';
import { Input as UiInput } from '@renderer/components/ui';

export interface PluginInputProps {
  value?: string;
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  type?: string;
}

export function Input({ value, onChange, placeholder, disabled, type }: PluginInputProps) {
  return (
    <UiInput
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      type={type}
    />
  );
}
