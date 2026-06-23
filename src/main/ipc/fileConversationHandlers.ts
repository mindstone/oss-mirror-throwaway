/**
 * File-Conversation IPC Handlers
 *
 * Handles tracking associations between files and conversations.
 */

import { registerHandler } from './utils/registerHandler';
import {
  trackFileConversation,
  getFileConversations,
  getMostRecentForFile
} from '../services/fileConversationStore';

export function registerFileConversationHandlers(): void {
  registerHandler(
    'file-conversation:track',
    async (_event, payload: { filePath: string; sessionId: string; sessionTitle: string; source: 'write' | 'open' }) => {
      const { filePath, sessionId, sessionTitle, source } = payload;
      trackFileConversation(filePath, sessionId, sessionTitle, source);
      return { success: true };
    }
  );

  registerHandler(
    'file-conversation:get-for-file',
    async (_event, payload: { filePath: string }) => {
      const { filePath } = payload;
      const links = getFileConversations(filePath);
      const mostRecent = getMostRecentForFile(filePath);
      return { links, mostRecent };
    }
  );
}
