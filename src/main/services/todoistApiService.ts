/**
 * Todoist API Service
 *
 * Makes direct REST API calls to Todoist for the Tasks panel.
 * Uses the OAuth token obtained via Super-MCP.
 *
 * API Reference: https://developer.todoist.com/api/v1/
 */

import { createScopedLogger } from '@core/logger';
import { getTodoistAccessToken, isTodoistAuthenticated } from './todoistTokenService';

const log = createScopedLogger({ service: 'todoistApiService' });

const TODOIST_API_BASE = 'https://api.todoist.com/api/v1';

export interface TodoistTask {
  id: string;
  content: string;
  description: string;
  project_id: string;
  section_id: string | null;
  parent_id: string | null;
  labels: string[];
  priority: 1 | 2 | 3 | 4; // 1 = urgent (p1), 4 = no priority
  due: {
    date: string;
    string: string;
    datetime?: string;
    timezone?: string;
  } | null;
  is_completed: boolean;
  created_at: string;
  order: number;
}

export interface TodoistProject {
  id: string;
  name: string;
  is_inbox_project?: boolean;
  order?: number;
  // v1 API uses different field names
  default_order?: number;
}

// API v1 returns paginated responses
interface PaginatedResponse<T> {
  results: T[];
  next_cursor?: string;
}

export interface CreateTaskInput {
  content: string;
  description?: string;
  due_date?: string; // YYYY-MM-DD
  due_string?: string; // "tomorrow", "next monday"
  priority?: 1 | 2 | 3 | 4;
  project_id?: string;
  labels?: string[];
}

export type TodoistConnectionStatus = 
  | { connected: false; reason: 'not_authenticated' }
  | { connected: false; reason: 'api_error'; error: string }
  | { connected: true; inboxProjectId: string };

/**
 * Make an authenticated request to the Todoist API.
 */
const todoistFetch = async <T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> => {
  const token = await getTodoistAccessToken();
  if (!token) {
    throw new Error('Todoist not authenticated');
  }

  const url = `${TODOIST_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    log.error({ status: response.status, error: errorText }, 'Todoist API error');
    throw new Error(`Todoist API error: ${response.status} ${errorText}`);
  }

  // Some endpoints return empty response (204 No Content)
  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
};

/**
 * Check connection status and get the Inbox project ID.
 */
export const checkTodoistConnection = async (): Promise<TodoistConnectionStatus> => {
  log.info('Checking Todoist connection...');
  const isAuth = await isTodoistAuthenticated();
  log.info({ isAuth }, 'Todoist authentication check result');
  
  if (!isAuth) {
    return { connected: false, reason: 'not_authenticated' };
  }

  try {
    log.info('Fetching Todoist projects to verify connection...');
    // API v1 returns paginated response
    const response = await todoistFetch<PaginatedResponse<TodoistProject>>('/projects');
    const projects = response.results;
    log.info({ projectCount: projects.length }, 'Fetched Todoist projects');
    
    // In API v1, Inbox is identified by name "Inbox" (first project)
    const inbox = projects.find(p => p.name === 'Inbox') || projects[0];
    
    if (!inbox) {
      log.warn('Todoist connected but no projects found');
      return { connected: false, reason: 'api_error', error: 'No projects found' };
    }

    log.info({ inboxProjectId: inbox.id, inboxName: inbox.name }, 'Todoist connection verified');
    return { connected: true, inboxProjectId: inbox.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ err: error }, 'Todoist connection check failed');
    return { connected: false, reason: 'api_error', error: message };
  }
};

/**
 * Get upcoming tasks from Todoist (today, overdue, and next 7 days).
 * Uses the filter endpoint to match what users see in Todoist's "Upcoming" view.
 */
export const getAllTodoistTasks = async (): Promise<TodoistTask[]> => {
  const isAuth = await isTodoistAuthenticated();
  if (!isAuth) {
    return [];
  }

  try {
    // Use filter endpoint to get today, overdue, and upcoming 7 days
    // This matches what users expect to see as "upcoming" tasks
    const query = encodeURIComponent('today | overdue | 7 days');
    const response = await todoistFetch<PaginatedResponse<TodoistTask>>(`/tasks/filter?query=${query}`);
    log.info({ taskCount: response.results.length }, 'Fetched upcoming Todoist tasks');
    return response.results;
  } catch (error) {
    log.error({ err: error }, 'Failed to fetch Todoist tasks');
    return [];
  }
};

/**
 * Create a new task in Todoist.
 */
export const createTodoistTask = async (input: CreateTaskInput): Promise<TodoistTask> => {
  const task = await todoistFetch<TodoistTask>('/tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  log.info({ taskId: task.id, content: task.content }, 'Created Todoist task');
  return task;
};

/**
 * Complete (close) a task in Todoist.
 */
export const completeTodoistTask = async (taskId: string): Promise<void> => {
  await todoistFetch<void>(`/tasks/${taskId}/close`, {
    method: 'POST',
  });
  log.info({ taskId }, 'Completed Todoist task');
};

/**
 * Delete a task in Todoist.
 */
export const deleteTodoistTask = async (taskId: string): Promise<void> => {
  await todoistFetch<void>(`/tasks/${taskId}`, {
    method: 'DELETE',
  });
  log.info({ taskId }, 'Deleted Todoist task');
};
