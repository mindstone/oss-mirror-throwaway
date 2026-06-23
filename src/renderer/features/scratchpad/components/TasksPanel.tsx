import React, { useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, Calendar, X, Loader2, ListTodo, Sparkles, Zap, ChevronDown, ChevronRight } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import { useTasks } from '../hooks/useTasks';
import { useConnectorSetupGuidance } from '@renderer/features/settings/hooks/useConnectorSetupGuidance';
import { ConnectorSetupDialog } from '@renderer/features/settings/components/ConnectorSetupDialog';
import type { UserTask } from '@shared/types';

import { DateTime } from 'luxon';
import styles from './TasksPanel.module.css';

const TODOIST_CARD_COLLAPSED_KEY = 'scratchpad:todoist-card-collapsed';

interface TasksPanelProps {
  showToast?: (options: { title: string }) => void;
  onAskRebel?: (prompt: string) => void;
}

const TODOIST_MCP_CONFIG = {
  name: 'Todoist',
  transport: 'http' as const,
  url: 'https://ai.todoist.net/mcp',
  description: 'Manage tasks and projects with Todoist',
  oauth: true,
};

const formatDueDate = (timestamp: number | null): string | null => {
  if (!timestamp) return null;
  const dt = DateTime.fromMillis(timestamp);
  const now = DateTime.now();
  const diff = dt.diff(now, 'days').days;

  if (diff < 0) {
    return `Overdue`;
  }
  if (diff < 1 && dt.hasSame(now, 'day')) {
    return 'Today';
  }
  if (diff < 2 && dt.hasSame(now.plus({ days: 1 }), 'day')) {
    return 'Tomorrow';
  }
  if (diff < 7) {
    return dt.toFormat('EEE');
  }
  return dt.toFormat('MMM d');
};

interface TaskItemProps {
  task: UserTask;
  onComplete: (id: string) => void;
  onDelete: (id: string) => void;
  isCompleting: boolean;
}

const TaskItem: React.FC<TaskItemProps> = ({ task, onComplete, onDelete, isCompleting }) => {
  const dueDateLabel = formatDueDate(task.dueDate ?? null);
  const isOverdue = task.dueDate && task.dueDate < Date.now();

  return (
    <motion.div
      className={styles.taskItem}
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -12, transition: { duration: 0.15 } }}
      layout
      whileHover={{ scale: 1.01 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
    >
      <motion.button
        type="button"
        className={`${styles.checkbox} ${isCompleting ? styles.completing : ''}`}
        onClick={() => onComplete(task.id)}
        disabled={isCompleting}
        aria-label="Mark as complete"
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.9 }}
      >
        {isCompleting ? (
          <Loader2 size={14} className={styles.spinner} />
        ) : (
          <CheckCircle2 size={16} />
        )}
      </motion.button>
      <Tooltip content={task.title} delayShow={300}>
        <div className={styles.taskContent}>
          <span className={styles.taskTitle}>{task.title}</span>
          {dueDateLabel && (
            <span className={`${styles.dueDate} ${isOverdue ? styles.overdue : ''}`}>
              {dueDateLabel}
            </span>
          )}
        </div>
      </Tooltip>
      <Tooltip content="Remove">
        <motion.button
          type="button"
          className={styles.deleteButton}
          onClick={() => onDelete(task.id)}
          aria-label="Delete task"
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
        >
          <X size={12} />
        </motion.button>
      </Tooltip>
    </motion.div>
  );
};

const ASK_REBEL_PROMPTS = [
  { label: "What should I NOT do this week?", prompt: "Looking at my Todoist tasks, what should I NOT do this week? Help me identify what I can drop, delegate, or defer." },
  { label: "What's the one thing for today?", prompt: "Based on my Todoist tasks, deadlines, and priorities - what's the ONE thing I should focus on today?" },
  { label: "What's slipping through the cracks?", prompt: "Check my Todoist for overdue tasks and patterns. What's slipping through the cracks that I should address?" },
  { label: "Help me plan tomorrow", prompt: "Review my Todoist tasks and help me plan a realistic tomorrow. What should I prioritize?" },
  { label: "Am I overcommitted?", prompt: "Analyze my Todoist workload. Am I overcommitted? Be honest - what's realistic vs wishful thinking?" },
  { label: "What can I delegate?", prompt: "Review my Todoist tasks. What should I consider delegating or asking for help with?" },
  { label: "Clear my head", prompt: "I'm overwhelmed. Look at my Todoist and help me see the forest for the trees. What actually matters right now?" },
];

const getRandomPromptIndex = () => Math.floor(Math.random() * ASK_REBEL_PROMPTS.length);

export const TasksPanel: React.FC<TasksPanelProps> = ({ showToast, onAskRebel }) => {
  const { upcomingTasks, loading, error, addTask, completeTask, deleteTask, todoistConnected, refresh } = useTasks({
    showToast,
  });
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDueDate, setNewTaskDueDate] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());
  const [isConnectingTodoist, setIsConnectingTodoist] = useState(false);
  const [connectStatus, setConnectStatus] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const setupGuidanceDialog = useConnectorSetupGuidance();
  const [promptIndex, setPromptIndex] = useState(getRandomPromptIndex);
  const [todoistCardCollapsed, setTodoistCardCollapsed] = useState(() => {
    try {
      return localStorage.getItem(TODOIST_CARD_COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

  const toggleTodoistCardCollapsed = useCallback(() => {
    setTodoistCardCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(TODOIST_CARD_COLLAPSED_KEY, String(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }, []);

  const handleTodoistConnect = useCallback(async () => {
    setIsConnectingTodoist(true);
    setConnectError(null);
    setConnectStatus('Adding Todoist...');
    
    try {
      // 1. Add Todoist to MCP config
      await window.settingsApi.mcpUpsertServer(TODOIST_MCP_CONFIG);
      setConnectStatus('Starting connection...');

      // 2. Restart Super-MCP to discover the new server
      const restartResult = await window.settingsApi.mcpRestartSuperMcp();
      if (!restartResult.success) {
        setConnectError('Failed to start connection service. Try again.');
        setConnectStatus(null);
        setIsConnectingTodoist(false);
        return;
      }

      // 3. Wait for Super-MCP to index
      setConnectStatus('Waiting for OAuth...');
      await new Promise(resolve => setTimeout(resolve, 1500));

      // 4. Trigger OAuth
      const authResult = await window.miscApi.mcpAuthenticate({ serverId: 'Todoist' });
      
      if (authResult.success) {
        setConnectStatus('Loading tasks...');
        // Refresh to load Todoist tasks
        await refresh();
        setConnectStatus(null);
        showToast?.({ title: 'Todoist connected!' });
      } else if (setupGuidanceDialog.handleResult(authResult)) {
        // Broken-by-default (no OAuth client credentials): the shared ConnectorSetupDialog takes
        // over instead of surfacing the credentials-not-configured guidance as a generic error.
        setConnectStatus(null);
      } else {
        const errorMsg = authResult.error || 'Authentication cancelled or failed';
        setConnectError(errorMsg);
        setConnectStatus(null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed';
      setConnectError(message);
      setConnectStatus(null);
    } finally {
      setIsConnectingTodoist(false);
    }
  }, [showToast, refresh, setupGuidanceDialog]);

  const handleAddTask = useCallback(async () => {
    const title = newTaskTitle.trim();
    if (!title) return;

    setIsAdding(true);
    try {
      const dueDate = newTaskDueDate
        ? DateTime.fromISO(newTaskDueDate).endOf('day').toMillis()
        : null;
      await addTask(title, dueDate);
      setNewTaskTitle('');
      setNewTaskDueDate('');
      inputRef.current?.focus();
    } finally {
      setIsAdding(false);
    }
  }, [newTaskTitle, newTaskDueDate, addTask]);

  const handleComplete = useCallback(
    async (taskId: string) => {
      setCompletingIds((prev) => new Set(prev).add(taskId));
      try {
        await new Promise((resolve) => setTimeout(resolve, 400));
        await completeTask(taskId);
      } finally {
        setCompletingIds((prev) => {
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
      }
    },
    [completeTask]
  );

  const handleDelete = useCallback(
    async (taskId: string) => {
      await deleteTask(taskId);
    },
    [deleteTask]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleAddTask();
      }
    },
    [handleAddTask]
  );

  const todayStr = DateTime.now().toISODate() ?? '';
  const dueDateLabel = newTaskDueDate
    ? formatDueDate(DateTime.fromISO(newTaskDueDate).toMillis())
    : null;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerIcon}>
          <ListTodo size={14} />
        </div>
        <h3 className={styles.title}>Tasks</h3>
      </div>

      <div className={styles.addTaskForm}>
        <div className={styles.inputWrapper}>
          <input
            ref={inputRef}
            type="text"
            value={newTaskTitle}
            onChange={(e) => setNewTaskTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What needs doing?"
            className={styles.addTaskInput}
            disabled={isAdding}
          />
          <div className={styles.inputActions}>
            <Tooltip content={dueDateLabel ?? 'Add due date'}>
              <button
                type="button"
                className={`${styles.dateButton} ${newTaskDueDate ? styles.hasDate : ''}`}
                onClick={() => dateInputRef.current?.showPicker()}
                disabled={isAdding}
              >
                <Calendar size={14} />
                {dueDateLabel && <span className={styles.dateBadge}>{dueDateLabel}</span>}
              </button>
            </Tooltip>
            <input
              ref={dateInputRef}
              type="date"
              value={newTaskDueDate}
              onChange={(e) => setNewTaskDueDate(e.target.value)}
              className={styles.hiddenDateInput}
              min={todayStr}
            />
            <motion.button
              type="button"
              className={styles.addButton}
              onClick={handleAddTask}
              disabled={!newTaskTitle.trim() || isAdding}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              {isAdding ? <Loader2 size={14} className={styles.spinner} /> : 'Add'}
            </motion.button>
          </div>
        </div>
      </div>

      <div className={styles.taskList}>
        {loading && upcomingTasks.length === 0 ? (
          <div className={styles.emptyState}>
            <Loader2 size={24} className={styles.spinner} />
          </div>
        ) : upcomingTasks.length === 0 ? (
          <motion.div 
            className={styles.emptyState}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1 }}
          >
            <div className={styles.emptyIcon}>
              <Sparkles size={20} />
            </div>
            <span className={styles.emptyTitle}>All clear</span>
            <span className={styles.emptyHint}>Add a task to keep track of what matters</span>
          </motion.div>
        ) : (
          <AnimatePresence mode="popLayout">
            {upcomingTasks.map((task, index) => (
              <motion.div
                key={task.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
              >
                <TaskItem
                  task={task}
                  onComplete={handleComplete}
                  onDelete={handleDelete}
                  isCompleting={completingIds.has(task.id)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>

      {/* Error display */}
      {error && !loading && (
        <motion.div 
          className={styles.errorBanner}
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <span className={styles.errorText}>{error}</span>
          <button 
            type="button" 
            className={styles.retryButton}
            onClick={() => void refresh()}
          >
            Retry
          </button>
        </motion.div>
      )}

      {/* Todoist Integration Section */}
      {!todoistConnected && (
        <motion.div 
          className={`${styles.todoistCard} ${todoistCardCollapsed ? styles.collapsed : ''}`}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <button
            type="button"
            className={styles.todoistCardHeader}
            onClick={toggleTodoistCardCollapsed}
          >
            <Zap size={12} className={styles.todoistIcon} />
            <span className={styles.todoistCardTitle}>Power up with Todoist</span>
            <span className={styles.todoistChevron}>
              {todoistCardCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </span>
          </button>
          <AnimatePresence>
            {!todoistCardCollapsed && (
              <motion.div
                className={styles.todoistCardBody}
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                <p className={styles.todoistCardDescription}>
                  Connect Todoist and Rebel can help manage your tasks.
                </p>
                
                {/* Connection error */}
                {connectError && (
                  <p className={styles.connectError}>{connectError}</p>
                )}
                
                <button 
                  type="button"
                  className={styles.todoistConnectButton}
                  onClick={handleTodoistConnect}
                  disabled={isConnectingTodoist}
                >
                  {isConnectingTodoist ? (
                    <>
                      <Loader2 size={12} className={styles.spinner} />
                      {connectStatus || 'Connecting...'}
                    </>
                  ) : connectError ? (
                    'Try again'
                  ) : (
                    'Connect'
                  )}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}

      {/* Ask Rebel - single rotating prompt, only when Todoist connected */}
      {todoistConnected && onAskRebel && (
        <motion.div 
          className={styles.askRebelSection}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <span className={styles.askRebelHint}>Try asking:</span>
          <button
            type="button"
            className={styles.askRebelButton}
            onClick={() => onAskRebel(ASK_REBEL_PROMPTS[promptIndex].prompt)}
          >
            <span>{ASK_REBEL_PROMPTS[promptIndex].label}</span>
          </button>
          <button
            type="button"
            className={styles.shuffleButton}
            onClick={() => setPromptIndex((prev) => (prev + 1) % ASK_REBEL_PROMPTS.length)}
            aria-label="Next suggestion"
          >
            <ChevronRight size={14} />
          </button>
        </motion.div>
      )}
      <ConnectorSetupDialog
        guidance={setupGuidanceDialog.guidance}
        open={setupGuidanceDialog.isOpen}
        onOpenChange={setupGuidanceDialog.setOpen}
      />
    </div>
  );
};
