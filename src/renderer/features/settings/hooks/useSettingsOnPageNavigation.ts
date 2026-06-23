import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SettingsDestinationId } from '@shared/navigation/settingsNavigationContract';
import type { SettingsTabId } from '@shared/navigation/types';
import {
  createSettingsAnchorOwnerMap,
  type SettingsOnPageAnchorConfig,
} from '../components/settingsOnPageAnchorConfig';

const SCROLL_IDLE_MS = 120;
const PENDING_JUMP_TIMEOUT_MS = 1600;
const TOP_OFFSET_PADDING_PX = 12;

type SectionPosition = {
  sectionId: string;
  relativeTop: number;
};

type PendingJump = {
  anchorId: string;
  token: number;
};

export function resolveActiveAnchorId(
  sectionPositions: readonly SectionPosition[],
  ownerMap: ReadonlyMap<string, string>,
  thresholdPx: number,
): string | undefined {
  if (sectionPositions.length === 0) {
    return undefined;
  }

  const lastSectionAtOrAboveThreshold =
    [...sectionPositions].reverse().find((section) => section.relativeTop <= thresholdPx) ??
    sectionPositions[0];

  return ownerMap.get(lastSectionAtOrAboveThreshold.sectionId);
}

function collectObservedSectionPositions(
  container: HTMLElement,
  anchors: readonly SettingsOnPageAnchorConfig[],
): SectionPosition[] {
  const seen = new Set<string>();
  const positions: SectionPosition[] = [];
  const containerRect = container.getBoundingClientRect();

  for (const anchor of anchors) {
    for (const sectionId of anchor.observeTargets) {
      if (seen.has(sectionId)) {
        continue;
      }
      seen.add(sectionId);

      const section = container.querySelector(`[data-section="${CSS.escape(sectionId)}"]`) as HTMLElement | null;
      if (!section) {
        continue;
      }

      positions.push({
        sectionId,
        relativeTop: section.getBoundingClientRect().top - containerRect.top,
      });
    }
  }

  positions.sort((left, right) => left.relativeTop - right.relativeTop);
  return positions;
}

function getStickyStripHeight(container: HTMLElement): number {
  const strip = container.querySelector('[data-settings-on-page-strip]') as HTMLElement | null;
  return strip?.offsetHeight ?? 0;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

type UseSettingsOnPageNavigationArgs = {
  destination: SettingsDestinationId;
  activeLeafTab: SettingsTabId;
  anchors: readonly SettingsOnPageAnchorConfig[];
  incomingSection?: string;
};

export function useSettingsOnPageNavigation({
  destination,
  activeLeafTab,
  anchors,
  incomingSection,
}: UseSettingsOnPageNavigationArgs) {
  const [activeAnchorId, setActiveAnchorId] = useState<string | undefined>(anchors[0]?.anchorId);
  const ownerMap = useMemo(() => createSettingsAnchorOwnerMap(anchors), [anchors]);
  const pendingJumpRef = useRef<PendingJump | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRef = useRef<number | null>(null);
  const tokenRef = useRef(0);

  const readCurrentAnchor = useCallback(() => {
    const container = document.querySelector('[data-settings-scroll-root]') as HTMLElement | null;
    if (!container) {
      return undefined;
    }

    const positions = collectObservedSectionPositions(container, anchors);
    const thresholdPx = getStickyStripHeight(container) + TOP_OFFSET_PADDING_PX;
    return resolveActiveAnchorId(positions, ownerMap, thresholdPx);
  }, [anchors, ownerMap]);

  const clearPendingJump = useCallback(
    (nextAnchorId?: string) => {
      pendingJumpRef.current = null;
      if (pendingTimeoutRef.current) {
        clearTimeout(pendingTimeoutRef.current);
        pendingTimeoutRef.current = null;
      }
      const resolvedAnchorId = nextAnchorId ?? readCurrentAnchor();
      if (resolvedAnchorId) {
        setActiveAnchorId((current) => (current === resolvedAnchorId ? current : resolvedAnchorId));
      }
    },
    [readCurrentAnchor],
  );

  const beginExplicitJump = useCallback(
    (anchorId: string) => {
      tokenRef.current += 1;
      const token = tokenRef.current;
      pendingJumpRef.current = {
        anchorId,
        token,
      };
      setActiveAnchorId(anchorId);

      if (pendingTimeoutRef.current) {
        clearTimeout(pendingTimeoutRef.current);
      }

      const timeoutMs = prefersReducedMotion() ? 200 : PENDING_JUMP_TIMEOUT_MS;
      pendingTimeoutRef.current = setTimeout(() => {
        if (pendingJumpRef.current?.token === token) {
          clearPendingJump();
        }
      }, timeoutMs);
    },
    [clearPendingJump],
  );

  useEffect(() => {
    if (anchors.length === 0) {
      setActiveAnchorId(undefined);
      return;
    }
    setActiveAnchorId((current) =>
      current && anchors.some((anchor) => anchor.anchorId === current) ? current : anchors[0]?.anchorId
    );
  }, [anchors]);

  useEffect(() => {
    if (!incomingSection) {
      return;
    }
    const owningAnchorId = ownerMap.get(incomingSection);
    if (owningAnchorId) {
      beginExplicitJump(owningAnchorId);
    }
  }, [beginExplicitJump, incomingSection, ownerMap]);

  useEffect(() => {
    const container = document.querySelector('[data-settings-scroll-root]') as HTMLElement | null;
    if (!container || anchors.length === 0) {
      return;
    }

    const updateFromScroll = () => {
      const nextAnchorId = readCurrentAnchor();
      if (!nextAnchorId) {
        return;
      }
      const pendingJump = pendingJumpRef.current;
      if (!pendingJump) {
        setActiveAnchorId((current) => (current === nextAnchorId ? current : nextAnchorId));
        return;
      }

      if (nextAnchorId === pendingJump.anchorId) {
        setActiveAnchorId((current) => (current === nextAnchorId ? current : nextAnchorId));
      }
    };

    const handleScroll = () => {
      if (frameRef.current == null) {
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null;
          updateFromScroll();
        });
      }

      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
      }

      idleTimerRef.current = setTimeout(() => {
        const pendingJump = pendingJumpRef.current;
        if (!pendingJump) {
          clearPendingJump();
          return;
        }

        const settledAnchorId = readCurrentAnchor();
        if (settledAnchorId === pendingJump.anchorId) {
          clearPendingJump(settledAnchorId);
        }
      }, SCROLL_IDLE_MS);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });

    const initialAnchorId = readCurrentAnchor();
    if (initialAnchorId && !pendingJumpRef.current) {
      setActiveAnchorId((current) => (current === initialAnchorId ? current : initialAnchorId));
    }

    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [anchors, clearPendingJump, destination, activeLeafTab, readCurrentAnchor]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (pendingJumpRef.current) {
        return;
      }
      const nextAnchorId = readCurrentAnchor();
      if (nextAnchorId) {
        setActiveAnchorId((current) => (current === nextAnchorId ? current : nextAnchorId));
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [activeLeafTab, destination, readCurrentAnchor]);

  useEffect(() => {
    return () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
      }
      if (pendingTimeoutRef.current) {
        clearTimeout(pendingTimeoutRef.current);
      }
      if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, []);

  return {
    activeAnchorId,
    beginExplicitJump,
  };
}
