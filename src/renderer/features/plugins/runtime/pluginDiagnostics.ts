export interface PluginCrashRecord {
  name: string;
  message: string;
  stack?: string;
  componentStack?: string;
  timestamp: number;
}

const MAX_CRASHES_PER_PLUGIN = 20;
const pluginCrashStore = new Map<string, PluginCrashRecord[]>();

export function recordPluginCrash(pluginId: string, error: Error, componentStack?: string | null): void {
  const crashes = pluginCrashStore.get(pluginId) ?? [];
  crashes.push({
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(componentStack ? { componentStack } : {}),
    timestamp: Date.now(),
  });

  if (crashes.length > MAX_CRASHES_PER_PLUGIN) {
    crashes.splice(0, crashes.length - MAX_CRASHES_PER_PLUGIN);
  }

  pluginCrashStore.set(pluginId, crashes);
}

export function getPluginCrashes(pluginId: string): PluginCrashRecord[] {
  const crashes = pluginCrashStore.get(pluginId);
  return crashes ? crashes.map((crash) => ({ ...crash })) : [];
}

export function clearPluginCrashes(pluginId: string): void {
  pluginCrashStore.delete(pluginId);
}
