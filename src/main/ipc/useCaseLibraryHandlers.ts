/**
 * Use Case Library Domain IPC Handlers
 *
 * Provides access to the self-curating use case library.
 *
 * @see src/main/services/useCaseLibraryStore.ts
 */

import type { HandlerInvokeEvent } from '@core/handlerRegistry';
import { registerHandler } from './utils/registerHandler';
import { useCaseLibraryChannels } from '@shared/ipc/channels/useCaseLibrary';
import {
  getAllUseCases,
  getUseCasesForDisplay,
  getGroupedUseCases,
  recordUseCaseUsage,
  markUseCaseSeen,
  dismissUseCase,
  getLibraryStats,
  needsMigration,
  type UseCaseRecord
} from '../services/useCaseLibraryStore';

/** Strip embedding from records for IPC (large arrays, not needed in renderer) */
const stripEmbedding = (record: UseCaseRecord): Omit<UseCaseRecord, 'embedding'> => {
  const { embedding: _embedding, ...rest } = record;
  return rest;
};

export function registerUseCaseLibraryHandlers(): void {
  const getAllChannel = useCaseLibraryChannels['useCaseLibrary:get-all'];
  registerHandler(
    getAllChannel.channel,
    async (_event: HandlerInvokeEvent, _request: unknown) => {
      const useCases = getAllUseCases().map(stripEmbedding);
      return { useCases };
    }
  );

  const getForDisplayChannel = useCaseLibraryChannels['useCaseLibrary:get-for-display'];
  registerHandler(
    getForDisplayChannel.channel,
    async (_event: HandlerInvokeEvent, request: unknown) => {
      const validated = getForDisplayChannel.request.parse(request);
      const useCases = getUseCasesForDisplay(validated.limit ?? 3).map(stripEmbedding);
      return { useCases };
    }
  );

  const getGroupedChannel = useCaseLibraryChannels['useCaseLibrary:get-grouped'];
  registerHandler(
    getGroupedChannel.channel,
    async (_event: HandlerInvokeEvent, _request: unknown) => {
      const grouped = getGroupedUseCases();
      return {
        new: grouped.new.map(stripEmbedding),
        frequent: grouped.frequent.map(stripEmbedding),
        other: grouped.other.map(stripEmbedding),
      };
    }
  );

  const recordUsageChannel = useCaseLibraryChannels['useCaseLibrary:record-usage'];
  registerHandler(
    recordUsageChannel.channel,
    async (_event: HandlerInvokeEvent, request: unknown) => {
      const validated = recordUsageChannel.request.parse(request);
      recordUseCaseUsage(validated.id);
      return { success: true };
    }
  );

  const markSeenChannel = useCaseLibraryChannels['useCaseLibrary:mark-seen'];
  registerHandler(
    markSeenChannel.channel,
    async (_event: HandlerInvokeEvent, request: unknown) => {
      const validated = markSeenChannel.request.parse(request);
      markUseCaseSeen(validated.id);
      return { success: true };
    }
  );

  const dismissChannel = useCaseLibraryChannels['useCaseLibrary:dismiss'];
  registerHandler(
    dismissChannel.channel,
    async (_event: HandlerInvokeEvent, request: unknown) => {
      const validated = dismissChannel.request.parse(request);
      dismissUseCase(validated.id);
      return { success: true };
    }
  );

  const getStatsChannel = useCaseLibraryChannels['useCaseLibrary:get-stats'];
  registerHandler(
    getStatsChannel.channel,
    async (_event: HandlerInvokeEvent, _request: unknown) => {
      return getLibraryStats();
    }
  );

  const needsMigrationChannel = useCaseLibraryChannels['useCaseLibrary:needs-migration'];
  registerHandler(
    needsMigrationChannel.channel,
    async (_event: HandlerInvokeEvent, _request: unknown) => {
      return { needsMigration: needsMigration() };
    }
  );
}
