const sessionToOperator = new Map<string, string>();
const subscribers = new Set<() => void>();

const MAX_ENTRIES = 64;

function notify(): void {
  for (const subscriber of [...subscribers]) {
    try {
      subscriber();
    } catch (err) {
      console.warn('[personalisationSessionRegistry] subscriber threw, continuing fanout', err);
    }
  }
}

export function registerPersonalisationSession(input: { sessionId: string; operatorId: string }): void {
  const sessionId = input.sessionId.trim();
  const operatorId = input.operatorId.trim();
  if (!sessionId || !operatorId) return;
  if (sessionToOperator.get(sessionId) === operatorId) return;
  if (sessionToOperator.size >= MAX_ENTRIES && !sessionToOperator.has(sessionId)) {
    const firstKey = sessionToOperator.keys().next().value;
    if (firstKey) sessionToOperator.delete(firstKey);
  }
  sessionToOperator.set(sessionId, operatorId);
  notify();
}

export function deregisterPersonalisationSession(sessionId: string): void {
  if (sessionToOperator.delete(sessionId)) {
    notify();
  }
}

export function lookupPersonalisationOperatorId(sessionId: string): string | undefined {
  return sessionToOperator.get(sessionId);
}

export function subscribePersonalisationSessionRegistry(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export function clearPersonalisationSessionRegistry(): void {
  if (sessionToOperator.size === 0) return;
  sessionToOperator.clear();
  notify();
}
