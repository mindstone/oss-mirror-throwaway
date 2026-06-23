import { useCallback, useEffect, useRef, useState } from 'react';
import { fireAndForget } from '@shared/utils/fireAndForget';
import type { OpenSettingsDialogOptions } from '@renderer/features/settings/hooks/useSettingsFeature';

type StartFreshSessionOptions = {
  showHistory?: boolean;
};

export interface UseLibraryCreateActionsOptions {
  startFreshSession: (options?: StartFreshSessionOptions) => string;
  setSessionDraft: (sessionId: string, draft: string) => void;
  canCreateAdditionalSpaces: boolean;
  setActiveSurface: (surface: string) => void;
  openSettingsDialog: (
    tab?: string,
    section?: string,
    options?: OpenSettingsDialogOptions,
  ) => Promise<void>;
  requestPendingSpacesAction: (action: 'add') => void;
  showToast: (options: { title: string }) => void;
}

export interface LibraryCreateActions {
  createActionPending: boolean;
  createSkill: () => void;
  createMemory: () => void;
  addSpaceFromLibrary: () => void;
}

const CREATE_SKILL_DRAFT =
  '@`rebel-system/skills/documentation/write-skill.md` I want to create a new skill. ';
const CREATE_MEMORY_DRAFT = 'Remember this: ';
const ADD_SPACE_ENTITLEMENT_MESSAGE =
  'Additional spaces require a Teams license. Contact hello@mindstone.com to upgrade.';
const CREATE_ACTION_LOCK_MS = 300;

export function useLibraryCreateActions({
  startFreshSession,
  setSessionDraft,
  canCreateAdditionalSpaces,
  setActiveSurface,
  openSettingsDialog,
  requestPendingSpacesAction,
  showToast,
}: UseLibraryCreateActionsOptions): LibraryCreateActions {
  const creationInFlightRef = useRef(false);
  const releaseTimerRef = useRef<number | null>(null);
  const [createActionPending, setCreateActionPending] = useState(false);

  const releaseCreationLock = useCallback(() => {
    creationInFlightRef.current = false;
    setCreateActionPending(false);
  }, []);

  useEffect(() => () => {
    if (releaseTimerRef.current !== null) {
      window.clearTimeout(releaseTimerRef.current);
    }
  }, []);

  const createPrefilledSession = useCallback((draft: string) => {
    if (creationInFlightRef.current) {
      return;
    }

    creationInFlightRef.current = true;
    setCreateActionPending(true);

    try {
      const sessionId = startFreshSession({ showHistory: true });
      setSessionDraft(sessionId, draft);
    } finally {
      if (releaseTimerRef.current !== null) {
        window.clearTimeout(releaseTimerRef.current);
      }
      releaseTimerRef.current = window.setTimeout(() => {
        releaseTimerRef.current = null;
        releaseCreationLock();
      }, CREATE_ACTION_LOCK_MS);
    }
  }, [releaseCreationLock, setSessionDraft, startFreshSession]);

  const createSkill = useCallback(() => {
    createPrefilledSession(CREATE_SKILL_DRAFT);
  }, [createPrefilledSession]);

  const createMemory = useCallback(() => {
    createPrefilledSession(CREATE_MEMORY_DRAFT);
  }, [createPrefilledSession]);

  const addSpaceFromLibrary = useCallback(() => {
    if (!canCreateAdditionalSpaces) {
      showToast({ title: ADD_SPACE_ENTITLEMENT_MESSAGE });
      return;
    }

    setActiveSurface('settings');
    requestPendingSpacesAction('add');
    fireAndForget(
      openSettingsDialog('spaces', 'spaces', {
        source: 'link',
        interactionType: 'programmatic',
      }),
      'openSpacesFromLibrary',
    );
  }, [
    canCreateAdditionalSpaces,
    openSettingsDialog,
    requestPendingSpacesAction,
    setActiveSurface,
    showToast,
  ]);

  return {
    createActionPending,
    createSkill,
    createMemory,
    addSpaceFromLibrary,
  };
}
