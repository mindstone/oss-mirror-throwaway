import type { ReactElement } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export function VirtualizerGetItemKeyViolationFixture(): ReactElement {
  const virtualizer = useVirtualizer({
    count: 1,
    getScrollElement: () => null,
    estimateSize: () => 40,
    getItemKey: (index) => `message-${index}`,
  });

  return <div data-count={virtualizer.getVirtualItems().length} />;
}
