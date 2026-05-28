import type { CanonicalEvent } from "../../types.js";
import { EventQueue } from "../queue/eventQueue.js";

export interface QueueAdapter {
  publish(events: CanonicalEvent[]): Promise<void>;
  consume(batchSize: number): Promise<CanonicalEvent[]>;
}

export class RedisStreamsQueueAdapter implements QueueAdapter {
  constructor(private readonly queue: EventQueue) {}

  async publish(events: CanonicalEvent[]): Promise<void> {
    this.queue.push(events);
  }

  async consume(batchSize: number): Promise<CanonicalEvent[]> {
    return this.queue.drain(batchSize);
  }
}

export class KafkaReadyQueueAdapter implements QueueAdapter {
  constructor(private readonly fallback: QueueAdapter) {}
  async publish(events: CanonicalEvent[]): Promise<void> {
    await this.fallback.publish(events);
  }
  async consume(batchSize: number): Promise<CanonicalEvent[]> {
    return this.fallback.consume(batchSize);
  }
}
