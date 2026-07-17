export interface MetricGauges {
  connectedUsers: number;
  lobbyUsers: number;
  rooms: number;
  activeGames: number;
  matchmakingUsers: number;
}

export class MetricsService {
  readonly startedAt = Date.now();
  private messages = 0;
  private errors = 0;
  private completedGames = 0;
  private totalGameDurationMs = 0;
  private reconnects = 0;
  private timeouts = 0;

  recordMessage(): void { this.messages += 1; }
  recordError(): void { this.errors += 1; }
  recordReconnect(): void { this.reconnects += 1; }
  recordTimeout(): void { this.timeouts += 1; }
  recordCompletedGame(durationMs: number): void {
    this.completedGames += 1;
    this.totalGameDurationMs += Math.max(0, durationMs);
  }

  uptime(now = Date.now()): number {
    return Math.max(0, Math.floor((now - this.startedAt) / 1000));
  }

  counters(): Record<string, number> {
    return {
      messages: this.messages,
      errors: this.errors,
      completedGames: this.completedGames,
      averageGameDurationMs: this.completedGames > 0 ? Math.round(this.totalGameDurationMs / this.completedGames) : 0,
      reconnects: this.reconnects,
      timeouts: this.timeouts
    };
  }

  prometheus(gauges: MetricGauges): string {
    const values: Record<string, number> = {
      aeonfront_connected_users: gauges.connectedUsers,
      aeonfront_lobby_users: gauges.lobbyUsers,
      aeonfront_rooms: gauges.rooms,
      aeonfront_active_games: gauges.activeGames,
      aeonfront_matchmaking_users: gauges.matchmakingUsers,
      aeonfront_messages_total: this.messages,
      aeonfront_errors_total: this.errors,
      aeonfront_games_completed_total: this.completedGames,
      aeonfront_game_duration_milliseconds_total: this.totalGameDurationMs,
      aeonfront_reconnects_total: this.reconnects,
      aeonfront_timeouts_total: this.timeouts,
      aeonfront_uptime_seconds: this.uptime()
    };
    return `${Object.entries(values).map(([name, value]) => `${name} ${value}`).join('\n')}\n`;
  }
}
