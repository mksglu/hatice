import { EventEmitter } from 'node:events';

/**
 * Typed PubSub event bus that wraps EventEmitter with full type safety
 * and wildcard (onAny) support.
 *
 * @example
 * ```ts
 * type AppEvents = {
 *   'issue:created': [issueId: string, title: string];
 *   'agent:spawned': [agentId: string];
 * };
 *
 * const bus = new EventBus<AppEvents>();
 * bus.on('issue:created', (id, title) => console.log(id, title));
 * bus.emit('issue:created', 'ISS-1', 'Fix login bug');
 * ```
 */
export class EventBus<TEvents extends Record<string, unknown[]>> {
  private readonly emitter = new EventEmitter();
  private readonly anyHandlers = new Set<(event: string, ...args: unknown[]) => void>();

  /**
   * Register a handler for a specific event.
   */
  on<K extends keyof TEvents>(
    event: K,
    handler: (...args: TEvents[K]) => void,
  ): void {
    this.emitter.on(event as string, handler as (...args: unknown[]) => void);
  }

  /**
   * Remove a specific handler for an event.
   */
  off<K extends keyof TEvents>(
    event: K,
    handler: (...args: TEvents[K]) => void,
  ): void {
    this.emitter.off(event as string, handler as (...args: unknown[]) => void);
  }

  /**
   * Emit an event with typed arguments.
   * Fires both specific handlers and any wildcard (onAny) handlers.
   */
  emit<K extends keyof TEvents>(event: K, ...args: TEvents[K]): void {
    this.emitter.emit(event as string, ...args);
    for (const handler of this.anyHandlers) {
      handler(event as string, ...args);
    }
  }

  /**
   * Register a handler that fires only once for the given event.
   */
  once<K extends keyof TEvents>(
    event: K,
    handler: (...args: TEvents[K]) => void,
  ): void {
    this.emitter.once(event as string, handler as (...args: unknown[]) => void);
  }

  /**
   * Register a wildcard handler that fires for every event.
   * The handler receives the event name as the first argument,
   * followed by the event's arguments.
   */
  onAny(handler: (event: string, ...args: unknown[]) => void): void {
    this.anyHandlers.add(handler);
  }

  /**
   * Return the number of listeners registered for a specific event.
   * Does not include onAny handlers.
   */
  listenerCount<K extends keyof TEvents>(event: K): number {
    return this.emitter.listenerCount(event as string);
  }

  /**
   * Remove all listeners for all events, including onAny handlers.
   */
  removeAllListeners(): void {
    this.emitter.removeAllListeners();
    this.anyHandlers.clear();
  }
}
