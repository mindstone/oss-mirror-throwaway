import type { InboxItem } from '@shared/types';

export type SmartGroup = {
  key: string;
  label: string;
  items: InboxItem[];
};

export type GroupResult = {
  ungrouped: InboxItem[];
  groups: SmartGroup[];
};

const SMART_GROUP_THRESHOLD = 8;

function deriveGroupKey(item: InboxItem): string | null {
  const source = item.source;
  if (!source) return null;

  switch (source.kind) {
    case 'automation':
      return `automation:${source.automationName}`;
    case 'role':
      return `role:${source.roleName}`;
    case 'meeting':
      return source.meetingTitle ? `meeting:${source.meetingTitle}` : null;
    case 'conversation':
      return `conversation:${source.sessionId}`;
    default:
      return null;
  }
}

function deriveGroupLabel(count: number, item: InboxItem): string {
  const source = item.source;
  if (!source) return `${count} items`;

  switch (source.kind) {
    case 'automation':
      return `${count} from ${source.automationName}`;
    case 'role':
      return `${count} from ${source.roleName}`;
    case 'meeting':
      return `${count} from ${source.meetingTitle ?? 'meeting'}`;
    case 'conversation':
      return `${count} from ${source.label ?? 'conversation'}`;
    default:
      return `${count} items`;
  }
}

/**
 * Groups items by matching source (automation name, meeting title, or conversation session).
 * Only applies when the input has {@link SMART_GROUP_THRESHOLD}+ items;
 * below that threshold everything is returned ungrouped.
 * Within qualifying inputs, a group is only formed when 2+ items share the same key.
 */
export function groupBySource(items: InboxItem[]): GroupResult {
  if (items.length < SMART_GROUP_THRESHOLD) {
    return { ungrouped: items, groups: [] };
  }

  const buckets = new Map<string, InboxItem[]>();
  const noKey: InboxItem[] = [];

  for (const item of items) {
    const key = deriveGroupKey(item);
    if (!key) {
      noKey.push(item);
      continue;
    }
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(key, [item]);
    }
  }

  const groups: SmartGroup[] = [];
  const ungrouped = [...noKey];

  for (const [key, bucketItems] of buckets) {
    if (bucketItems.length >= 2) {
      groups.push({
        key,
        label: deriveGroupLabel(bucketItems.length, bucketItems[0]),
        items: bucketItems,
      });
    } else {
      ungrouped.push(...bucketItems);
    }
  }

  return { ungrouped, groups };
}
