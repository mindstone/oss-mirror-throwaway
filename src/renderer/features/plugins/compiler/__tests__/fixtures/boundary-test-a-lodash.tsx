/**
 * Boundary Test A: Disallowed import (lodash)
 *
 * This plugin intentionally tries to import lodash, which is NOT
 * in ALLOWED_PLUGIN_REQUIRE_MODULES. Expected: compile fails with
 * 'Disallowed require() module "lodash"'.
 */
import { sortBy } from 'lodash';
import { useConversations } from '@rebel/plugin-api';
import { Card, Stack } from '@rebel/plugin-ui';

export default function LodashPlugin() {
  const { data: conversations } = useConversations();
  const sorted = sortBy(conversations, 'updatedAt');

  return (
    <Stack gap="sm">
      {sorted.map((c: { id: string; title: string | null }) => (
        <Card key={c.id}>{c.title || 'Untitled'}</Card>
      ))}
    </Stack>
  );
}
