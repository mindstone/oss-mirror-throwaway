// mobile/src/context/MeetingRecordingContext.tsx

/**
 * MeetingRecordingProvider — lifts `useMeetingRecording()` to root layout level
 * so recording survives screen navigation. Syncs state to the global Zustand
 * `activeRecordingStore` for lightweight cross-component observation (banner, tab bar).
 */

import React, { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react';
import { useMeetingRecording, type MeetingRecordingState } from '../hooks/useMeetingRecording';
import { useActiveRecordingStore } from '../stores/activeRecordingStore';
import { updateMeetingManifest } from '../utils/meetingManifest';
import {
  createLogger,
  asLocalRecordingId,
  asCompanionConversationId,
} from '@rebel/cloud-client';
import type {
  LocalRecordingId,
  CloudMeetingSessionId,
  CompanionConversationId,
} from '@rebel/cloud-client';

const log = createLogger('MeetingRecordingProvider');

export interface MeetingRecordingContextValue {
  state: MeetingRecordingState;
  isRecording: boolean;
  /** Mobile-local recording/manifest id (distinct from the cloud meeting id). */
  meetingSessionId: LocalRecordingId | null;
  /** Cloud meeting session id — the only id that crosses the wire on a turn. */
  meetingCloudSessionId: CloudMeetingSessionId | null;
  meetingTitle: string;
  companionSessionId: CompanionConversationId | null;
  error: string | null;
  startRecording: (title: string, companionSessionId?: string) => Promise<boolean>;
  stopRecording: () => void;
  setMeetingTitle: (title: string) => void;
}

const MeetingRecordingContext = createContext<MeetingRecordingContextValue | null>(null);

export function useMeetingRecordingContext(): MeetingRecordingContextValue {
  const ctx = useContext(MeetingRecordingContext);
  if (!ctx) {
    throw new Error('useMeetingRecordingContext must be used within a MeetingRecordingProvider');
  }
  return ctx;
}

export function MeetingRecordingProvider({ children }: { children: React.ReactNode }) {
  log.debug('RENDER start');
  const recording = useMeetingRecording();
  log.debug('useMeetingRecording returned', { state: recording.state, error: recording.error, meetingSessionId: recording.meetingSessionId });
  const [meetingTitle, setMeetingTitle] = useState('');
  const [companionSessionId, setCompanionSessionId] = useState<CompanionConversationId | null>(null);
  const meetingCloudSessionId = useActiveRecordingStore((s) => s.cloudSessionId);
  // `useMeetingRecording` returns a raw string id; brand it as the local id here,
  // the boundary where its provenance (on-device manifest) is known.
  const localRecordingId: LocalRecordingId | null = recording.meetingSessionId
    ? asLocalRecordingId(recording.meetingSessionId)
    : null;

  const { setRecording, clearRecording } = useActiveRecordingStore();

  // Track previous lifecycle state for edge detection.
  // "Lifecycle active" includes stopping (final chunk still saving) to prevent
  // premature store clear that would drop audio guards and hide banner.
  const isLifecycleActive = recording.state === 'recording'
    || recording.state === 'rotating'
    || recording.state === 'stopping'
    || recording.state === 'starting';
  const prevActiveRef = useRef(false);

  // Sync to Zustand store when recording lifecycle changes
  useEffect(() => {
    const wasActive = prevActiveRef.current;
    log.info('lifecycle-sync effect', { isLifecycleActive, wasActive, meetingSessionId: recording.meetingSessionId, state: recording.state });

    if (isLifecycleActive && recording.meetingSessionId) {
      if (!wasActive) {
        // Only set if not already set by the hook (synchronous path).
        const storeState = useActiveRecordingStore.getState();
        if (!storeState.isActive || storeState.meetingSessionId !== recording.meetingSessionId) {
          log.info('setRecording in store');
          setRecording(
            asLocalRecordingId(recording.meetingSessionId),
            Date.now(),
            meetingTitle,
            companionSessionId ?? undefined,
          );
        }
      }
      // Fill in companionSessionId if the hook set the store synchronously
      // without it (the hook doesn't know the companion ID — only the Context does).
      const storeState = useActiveRecordingStore.getState();
      if (storeState.isActive && companionSessionId && storeState.companionSessionId !== companionSessionId) {
        useActiveRecordingStore.getState().setCompanionSessionId(companionSessionId);
      }
    } else if (wasActive && !isLifecycleActive) {
      log.info('clearRecording in store');
      clearRecording();
    }

    prevActiveRef.current = isLifecycleActive;
  }, [isLifecycleActive, recording.meetingSessionId, meetingTitle, companionSessionId, setRecording, clearRecording]);

  // Mount/unmount tracking
  useEffect(() => {
    log.info('MOUNTED');
    return () => { log.info('UNMOUNTED'); };
  }, []);

  // On mount: clear stale store state (store says active but hook state is idle)
  useEffect(() => {
    const storeState = useActiveRecordingStore.getState();
    log.info('stale-store-check on mount', { storeIsActive: storeState.isActive, hookState: recording.state });
    if (storeState.isActive && recording.state === 'idle') {
      log.info('clearing stale store state');
      clearRecording();
    }
    // Only run on mount
     
  }, []);

  // Persist companionSessionId to meeting manifest once meetingSessionId is available.
  // This is an effect because meetingSessionId is set via setState in useMeetingRecording
  // and isn't available synchronously after startRecording() resolves.
  const manifestPersisted = useRef(false);
  useEffect(() => {
    if (companionSessionId && recording.meetingSessionId && !manifestPersisted.current) {
      manifestPersisted.current = true;
      void updateMeetingManifest(recording.meetingSessionId, (m) => ({
        ...m,
        companionSessionId,
      })).catch((err) => {
        log.warn('Failed to persist companionSessionId to manifest', { err: err instanceof Error ? err.message : String(err) });
      });
    }
    if (!recording.meetingSessionId) {
      manifestPersisted.current = false;
    }
  }, [companionSessionId, recording.meetingSessionId]);

  // Wrap startRecording to capture title and optional companionSessionId
  const startRecording = useCallback(
    async (title: string, cSessionId?: string): Promise<boolean> => {
      setMeetingTitle(title);
      if (cSessionId) {
        const companionId = asCompanionConversationId(cSessionId);
        setCompanionSessionId(companionId);
        useActiveRecordingStore.getState().setCompanionSessionId(companionId);
      }
      return recording.startRecording(title);
    },
    [recording.startRecording],
  );

  const stopRecording = useCallback(() => {
    recording.stopRecording();
    setMeetingTitle('');
    setCompanionSessionId(null);
  }, [recording.stopRecording]);

  const contextValue: MeetingRecordingContextValue = {
    state: recording.state,
    isRecording: recording.isRecording,
    meetingSessionId: localRecordingId,
    meetingCloudSessionId,
    meetingTitle,
    companionSessionId,
    error: recording.error,
    startRecording,
    stopRecording,
    setMeetingTitle,
  };

  return (
    <MeetingRecordingContext.Provider value={contextValue}>
      {children}
    </MeetingRecordingContext.Provider>
  );
}
