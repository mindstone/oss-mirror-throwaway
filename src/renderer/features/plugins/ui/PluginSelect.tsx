/**
 * Plugin Select
 *
 * Simplified wrapper around `@renderer/components/ui/Select` for use by plugins.
 * Exposes a curated subset of props so plugin authors don't need internal knowledge.
 *
 * @see docs/plans/260325_sources_plugin_and_api_extensions.md — Stage 6
 */

import type { ReactNode, ChangeEvent } from 'react';
import { Select as UiSelect } from '@renderer/components/ui';

export interface PluginSelectProps {
  value?: string;
  onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
  children?: ReactNode;
  disabled?: boolean;
}

export function Select({ value, onChange, children, disabled }: PluginSelectProps) {
  return (
    <UiSelect value={value} onChange={onChange} disabled={disabled}>
      {children}
    </UiSelect>
  );
}
