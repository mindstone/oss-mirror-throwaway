/**
 * Todoist IPC Handlers
 *
 * Handles IPC requests for Todoist integration.
 */

import { ipcMain } from 'electron';
import { createScopedLogger } from '@core/logger';
import {
  checkTodoistConnection,
  getAllTodoistTasks,
  createTodoistTask,
  completeTodoistTask,
  deleteTodoistTask,
  type TodoistTask,
} from '@main/services/todoistApiService';
import type { TodoistConnectionStatus } from '@shared/ipc/channels/todoist';

const log = createScopedLogger({ service: 'todoistHandlers' });

export const registerTodoistHandlers = (): void => {
  log.info('Registering Todoist IPC handlers');

  ipcMain.handle('todoist:check-connection', async (): Promise<TodoistConnectionStatus> => {
    log.debug('Checking Todoist connection');
    return checkTodoistConnection();
  });

  ipcMain.handle('todoist:get-tasks', async (): Promise<TodoistTask[]> => {
    log.debug('Fetching all Todoist tasks');
    return getAllTodoistTasks();
  });

  ipcMain.handle('todoist:create-task', async (_event, request: { content: string; due_date?: string }): Promise<TodoistTask> => {
    log.debug({ content: request.content }, 'Creating Todoist task');
    const status = await checkTodoistConnection();
    if (!status.connected) {
      throw new Error('Todoist not connected');
    }
    return createTodoistTask({
      content: request.content,
      due_date: request.due_date,
      project_id: status.inboxProjectId,
    });
  });

  ipcMain.handle('todoist:complete-task', async (_event, request: { taskId: string }): Promise<{ success: boolean }> => {
    log.debug({ taskId: request.taskId }, 'Completing Todoist task');
    try {
      await completeTodoistTask(request.taskId);
      return { success: true };
    } catch (error) {
      log.error({ err: error, taskId: request.taskId }, 'Failed to complete Todoist task');
      return { success: false };
    }
  });

  ipcMain.handle('todoist:delete-task', async (_event, request: { taskId: string }): Promise<{ success: boolean }> => {
    log.debug({ taskId: request.taskId }, 'Deleting Todoist task');
    try {
      await deleteTodoistTask(request.taskId);
      return { success: true };
    } catch (error) {
      log.error({ err: error, taskId: request.taskId }, 'Failed to delete Todoist task');
      return { success: false };
    }
  });
};
