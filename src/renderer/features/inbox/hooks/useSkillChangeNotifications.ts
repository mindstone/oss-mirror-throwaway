import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileLocation } from '@rebel/shared';
import { useIpcEvent } from '@renderer/hooks/useIpcEvent';

export interface SkillChangeNotificationItem {
  id: string;
  skillName: string;
  skillWorkspacePath: string;
  spacePath: string;
  spaceName?: string;
  location?: FileLocation;
  actorLabel: string;
  actorKind: 'human' | 'agent';
  recipientReason: 'previous_editor' | 'creator_fallback';
  createdAt: number;
  updatedAt: number;
}

interface UseSkillChangeNotificationsOptions {
  onNewNotification?: (notification: SkillChangeNotificationItem) => void;
  enabled?: boolean;
}

export function useSkillChangeNotifications(
  options: UseSkillChangeNotificationsOptions = {},
): {
  notifications: SkillChangeNotificationItem[];
  isLoading: boolean;
  refresh: (emitNewEvents?: boolean) => Promise<void>;
  dismissNotification: (notification: SkillChangeNotificationItem) => Promise<boolean>;
} {
  const [notifications, setNotifications] = useState<SkillChangeNotificationItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const hasLoadedRef = useRef(false);
  const onNewNotification = options.onNewNotification;
  const enabled = options.enabled ?? true;
  const inFlightLoadRef = useRef<Promise<void> | null>(null);
  const queuedLoadRef = useRef(false);
  const queuedEmitNewRef = useRef(false);

  const performLoad = useCallback(async (emitNewEvents: boolean) => {
    try {
      const next = await window.libraryApi.listSkillChangeNotifications();
      setNotifications(next);

      if (emitNewEvents && hasLoadedRef.current) {
        for (const notification of next) {
          if (!seenIdsRef.current.has(notification.id)) {
            onNewNotification?.(notification);
          }
        }
      }

      seenIdsRef.current = new Set(next.map((notification) => notification.id));
      hasLoadedRef.current = true;
    } catch (error) {
      console.error('Failed to load skill change notifications:', error);
    } finally {
      setIsLoading(false);
    }
  }, [onNewNotification]);

  const loadNotifications = useCallback(async (emitNewEvents = false) => {
    queuedLoadRef.current = true;
    queuedEmitNewRef.current = queuedEmitNewRef.current || emitNewEvents;

    if (inFlightLoadRef.current) {
      return inFlightLoadRef.current;
    }

    const run = async () => {
      while (queuedLoadRef.current) {
        const shouldEmitNewEvents = queuedEmitNewRef.current;
        queuedLoadRef.current = false;
        queuedEmitNewRef.current = false;
        await performLoad(shouldEmitNewEvents);
      }
    };

    inFlightLoadRef.current = run().finally(() => {
      inFlightLoadRef.current = null;
      if (queuedLoadRef.current) {
        void loadNotifications(queuedEmitNewRef.current);
      }
    });

    return inFlightLoadRef.current;
  }, [performLoad]);

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    void loadNotifications(false);
  }, [enabled, loadNotifications]);

  useIpcEvent(
    enabled ? window.api.onSkillChangeNotificationsChanged : undefined,
    () => {
      void loadNotifications(true);
    },
    [enabled, loadNotifications],
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const handleFocus = () => {
      void loadNotifications(true);
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [enabled, loadNotifications]);

  const dismissNotification = useCallback(async (notification: SkillChangeNotificationItem) => {
    setNotifications((prev) => prev.filter((item) => item.id !== notification.id));
    try {
      const result = await window.libraryApi.dismissSkillChangeNotification({
        id: notification.id,
        spacePath: notification.spacePath,
      });
      if (!result.success) {
        void loadNotifications(false);
      }
      return result.success;
    } catch (error) {
      console.error('Failed to dismiss skill change notification:', error);
      void loadNotifications(false);
      return false;
    }
  }, [loadNotifications]);

  return {
    notifications,
    isLoading,
    refresh: loadNotifications,
    dismissNotification,
  };
}

export function useSkillChangeNotificationCount(): number {
  const [count, setCount] = useState(0);

  const loadCount = useCallback(async () => {
    try {
      const notifications = await window.libraryApi.listSkillChangeNotifications();
      setCount(notifications.length);
    } catch (error) {
      console.error('Failed to load skill change notification count:', error);
    }
  }, []);

  useEffect(() => {
    void loadCount();
  }, [loadCount]);

  useIpcEvent(window.api.onSkillChangeNotificationsChanged, () => {
    void loadCount();
  }, [loadCount]);

  useEffect(() => {
    const handleFocus = () => {
      void loadCount();
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [loadCount]);

  return count;
}
