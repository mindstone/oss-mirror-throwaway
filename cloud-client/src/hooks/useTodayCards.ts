import { useMemo } from 'react';
import {
  classifyInboxTier,
  groupByTemporal,
  sortInboxItems,
  resolveInboxCtaLabel,
} from '@rebel/shared';
import { useApprovalStore } from '../stores/approvalStore';
import { useInboxStore } from '../stores/inboxStore';
import { useStagedFilesStore } from '../stores/stagedFilesStore';
import type { InboxItem } from '../types';

// ---------------------------------------------------------------------------
// Card types (discriminated union)
// ---------------------------------------------------------------------------

interface ApprovalCard {
  type: 'approval';
  count: number;
  title: string;
  subtitle: string;
  ctaLabel: string;
}

interface InboxCard {
  type: 'inbox';
  item: InboxItem;
  title: string;
  subtitle: string;
  ctaLabel: string;
}

export type TodayCard = ApprovalCard | InboxCard;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CARDS = 3;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseTodayCardsReturn {
  cards: TodayCard[];
  totalCount: number;
  isLoading: boolean;
}

export function useTodayCards(): UseTodayCardsReturn {
  const toolApprovals = useApprovalStore((s) => s.toolApprovals);
  const stagedCalls = useApprovalStore((s) => s.stagedCalls);
  const memoryApprovals = useApprovalStore((s) => s.memoryApprovals);
  const approvalsLoading = useApprovalStore((s) => s.isLoading);
  const stagedFilesCount = useStagedFilesStore((s) => s.files.length);

  const inboxItems = useInboxStore((s) => s.items);
  const inboxLoading = useInboxStore((s) => s.isLoading);

  const isLoading = approvalsLoading || inboxLoading;

  const approvalCount =
    toolApprovals.length
    + stagedCalls.length
    + (memoryApprovals?.filter((approval) => !approval.staged).length ?? 0)
    + stagedFilesCount;

  // Filter inbox: non-archived, 'act' tier, 'due-today' temporal group.
  // Sorted with the same canonical sort as the Actions view so the top cards
  // match the first items the user sees when they tap through.
  const todayActionItems = useMemo(() => {
    const activeAct = inboxItems.filter(
      (item) => !item.archived && classifyInboxTier(item) === 'act',
    );
    const grouped = groupByTemporal(activeAct);
    const dueToday = grouped.get('due-today') ?? [];
    return sortInboxItems(dueToday);
  }, [inboxItems]);

  const cards = useMemo<TodayCard[]>(() => {
    const result: TodayCard[] = [];

    // Approvals card (aggregated into 1)
    if (approvalCount > 0) {
      result.push({
        type: 'approval',
        count: approvalCount,
        title: `${approvalCount} approval${approvalCount === 1 ? '' : 's'} need your OK`,
        subtitle: approvalCount === 1
          ? 'A tool or memory write is waiting for you'
          : `${approvalCount} items waiting for your review`,
        ctaLabel: 'Review',
      });
    }

    // Inbox action items (individual cards, up to remaining slots)
    const remainingSlots = MAX_CARDS - result.length;
    for (let i = 0; i < Math.min(todayActionItems.length, remainingSlots); i++) {
      const item = todayActionItems[i];
      result.push({
        type: 'inbox',
        item,
        title: item.title,
        subtitle: item.text?.trim() || 'Action needed today',
        ctaLabel: resolveInboxCtaLabel(item),
      });
    }

    return result;
  }, [approvalCount, todayActionItems]);

  // totalCount matches the Actions page header (all non-archived inbox items)
  // so "See all N items" is consistent with what the user sees when they tap through.
  const activeInboxCount = useMemo(
    () => inboxItems.filter((i) => !i.archived).length,
    [inboxItems],
  );

  const totalCount = approvalCount + activeInboxCount;

  return { cards, totalCount, isLoading };
}
