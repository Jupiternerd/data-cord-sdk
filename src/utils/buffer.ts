import type { BufferedEvent } from "../static/types";

/** In-memory event queue with a hard cap. When full, the oldest events are dropped and counted. */
export class EventBuffer {
  private events: BufferedEvent[] = [];
  /** Events dropped since the last take(); reported to the server with the next batch. */
  dropped = 0;

  constructor(private readonly max: number) {}

  get length() {
    return this.events.length;
  }

  push(event: BufferedEvent) {
    if (this.events.length >= this.max) {
      // Drop 10% at once so a full buffer costs O(1) per push, not an O(n) shift each time.
      const n = Math.ceil(this.max / 10);
      this.events.splice(0, n);
      this.dropped += n;
    }
    this.events.push(event);
  }

  /** Removes and returns up to n of the oldest events, plus the drop count accumulated so far. */
  take(n: number) {
    const dropped = this.dropped;
    this.dropped = 0;
    return { events: this.events.splice(0, n), dropped };
  }
}
