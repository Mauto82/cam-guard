import { EventEmitter } from "node:events";

/**
 * EventEmitter with a typed event map: `on("action", …)` knows its payload.
 *
 * `error` keeps Node's semantics — emitting it with no listener throws — on
 * purpose: a moderation pipeline that fails silently is worse than one that
 * crashes loudly.
 */
export class TypedEmitter<Events extends { [K in keyof Events]: unknown[] }> {
  private readonly emitter = new EventEmitter();

  on<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  once<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    this.emitter.once(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  emit<K extends keyof Events & string>(event: K, ...args: Events[K]): boolean {
    return this.emitter.emit(event, ...args);
  }

  listenerCount<K extends keyof Events & string>(event: K): number {
    return this.emitter.listenerCount(event);
  }
}
