import { useCallback, useMemo, useRef, useState } from 'react';
import { basename } from 'pathe';
import { createId } from '@shared/utils/id';
import { normalizeDocumentPath } from '../utils/normalizeDocumentPath';

const DEFAULT_MAX_TABS = 15;

export type DocumentTab = {
  id: string;
  path: string;
  title: string;
};

interface UseDocumentTabsOptions {
  maxTabs?: number;
  onTabsChange?: (tabs: DocumentTab[], activeTabId: string | null) => void;
  onBeforeTabSwitch?: () => Promise<void>;
  /**
   * Fired when a `closeTab` call empties the tab list (closing the last
   * remaining tab). NOT fired by `closeAllTabs` or `openDocument`. Opt-in:
   * the preview drawer passes this to dismiss the drawer when its final tab
   * is closed (otherwise the resolver would re-bootstrap the committed doc
   * from the 0-tab-while-open state). See
   * docs/plans/260622_fix-preview-drawer-single-tab-close/PLAN.md.
   */
  onTabsEmptiedByClose?: () => void;
}

interface UseDocumentTabsResult {
  tabs: DocumentTab[];
  activeTabId: string | null;
  activeDocumentPath: string | null;
  hasMultipleTabs: boolean;
  openDocument: (path: string) => void;
  closeTab: (tabId: string) => void;
  closeActiveTab: () => void;
  closeAllTabs: () => void;
  setActiveTab: (tabId: string) => void;
  setActiveTabByIndex: (index: number) => void;
}

const generateTabId = (): string => `tab-${createId()}`;

const getTabTitle = (filePath: string): string => basename(filePath) || filePath;

export function useDocumentTabs(options: UseDocumentTabsOptions = {}): UseDocumentTabsResult {
  const { maxTabs = DEFAULT_MAX_TABS, onTabsChange, onBeforeTabSwitch, onTabsEmptiedByClose } = options;

  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const [activeTabId, setActiveTabIdInternal] = useState<string | null>(null);

  const activeTabIdRef = useRef<string | null>(null);
  activeTabIdRef.current = activeTabId;

  // Mirror of the committed `tabs` state so callers can read the latest
  // array synchronously outside of state updaters. This lets
  // `openDocument` / `closeTab` / `setActiveTab` compute the next
  // tabs+activeId pair purely up-front, then fire both state setters
  // with plain values — avoiding the React anti-pattern of calling
  // setState or side-effects from inside a state updater function
  // (which Strict Mode double-invokes and can desync in production too).
  const tabsRef = useRef<DocumentTab[]>(tabs);
  tabsRef.current = tabs;

  const onTabsChangeRef = useRef(onTabsChange);
  onTabsChangeRef.current = onTabsChange;

  const onBeforeTabSwitchRef = useRef(onBeforeTabSwitch);
  onBeforeTabSwitchRef.current = onBeforeTabSwitch;

  const onTabsEmptiedByCloseRef = useRef(onTabsEmptiedByClose);
  onTabsEmptiedByCloseRef.current = onTabsEmptiedByClose;

  const notifyChange = useCallback((nextTabs: DocumentTab[], nextActiveId: string | null) => {
    onTabsChangeRef.current?.(nextTabs, nextActiveId);
  }, []);

  const activeDocumentPath = useMemo(() => {
    if (!activeTabId) return null;
    const tab = tabs.find(t => t.id === activeTabId);
    return tab?.path ?? null;
  }, [tabs, activeTabId]);

  const hasMultipleTabs = tabs.length > 1;

  const openDocument = useCallback(
    (rawPath: string) => {
      const path = normalizeDocumentPath(rawPath);

      // Compute next tabs + activeId purely up-front from `tabsRef`, then
      // fire setters with plain values. See comment on `tabsRef` above
      // for why we avoid the setState-inside-updater anti-pattern.
      const doOpen = () => {
        const prev = tabsRef.current;
        const existing = prev.find(t => t.path === path);

        if (existing) {
          setActiveTabIdInternal(existing.id);
          notifyChange(prev, existing.id);
          return;
        }

        const newTab: DocumentTab = {
          id: generateTabId(),
          path,
          title: getTabTitle(path),
        };

        let nextTabs: DocumentTab[];
        if (prev.length >= maxTabs) {
          const currentActiveId = activeTabIdRef.current;
          const tabToRemove = prev.find(t => t.id !== currentActiveId);
          if (tabToRemove) {
            nextTabs = [...prev.filter(t => t.id !== tabToRemove.id), newTab];
          } else {
            nextTabs = [...prev, newTab];
          }
        } else {
          nextTabs = [...prev, newTab];
        }

        // Keep `tabsRef` in sync synchronously so back-to-back calls
        // (e.g. user clicking skill A then B in quick succession) see
        // the in-flight previous state, not the pre-click state.
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        setActiveTabIdInternal(newTab.id);
        notifyChange(nextTabs, newTab.id);
      };

      const currentActiveId = activeTabIdRef.current;
      if (currentActiveId !== null && onBeforeTabSwitchRef.current) {
        // onBeforeTabSwitch may reject (Class A Batch 1: a failed flush()
        // propagates as rejection so destructive navigation aborts).
        // The TWO-ARG .then(doOpen, abortHandler) form is critical: a
        // chained .catch() would also swallow any synchronous error
        // thrown by doOpen, which we never want. doOpen is NOT called
        // on rejection.
        onBeforeTabSwitchRef.current.call(undefined).then(doOpen, () => {
          /* aborted by failed flush */
        });
      } else {
        doOpen();
      }
    },
    [maxTabs, notifyChange],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      const prev = tabsRef.current;
      const tabIndex = prev.findIndex(t => t.id === tabId);
      if (tabIndex === -1) return;

      const nextTabs = prev.filter(t => t.id !== tabId);
      const currentActiveId = activeTabIdRef.current;

      let nextActiveId: string | null;
      if (currentActiveId === tabId && nextTabs.length > 0) {
        const newActiveIndex = Math.min(tabIndex, nextTabs.length - 1);
        nextActiveId = nextTabs[newActiveIndex].id;
      } else if (nextTabs.length === 0) {
        nextActiveId = null;
      } else {
        nextActiveId = currentActiveId;
      }

      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      if (nextActiveId !== currentActiveId || nextTabs.length === 0) {
        setActiveTabIdInternal(nextActiveId);
      }
      notifyChange(nextTabs, nextActiveId);

      // This close emptied the list — let an opt-in consumer (the preview
      // drawer) dismiss itself. The `tabIndex === -1` guard above ensures
      // a tab was actually removed before we reach here.
      if (nextTabs.length === 0) {
        onTabsEmptiedByCloseRef.current?.();
      }
    },
    [notifyChange],
  );

  const closeAllTabs = useCallback(() => {
    tabsRef.current = [];
    setTabs([]);
    setActiveTabIdInternal(null);
    notifyChange([], null);
  }, [notifyChange]);

  const closeActiveTab = useCallback(() => {
    const currentActiveId = activeTabIdRef.current;
    if (!currentActiveId) return;
    closeTab(currentActiveId);
  }, [closeTab]);

  const setActiveTab = useCallback(
    (tabId: string) => {
      const currentActiveId = activeTabIdRef.current;
      if (currentActiveId === tabId) return;

      const doSwitch = () => {
        const current = tabsRef.current;
        if (!current.some(t => t.id === tabId)) return;
        setActiveTabIdInternal(tabId);
        notifyChange(current, tabId);
      };

      if (onBeforeTabSwitchRef.current) {
        // onBeforeTabSwitch may reject (Class A Batch 1). See openDocument
        // above for the two-arg .then rationale.
        onBeforeTabSwitchRef.current.call(undefined).then(doSwitch, () => {
          /* aborted by failed flush */
        });
      } else {
        doSwitch();
      }
    },
    [notifyChange],
  );

  const setActiveTabByIndex = useCallback((index: number) => {
    const currentTabs = tabsRef.current;
    if (index < 1 || index > currentTabs.length) return;
    const target = currentTabs[index - 1];
    if (!target) return;
    setActiveTab(target.id);
  }, [setActiveTab]);

  return {
    tabs,
    activeTabId,
    activeDocumentPath,
    hasMultipleTabs,
    openDocument,
    closeTab,
    closeActiveTab,
    closeAllTabs,
    setActiveTab,
    setActiveTabByIndex,
  };
}
