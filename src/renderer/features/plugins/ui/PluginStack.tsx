/**
 * Plugin Stack
 *
 * Custom layout component for plugins — no equivalent in the UI library.
 * Uses CSS flexbox with design-token-aligned spacing.
 *
 * @see docs/plans/260322_plugin_extension_system.md — Stage 13
 */

import type { ReactNode } from 'react';

const gapMap = {
  sm: '0.5rem',
  md: '1rem',
  lg: '1.5rem',
} as const;

export interface PluginStackProps {
  children?: ReactNode;
  gap?: 'sm' | 'md' | 'lg';
  direction?: 'column' | 'row';
}

export function Stack({ children, gap = 'md', direction = 'column' }: PluginStackProps) {
  return (
    <div style={{ display: 'flex', flexDirection: direction, gap: gapMap[gap] }}>
      {children}
    </div>
  );
}
