export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly refillPerSecond: number,
    private readonly capacity: number,
    now = Date.now()
  ) {
    this.tokens = capacity;
    this.updatedAt = now;
  }

  take(cost = 1, now = Date.now()): boolean {
    const elapsedSeconds = Math.max(0, now - this.updatedAt) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.updatedAt = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

export class CooldownLimiter {
  private readonly timestamps = new Map<string, number>();

  allow(key: string, intervalMs: number, now = Date.now()): boolean {
    const last = this.timestamps.get(key) ?? 0;
    if (now - last < intervalMs) return false;
    this.timestamps.set(key, now);
    return true;
  }

  remove(key: string): void {
    this.timestamps.delete(key);
  }
}
