type LockTail = Promise<void>;

export interface SessionMutex {
  withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
}

class SessionMutexImpl implements SessionMutex {
  private readonly tails = new Map<string, LockTail>();

  async withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previousTail = (this.tails.get(sessionId) ?? Promise.resolve()).catch(() => {});
    let releaseCurrent!: () => void;
    const currentTail = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });

    const enqueuedTail = previousTail.then(() => currentTail);
    this.tails.set(sessionId, enqueuedTail);
    await previousTail;

    try {
      return await fn();
    } finally {
      releaseCurrent();
      if (this.tails.get(sessionId) === enqueuedTail) {
        this.tails.delete(sessionId);
      }
    }
  }
}

const sessionMutexSingleton: SessionMutex = new SessionMutexImpl();

export function getSessionMutex(): SessionMutex {
  return sessionMutexSingleton;
}
