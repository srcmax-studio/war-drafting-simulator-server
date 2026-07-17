export class GameTimer {
  private timeout: NodeJS.Timeout | null = null;
  deadline: number | null = null;

  schedule(durationMs: number, callback: () => void): void {
    this.clear();
    this.deadline = Date.now() + durationMs;
    this.timeout = setTimeout(callback, durationMs);
    this.timeout.unref();
  }

  clear(): void {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
    this.deadline = null;
  }
}
