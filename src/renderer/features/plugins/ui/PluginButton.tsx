/**
 * Plugin Button
 *
 * Simplified wrapper around `@renderer/components/ui/Button` for use by plugins.
 * Exposes a curated subset of props so plugin authors don't need internal knowledge.
 *
 * @see docs/plans/260322_plugin_extension_system.md — Stage 13
 */

import type { ReactNode } from 'react';
import { Button as UiButton } from '@renderer/components/ui';

export interface PluginButtonProps {
  children?: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'secondary' | 'ghost' | 'destructive';
  disabled?: boolean;
}

export function Button({ children, onClick, variant = 'default', disabled }: PluginButtonProps) {
  return (
    <UiButton variant={variant} onClick={onClick} disabled={disabled}>
      {children}
    </UiButton>
  );
}
