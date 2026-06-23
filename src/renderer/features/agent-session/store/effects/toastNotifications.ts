type ShowToastFn = (options: { title: string; description?: string }) => void;

let showToastFn: ShowToastFn | null = null;

export const setToastHandler = (handler: ShowToastFn): void => {
  showToastFn = handler;
};

export const clearToastHandler = (): void => {
  showToastFn = null;
};

export const showToast = (options: { title: string; description?: string }): void => {
  if (showToastFn) {
    showToastFn(options);
  } else {
    console.warn('[toastNotifications] No toast handler registered:', options.title);
  }
};

export const notifyRunStopped = (): void => {
  showToast({ title: 'Run stopped' });
};

export const notifyStoppingRun = (): void => {
  showToast({ title: 'Stopping…' });
};

export const notifyStopRequestFailed = (): void => {
  showToast({ title: "Stop request didn't go through", description: 'The app is fine — keep working' });
};

export const notifyRunFailed = (): void => {
  showToast({ title: "Couldn't start that run", description: 'Try again or start a new conversation' });
};

export const notifyEditedRunFailed = (): void => {
  showToast({ title: "Edited run didn't start", description: 'Try again from the original message' });
};

export const notifySessionDeleted = (startedFresh: boolean): void => {
  showToast({ title: startedFresh ? 'Deleted — starting fresh' : 'Run removed' });
};

export const notifyCorruptedSession = (): void => {
  showToast({ title: "This conversation's data is scrambled", description: 'Starting a new one is the safest bet' });
};

export const notifyContextCompacted = (): void => {
  showToast({ title: 'Fresh start — context came along' });
};

export const notifyAutoDone = (): void => {
  // No toast - session moves to done section, visual feedback is clear
};

export const notifyDoneSkipped = (reason?: string): void => {
  if (reason) {
    showToast({ title: `Auto-done skipped: ${reason}` });
  } else {
    showToast({ title: 'Auto-done skipped', description: 'This one might need another look' });
  }
};
