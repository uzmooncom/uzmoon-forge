/**
 * Bounded ring buffer — fixed capacity, overwrites oldest entry when full.
 * Used for telemetry/diagnostic event storage without unbounded growth.
 */
export class RingBuffer<T> {
  private readonly _buf: (T | undefined)[];
  private _head = 0; // next write position
  private _size = 0;

  constructor(readonly capacity: number) {
    if (capacity < 1) throw new RangeError("RingBuffer capacity must be >= 1");
    this._buf = new Array(capacity);
  }

  /** Add an item, evicting the oldest if at capacity */
  push(item: T): void {
    this._buf[this._head] = item;
    this._head = (this._head + 1) % this.capacity;
    if (this._size < this.capacity) this._size++;
  }

  /** Current number of items stored */
  get size(): number {
    return this._size;
  }

  /** Whether the buffer is full */
  get full(): boolean {
    return this._size === this.capacity;
  }

  /** Return all items in insertion order (oldest first) */
  toArray(): T[] {
    if (this._size === 0) return [];
    if (this._size < this.capacity) {
      return this._buf.slice(0, this._size) as T[];
    }
    // Buffer is full — head points to the oldest element
    const result: T[] = [];
    for (let i = 0; i < this.capacity; i++) {
      result.push(this._buf[(this._head + i) % this.capacity] as T);
    }
    return result;
  }

  /** Return the N most recent items */
  recent(n: number): T[] {
    const arr = this.toArray();
    return arr.slice(Math.max(0, arr.length - n));
  }

  /** Clear all items */
  clear(): void {
    this._head = 0;
    this._size = 0;
    this._buf.fill(undefined);
  }
}