/**
 * Broadcast Helpers
 *
 * Utility functions for broadcasting messages to all renderer windows.
 * Extracted from src/main/index.ts as part of architecture refactoring.
 *
 * Delegates to the platform-agnostic BroadcastService so this module
 * works in both Electron and cloud environments.
 */

import { getBroadcastService } from '@core/broadcastService';

/**
 * Broadcast a message to all renderer windows.
 * Safe to call even if no windows exist or some windows are destroyed.
 *
 * @param channel - The IPC channel name
 * @param payload - The data to send
 */
export function broadcastToAllWindows(channel: string, payload: unknown): void {
  getBroadcastService().sendToAllWindows(channel, payload);
}
