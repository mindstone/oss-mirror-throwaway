/**
 * Plugin ErrorCard
 *
 * Themed error display using the real Card component with destructive styling.
 *
 * @see docs/plans/260322_plugin_extension_system.md — Stage 13
 */

import { Card as UiCard, CardContent } from '@renderer/components/ui';

export interface PluginErrorCardProps {
  error?: string;
}

export function ErrorCard({ error }: PluginErrorCardProps) {
  return (
    <UiCard>
      <CardContent>
        <div style={{ color: 'var(--color-destructive, #dc2626)' }}>
          {error ?? 'Something went wrong'}
        </div>
      </CardContent>
    </UiCard>
  );
}
