import { useEffect, useMemo, useState } from 'react';
import { useAuthStore, useOfflineQueueStore, createLogger } from '@rebel/cloud-client';
import type { QueueItem } from '@rebel/cloud-client';
import { useNetworkContext } from '../context/NetworkContext';
import { readMeetingManifest } from '../utils/meetingManifest';

const log = createLogger('meetingHealthIndicator');

const CLOUD_STATUS_POLL_INTERVAL_MS = 30_000;
const STALE_CLOUD_ACK_THRESHOLD_MS = 120_000;

export type MeetingHealthStatus = 'connected' | 'uploading' | 'offline' | 'error';

export interface MeetingHealthIndicatorState {
  status: MeetingHealthStatus;
  label: string;
  pendingChunks: number;
  failedChunks: number;
  lastCloudAckAgeMs: number | null;
}

interface CloudSessionStatusResponse {
  status?: string;
  chunksReceived?: number;
  lastChunkReceivedAt?: string;
  error?: string;
}

export interface UseMeetingHealthIndicatorOptions {
  meetingSessionId: string | null;
  isRecording: boolean;
}

export function deriveMeetingHealthStatus(input: {
  isOnline: boolean;
  pendingChunks: number;
  failedChunks: number;
  cloudStatus?: string;
  lastCloudAckAgeMs: number | null;
}): MeetingHealthStatus {
  if (input.failedChunks > 0 || input.cloudStatus === 'failed') return 'error';
  if (!input.isOnline) return 'offline';
  if (input.lastCloudAckAgeMs != null && input.lastCloudAckAgeMs > STALE_CLOUD_ACK_THRESHOLD_MS) {
    return 'uploading';
  }
  if (input.pendingChunks > 2) return 'uploading';
  return 'connected';
}

function getLabel(status: MeetingHealthStatus, pendingChunks: number): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'uploading':
      return pendingChunks > 0 ? `Uploading (${pendingChunks} pending)` : 'Uploading';
    case 'offline':
      return 'Offline';
    case 'error':
      return 'Upload error';
  }
}

function normalizeChunkMetadata(item: QueueItem): { meetingSessionId: string } | null {
  if (item.type !== 'meeting-chunk') return null;
  const metadata = item.metadata as { meetingSessionId?: unknown };
  if (!metadata || typeof metadata.meetingSessionId !== 'string') return null;
  return { meetingSessionId: metadata.meetingSessionId };
}

export function useMeetingHealthIndicator(
  options: UseMeetingHealthIndicatorOptions,
): MeetingHealthIndicatorState {
  log.info('useMeetingHealthIndicator called', { meetingSessionId: options.meetingSessionId, isRecording: options.isRecording });
  const { meetingSessionId, isRecording } = options;
  const { isOnline } = useNetworkContext();
  const queueItems = useOfflineQueueStore((state) => state.items);

  const [manifestStartTime, setManifestStartTime] = useState<number | null>(null);
  const [cloudStatus, setCloudStatus] = useState<CloudSessionStatusResponse | null>(null);
  const [lastCloudAckAtMs, setLastCloudAckAtMs] = useState<number | null>(null);

  const cloudUrl = useAuthStore((state) => state.cloudUrl);
  const token = useAuthStore((state) => state.token);

  const meetingChunkItems = useMemo(() => {
    if (!meetingSessionId) return [];
    return queueItems.filter((item) => {
      const metadata = normalizeChunkMetadata(item);
      return metadata?.meetingSessionId === meetingSessionId;
    });
  }, [meetingSessionId, queueItems]);

  const pendingChunks = useMemo(
    () => meetingChunkItems.filter((item) => !item.isPermanentFailure).length,
    [meetingChunkItems],
  );
  const failedChunks = useMemo(
    () => meetingChunkItems.filter((item) => item.isPermanentFailure).length,
    [meetingChunkItems],
  );

  useEffect(() => {
    if (!meetingSessionId || !isRecording || !cloudUrl || !token) {
      setCloudStatus(null);
      setLastCloudAckAtMs(null);
      return;
    }

    let cancelled = false;

    const pollCloudStatus = async (): Promise<void> => {
      try {
        const manifest = await readMeetingManifest(meetingSessionId);
        if (cancelled || !manifest) return;
        setManifestStartTime(manifest.startTime);

        if (!manifest.cloudSessionId) {
          return;
        }

        const response = await fetch(
          `${cloudUrl}/api/meeting/session/${manifest.cloudSessionId}/status`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        );
        if (!response.ok) return;

        const body = await response.json() as CloudSessionStatusResponse;
        if (cancelled) return;
        setCloudStatus(body);

        if (body.lastChunkReceivedAt) {
          const parsed = new Date(body.lastChunkReceivedAt).getTime();
          if (Number.isFinite(parsed) && parsed > 0) {
            setLastCloudAckAtMs(parsed);
          }
        }
      } catch (err) {
        log.warn('Failed to poll meeting cloud status', {
          meetingSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    void pollCloudStatus();
    const timer = setInterval(() => {
      void pollCloudStatus();
    }, CLOUD_STATUS_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [cloudUrl, isRecording, meetingSessionId, token]);

  const lastCloudAckAgeMs = useMemo(() => {
    if (lastCloudAckAtMs) {
      return Date.now() - lastCloudAckAtMs;
    }
    if (manifestStartTime && pendingChunks > 0) {
      return Date.now() - manifestStartTime;
    }
    return null;
  }, [lastCloudAckAtMs, manifestStartTime, pendingChunks]);

  const status = useMemo(
    () =>
      deriveMeetingHealthStatus({
        isOnline,
        pendingChunks,
        failedChunks,
        cloudStatus: cloudStatus?.status,
        lastCloudAckAgeMs,
      }),
    [cloudStatus?.status, failedChunks, isOnline, lastCloudAckAgeMs, pendingChunks],
  );

  return {
    status,
    label: getLabel(status, pendingChunks),
    pendingChunks,
    failedChunks,
    lastCloudAckAgeMs,
  };
}
