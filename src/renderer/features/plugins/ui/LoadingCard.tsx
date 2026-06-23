/**
 * Plugin LoadingCard
 *
 * Themed loading indicator using the real Spinner component inside a Card.
 *
 * @see docs/plans/260322_plugin_extension_system.md — Stage 13
 */

import { Card as UiCard, CardContent, Spinner } from '@renderer/components/ui';

export function LoadingCard() {
  return (
    <UiCard>
      <CardContent>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '1rem' }}>
          <Spinner label="Loading..." />
        </div>
      </CardContent>
    </UiCard>
  );
}
