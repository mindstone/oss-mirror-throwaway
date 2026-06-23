/**
 * MapHandlerRegistry — Cloud implementation of HandlerRegistry.
 *
 * Plain Map wrapper. The cloud service IS the destination, so no routing logic
 * is needed. The IPC route handler uses get() to look up and invoke handlers.
 */

import type { HandlerRegistry, IpcHandler } from '@core/handlerRegistry';

export class MapHandlerRegistry implements HandlerRegistry {
  private handlers = new Map<string, IpcHandler>();

  register(channel: string, handler: IpcHandler): void {
    this.handlers.set(channel, handler);
  }

  remove(channel: string): void {
    this.handlers.delete(channel);
  }

  get(channel: string): IpcHandler | undefined {
    return this.handlers.get(channel);
  }

  listRegisteredChannels(): readonly string[] {
    return Array.from(this.handlers.keys());
  }

  async invokeWithRouting(channel: string, event: unknown | undefined, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`No handler registered for channel: ${channel}`);
    }

    return await handler(event, ...args);
  }
}
