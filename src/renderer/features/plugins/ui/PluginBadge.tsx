/**
 * Plugin Badge
 *
 * Simplified wrapper around `@renderer/components/ui/Badge` for use by plugins.
 *
 * @see docs/plans/260322_plugin_extension_system.md — Stage 13
 */

import type { ReactNode } from 'react';
import { Badge as UiBadge } from '@renderer/components/ui';

export interface PluginBadgeProps {
  children?: ReactNode;
  variant?: 'default' | 'secondary' | 'destructive' | 'outline';
}

export function Badge({ children, variant = 'default' }: PluginBadgeProps) {
  return <UiBadge variant={variant}>{children}</UiBadge>;
}
