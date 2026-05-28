import type { CanonicalEvent } from "../../types.js";

export class EventQueue {
  private queue: CanonicalEvent[] = [];
  private deadLetters: CanonicalEvent[] = [];
  private seen = new Set<string>();

  push(events: CanonicalEvent[]): void {
    for (const event of events) {
      if (this.seen.has(event.id)) continue;
      this.seen.add(event.id);
      this.queue.push(event);
    }
  }

  drain(limit = 100): CanonicalEvent[] {
    return this.queue.splice(0, limit);
  }

  markDeadLetter(event: CanonicalEvent): void {
    this.deadLetters.unshift(event);
    if (this.deadLetters.length > 500) this.deadLetters.length = 500;
  }

  listDeadLetters(limit = 100): CanonicalEvent[] {
    return this.deadLetters.slice(0, limit);
  }

  requeueDeadLetters(limit = 50): number {
    const moved = this.deadLetters.splice(0, limit);
    this.queue.unshift(...moved);
    return moved.length;
  }

  stats(): { queued: number; deadLetters: number; seenIds: number } {
    return { queued: this.queue.length, deadLetters: this.deadLetters.length, seenIds: this.seen.size };
  }
}
