/**
 * Plugin Card
 *
 * Simplified wrapper around `@renderer/components/ui/Card` for use by plugins.
 * Wraps Card + CardContent for a single-component experience.
 *
 * @see docs/plans/260322_plugin_extension_system.md — Stage 13
 */

import type { ReactNode } from 'react';
import { Card as UiCard, CardContent } from '@renderer/components/ui';

export interface PluginCardProps {
  children?: ReactNode;
  onClick?: () => void;
  className?: string;
}

export function Card({ children, onClick, className }: PluginCardProps) {
  return (
    <UiCard
      className={className}
      onClick={onClick}
      style={onClick ? { cursor: 'pointer' } : undefined}
    >
      <CardContent>{children}</CardContent>
    </UiCard>
  );
}
