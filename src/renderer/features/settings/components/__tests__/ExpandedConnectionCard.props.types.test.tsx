import { describe, it } from 'vitest';
import { ExpandedConnectionCard } from '../ExpandedConnectionCard';
import type { ConnectionCardOps } from '../useConnectionCardOps';
import type { UnifiedConnection } from '../../hooks/useUnifiedConnections';

const connection: UnifiedConnection = {
  id: 'fixture',
  name: 'Fixture',
  description: 'Fixture connector',
  icon: 'bot',
  status: 'available',
  provider: 'direct',
};

const ops = {} as ConnectionCardOps;

describe('ExpandedConnectionCard retired prop types', () => {
  it('allows ops and rejects raw restart/deferred props', () => {
    void (
      <ExpandedConnectionCard
        connection={connection}
        onClose={() => undefined}
        ops={ops}
      />
    );

    void (
      <ExpandedConnectionCard
        connection={connection}
        onClose={() => undefined}
        ops={ops}
        // @ts-expect-error Stage 4: raw upsert prop is retired; use ops.upsertServer.
        onUpsertServer={async () => undefined}
      />
    );

    void (
      <ExpandedConnectionCard
        connection={connection}
        onClose={() => undefined}
        ops={ops}
        // @ts-expect-error Stage 4: raw remove prop is retired; use ops.removeServer.
        onRemoveServer={async () => undefined}
      />
    );

    void (
      <ExpandedConnectionCard
        connection={connection}
        onClose={() => undefined}
        ops={ops}
        // @ts-expect-error Stage 4: raw deferred tracker props are retired; use ops.
        onTrackDeferredOperation={() => undefined}
      />
    );
  });
});
