/**
 * Priority queue for LM Studio requests.
 *
 * Four priority levels:
 *   critical — email dedup guard (blocks external sends, user is waiting)
 *   high     — incremental compile (file drop, incoming email/telegram)
 *   normal   — bulk initial compile (new workspace indexing)
 *   low      — digest generation (background summary work)
 *
 * Within the same priority, FIFO ordering.
 */

export type Priority = "critical" | "high" | "normal" | "low";

const PRIORITY_ORDER: Record<Priority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export interface QueueItem<T> {
  priority: Priority;
  data: T;
  enqueuedAt: number;
}

export class PriorityQueue<T> {
  private items: QueueItem<T>[] = [];

  enqueue(priority: Priority, data: T): void {
    const item: QueueItem<T> = { priority, data, enqueuedAt: Date.now() };
    const order = PRIORITY_ORDER[priority];
    // Insert after all existing items with equal or higher priority (lower order number)
    let insertIdx = this.items.length;
    for (let i = 0; i < this.items.length; i++) {
      if (PRIORITY_ORDER[this.items[i]!.priority] > order) {
        insertIdx = i;
        break;
      }
    }
    this.items.splice(insertIdx, 0, item);
  }

  dequeue(): QueueItem<T> | undefined {
    return this.items.shift();
  }

  get length(): number {
    return this.items.length;
  }

  stats(): Record<Priority, number> {
    const counts: Record<Priority, number> = { critical: 0, high: 0, normal: 0, low: 0 };
    for (const item of this.items) {
      counts[item.priority]++;
    }
    return counts;
  }
}
