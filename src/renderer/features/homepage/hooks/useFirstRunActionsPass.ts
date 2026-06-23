import { useEffect, useRef } from 'react';
import type { AppSettings, FirstRunActionsPassState } from '@shared/types';
import type { UseMeetingCacheResult } from '../../usecases/hooks/useMeetingCache';
import type { UseHomepageInboxResult } from './useHomepageInboxItems';

const MAX_FIRST_RUN_ITEMS = 3;
const FIRST_RUN_RUNNING_STALE_MS = 45 * 1000;

type SaveSettingsWith = (
  updater?: (draft: AppSettings) => AppSettings,
  options?: { keepOpen?: boolean }
) => Promise<void>;

type ConnectorActionAvailability = {
  hasEmail: boolean;
  hasMessaging: boolean;
  hasDocsOrWork: boolean;
};

interface FirstRunActionsPassOptions {
  settings: AppSettings | null;
  saveSettingsWith: SaveSettingsWith;
  enabled: boolean;
  connectedConnectorCount: number;
  connectorActionAvailability?: ConnectorActionAvailability;
  meetingCache: UseMeetingCacheResult;
  inboxResult: UseHomepageInboxResult;
}

interface FirstRunCandidate {
  id: string;
  title: string;
  text: string;
  dueBy?: number;
}

async function createFirstRunActionItems(candidates: FirstRunCandidate[]): Promise<string[]> {
  const createdIds: string[] = [];

  for (const candidate of candidates) {
    const state = await window.inboxApi.add({
      id: candidate.id,
      title: candidate.title,
      text: candidate.text,
      important: true,
      urgent: false,
      category: 'follow-up',
      tags: ['first-run'],
      dueBy: candidate.dueBy,
    });
    if (state.items.some((item) => item.id === candidate.id)) {
      createdIds.push(candidate.id);
    }
  }

  return createdIds;
}

function resolveActivationId(settings: AppSettings): string | null {
  const completedAt = settings.onboardingFirstCompletedAt ?? settings.onboardingCompletedAt;
  return typeof completedAt === 'number' ? `onboarding:${completedAt}` : null;
}

export function normalizeFirstRunActionTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(prep(?:are)?(?:\s+for)?|review|check|follow up on|follow up with)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildFirstRunMeetingCandidates(meetingCache: UseMeetingCacheResult): FirstRunCandidate[] {
  const now = Date.now();

  return meetingCache.meetings
    .filter((meeting) => {
      const startMs = new Date(meeting.startTime).getTime();
      if (!Number.isFinite(startMs) || startMs <= now) return false;
      const participantCount = meeting.participants.length + (meeting.participantEmails?.length ?? 0);
      return participantCount > 0;
    })
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
    .slice(0, MAX_FIRST_RUN_ITEMS)
    .map((meeting) => {
      const startMs = new Date(meeting.startTime).getTime();
      const title = `Prep for ${meeting.title}`;
      return {
        id: crypto.randomUUID(),
        title,
        text: `First setup check found "${meeting.title}" coming up. Ask Rebel to pull together the context before you walk in pretending you remembered everything.`,
        dueBy: Number.isFinite(startMs) ? startMs : undefined,
      };
    });
}

export function filterFirstRunCandidates(
  candidates: FirstRunCandidate[],
  existingTitles: ReadonlySet<string>
): FirstRunCandidate[] {
  return candidates
    .filter((candidate) => !existingTitles.has(normalizeFirstRunActionTitle(candidate.title)))
    .slice(0, MAX_FIRST_RUN_ITEMS);
}

export function shouldStartFirstRunActionsPass(settings: AppSettings, activationId: string): boolean {
  const existing = settings.firstRunActionsPass;
  if (!existing) return true;
  if (existing.activationId !== activationId) return true;
  return existing.status === 'pending';
}

export function isFirstRunActionsPassStale(
  pass: FirstRunActionsPassState | undefined,
  now = Date.now()
): boolean {
  return (
    pass?.status === 'running' &&
    (
      typeof pass.startedAt !== 'number' ||
      now - pass.startedAt > FIRST_RUN_RUNNING_STALE_MS
    )
  );
}

function completedBeforeConnectors(pass: FirstRunActionsPassState | undefined, activationId: string): boolean {
  if (pass?.activationId !== activationId || pass.status !== 'completed') return false;
  if ((pass.itemsCreated ?? 0) > 0) return false;
  return pass.sourceResults?.some(
    (source) => source.source === 'connectors' && source.status === 'not_available',
  ) === true;
}

function preserveCompletedPass(
  current: AppSettings,
  activationId: string,
  nextPass: FirstRunActionsPassState
): AppSettings {
  const existing = current.firstRunActionsPass;
  if (
    existing?.activationId === activationId &&
    existing.status === 'completed' &&
    !completedBeforeConnectors(existing, activationId)
  ) {
    return current;
  }
  return { ...current, firstRunActionsPass: nextPass };
}

export function useFirstRunActionsPass(options: FirstRunActionsPassOptions): void {
  const inFlightRef = useRef(false);
  const {
    settings,
    saveSettingsWith,
    enabled,
    connectedConnectorCount,
    meetingCache,
    inboxResult,
  } = options;
  const activationId = settings ? resolveActivationId(settings) : null;
  const passKey = settings?.firstRunActionsPass
    ? `${settings.firstRunActionsPass.activationId}:${settings.firstRunActionsPass.status}`
    : 'none';

  useEffect(() => {
    if (!enabled || !settings || !activationId || inFlightRef.current) return;
    if (!settings.onboardingCompleted) return;

    if (isFirstRunActionsPassStale(settings.firstRunActionsPass)) {
      void saveSettingsWith(
        (current) =>
          preserveCompletedPass(current, activationId, {
            status: 'failed',
            activationId,
            startedAt: current.firstRunActionsPass?.startedAt,
            completedAt: Date.now(),
            itemsCreated: current.firstRunActionsPass?.itemsCreated ?? 0,
            createdItemIds: current.firstRunActionsPass?.createdItemIds,
            error: 'First setup check timed out before it could finish.',
            sourceResults: [
              { source: 'calendar', status: 'failed', error: 'First setup check timed out before it could finish.' },
              { source: 'inbox', status: 'failed', error: 'First setup check timed out before it could finish.' },
            ],
          }),
        { keepOpen: true }
      );
      return;
    }

    if (settings.firstRunActionsPass?.activationId === activationId) {
      const pass = settings.firstRunActionsPass;
      if (pass.status === 'running') {
        const startedAt = pass.startedAt ?? Date.now();
        const remainingMs = Math.max(0, FIRST_RUN_RUNNING_STALE_MS - (Date.now() - startedAt));
        const timeoutId = setTimeout(() => {
          void saveSettingsWith(
            (current) =>
              preserveCompletedPass(current, activationId, {
                status: 'failed',
                activationId,
                startedAt: current.firstRunActionsPass?.startedAt ?? startedAt,
                completedAt: Date.now(),
                itemsCreated: current.firstRunActionsPass?.itemsCreated ?? 0,
                createdItemIds: current.firstRunActionsPass?.createdItemIds,
                error: 'First setup check timed out before it could finish.',
                sourceResults: [
                  { source: 'calendar', status: 'failed', error: 'First setup check timed out before it could finish.' },
                  { source: 'inbox', status: 'failed', error: 'First setup check timed out before it could finish.' },
                ],
              }),
            { keepOpen: true }
          );
        }, remainingMs);
        return () => clearTimeout(timeoutId);
      }
    }

    if (meetingCache.isLoading || inboxResult.isLoading || meetingCache.isStale) {
      return;
    }

    const shouldRestartAfterConnectorAdded =
      connectedConnectorCount > 0 &&
      completedBeforeConnectors(settings.firstRunActionsPass, activationId);
    if (!shouldRestartAfterConnectorAdded && !shouldStartFirstRunActionsPass(settings, activationId)) return;

    inFlightRef.current = true;
    const startedAt = Date.now();

    void (async () => {
      try {
        await saveSettingsWith(
          (current) =>
            preserveCompletedPass(current, activationId, {
              status: 'running',
              activationId,
              startedAt,
              sourceResults: [
                { source: 'connectors', status: connectedConnectorCount > 0 ? 'checked' : 'not_available' },
              { source: 'calendar', status: 'checked' },
              ],
            }),
          { keepOpen: true }
        );

        const existingTitles = new Set(
          inboxResult.items.map((item) => normalizeFirstRunActionTitle(item.title)),
        );
        const candidates = filterFirstRunCandidates(
          buildFirstRunMeetingCandidates(meetingCache),
          existingTitles,
        );
        const createdItemIds = await createFirstRunActionItems(candidates);
        const completedAt = Date.now();
        await saveSettingsWith(
          (current) => {
            const existing = current.firstRunActionsPass;
            if (existing?.activationId === activationId && existing.status === 'completed') {
              return current;
            }
            return {
              ...current,
              firstRunActionsPass: {
                status: 'completed',
                activationId,
                startedAt,
                completedAt,
                itemsCreated: createdItemIds.length,
                createdItemIds,
                sourceResults: [
                  { source: 'connectors', status: connectedConnectorCount > 0 ? 'checked' : 'not_available' },
                  {
                    source: 'calendar',
                    status: 'checked',
                    itemsCreated: createdItemIds.length,
                  },
                  { source: 'inbox', status: 'checked' },
                ],
              },
            };
          },
          { keepOpen: true }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to check first-run actions.';
        try {
          await saveSettingsWith(
            (current) => ({
              ...current,
              firstRunActionsPass: {
                status: 'failed',
                activationId,
                startedAt,
                completedAt: Date.now(),
                itemsCreated: 0,
                createdItemIds: [],
                error: message,
                sourceResults: [
                  { source: 'calendar', status: 'failed', error: message },
                  { source: 'inbox', status: 'failed', error: message },
                ],
              },
            }),
            { keepOpen: true }
          );
        } catch (saveError) {
          console.warn('[Homepage] Failed to persist first setup check failure:', saveError);
        }
      } finally {
        inFlightRef.current = false;
      }
    })();
  // passKey intentionally retriggers when persisted status changes; inFlightRef prevents duplicate runs.
  }, [
    activationId,
    connectedConnectorCount,
    enabled,
    inboxResult,
    meetingCache,
    passKey,
    saveSettingsWith,
    settings,
  ]);
}
