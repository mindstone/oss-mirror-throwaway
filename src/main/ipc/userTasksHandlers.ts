/**
 * User Tasks IPC Handlers
 *
 * Handles user task CRUD operations for the Scratchpad tasks panel.
 */

import type { HandlerInvokeEvent } from '@core/handlerRegistry';
import {
  getUserTasksState,
  addUserTask,
  updateUserTask,
  deleteUserTask,
} from '../services/userTasksStore';
import { registerHandler } from './utils/registerHandler';
import { isNonEmptyString } from '@shared/utils/validators';

export interface UserTasksHandlerDeps {
  // No deps needed for now
}

export function registerUserTasksHandlers(_deps: UserTasksHandlerDeps = {}): void {
  registerHandler('user-tasks:load', (_event: HandlerInvokeEvent) => {
    return getUserTasksState();
  });

  registerHandler(
    'user-tasks:add',
    (_event: HandlerInvokeEvent, payload: { title: string; dueDate?: number | null }) => {
      if (!payload || !isNonEmptyString(payload.title)) {
        throw new Error('Task title is required.');
      }
      return addUserTask({
        title: payload.title,
        dueDate: payload.dueDate ?? null,
      });
    }
  );

  registerHandler(
    'user-tasks:update',
    (
      _event: HandlerInvokeEvent,
      payload: {
        id: string;
        patch: {
          title?: string;
          description?: string;
          status?: 'todo' | 'in_progress' | 'done' | 'cancelled';
          dueDate?: number | null;
          priority?: 'urgent' | 'high' | 'medium' | 'low' | 'none';
          labels?: string[];
        };
      }
    ) => {
      if (!payload || !isNonEmptyString(payload.id)) {
        throw new Error('Task ID is required.');
      }
      return updateUserTask(payload.id, payload.patch);
    }
  );

  registerHandler('user-tasks:delete', (_event: HandlerInvokeEvent, taskId: string) => {
    if (!isNonEmptyString(taskId)) {
      throw new Error('Task ID is required.');
    }
    return deleteUserTask(taskId);
  });
}
