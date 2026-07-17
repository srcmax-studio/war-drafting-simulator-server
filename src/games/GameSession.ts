import {
  RuleError,
  createBattleSummary,
  createPlayerView,
  createPublicView,
  lockTurn,
  raiseBanner,
  serializeGame,
  submitTurnIntent,
  undoTurnIntent,
  withdraw,
  type BattleSummary,
  type CardDefinition,
  type GameState,
  type PlayerView,
  type TurnIntent,
  type ValidationResult
} from '../common/src/index.js';
import { choosePracticeIntent, choosePracticeRisk } from '../ai.js';
import { GameTimer } from './GameTimer.js';

interface GameSessionCallbacks {
  onUpdate: (session: GameSession) => void;
  onEnd: (session: GameSession, summary: BattleSummary, serializedGame: string) => void;
  onTimeout: (session: GameSession) => void;
}

export class GameSession {
  readonly timer = new GameTimer();
  readonly startedAt = Date.now();
  endedAt: number | null = null;
  private endNotified = false;
  private scheduledTurn = 0;

  constructor(
    readonly roomId: string | null,
    readonly mode: 'online' | 'practice',
    readonly game: GameState,
    readonly turnDurationMs: number,
    private readonly cardCatalog: Record<string, CardDefinition>,
    private readonly practiceAiPlayerId: string | null,
    private readonly callbacks: GameSessionCallbacks
  ) {}

  get gameId(): string { return this.game.gameId; }
  get deadline(): number | null { return this.timer.deadline; }
  get playerIds(): string[] { return this.game.players.map((player) => player.playerId); }

  start(): void {
    this.runPracticeAi();
    this.schedule();
    this.callbacks.onUpdate(this);
    this.finishIfNeeded();
  }

  submit(playerId: string, intent: TurnIntent, requestId: string): ValidationResult {
    const result = submitTurnIntent(this.game, playerId, { ...intent, requestId });
    this.afterAction();
    return result;
  }

  undo(playerId: string, requestId: string): ValidationResult {
    const result = undoTurnIntent(this.game, playerId, requestId);
    this.afterAction();
    return result;
  }

  lock(playerId: string, requestId: string): ValidationResult {
    const result = lockTurn(this.game, playerId, requestId);
    this.afterAction();
    return result;
  }

  banner(playerId: string, requestId: string): ValidationResult {
    const result = raiseBanner(this.game, playerId, requestId);
    this.afterAction();
    return result;
  }

  withdraw(playerId: string, requestId: string): ValidationResult {
    const result = withdraw(this.game, playerId, requestId);
    this.afterAction();
    return result;
  }

  privateView(playerId: string): PlayerView & { deadline: number | null } {
    return { ...createPlayerView(this.game, playerId), deadline: this.deadline };
  }

  publicView(): PlayerView & { deadline: number | null } {
    return { ...createPublicView(this.game), deadline: this.deadline };
  }

  close(): void {
    this.timer.clear();
  }

  private afterAction(): void {
    if (this.game.phase === 'planning') this.runPracticeAi();
    if (this.game.phase === 'planning') this.schedule();
    else this.timer.clear();
    this.callbacks.onUpdate(this);
    this.finishIfNeeded();
  }

  private schedule(): void {
    if (this.game.phase !== 'planning') return;
    if (this.timer.deadline !== null && this.scheduledTurn === this.game.turn) return;
    const turn = this.game.turn;
    this.scheduledTurn = turn;
    this.timer.schedule(this.turnDurationMs, () => {
      if (this.game.phase !== 'planning' || this.game.turn !== turn) return;
      for (const player of this.game.players) if (!player.locked) lockTurn(this.game, player.playerId, `timeout:${this.gameId}:${turn}:${player.playerId}`);
      this.callbacks.onTimeout(this);
      this.afterAction();
    });
  }

  private runPracticeAi(): void {
    if (this.mode !== 'practice' || !this.practiceAiPlayerId || this.game.phase !== 'planning') return;
    const ai = this.game.players.find((player) => player.playerId === this.practiceAiPlayerId);
    if (!ai || ai.locked) return;
    const view = createPlayerView(this.game, this.practiceAiPlayerId);
    const seed = this.game.seed + this.game.turn * 101;
    const risk = choosePracticeRisk(view, this.practiceAiPlayerId, seed);
    if (risk === 'withdraw') {
      withdraw(this.game, this.practiceAiPlayerId, `ai-withdraw-${this.game.turn}`);
      return;
    }
    if (risk === 'raise') raiseBanner(this.game, this.practiceAiPlayerId, `ai-banner-${this.game.turn}`);
    const intent = choosePracticeIntent(view, this.practiceAiPlayerId, this.cardCatalog, seed + 1);
    this.assert(submitTurnIntent(this.game, this.practiceAiPlayerId, intent));
    this.assert(lockTurn(this.game, this.practiceAiPlayerId, `ai-lock-${this.game.turn}`));
  }

  private finishIfNeeded(): void {
    if (this.game.phase !== 'ended' || this.endNotified) return;
    this.endNotified = true;
    this.endedAt = Date.now();
    this.timer.clear();
    const summary = createBattleSummary(this.game, { startedAt: this.startedAt, endedAt: this.endedAt });
    this.callbacks.onEnd(this, summary, serializeGame(this.game));
  }

  private assert(result: ValidationResult): void {
    if (!result.ok) throw new RuleError(result.issues[0]?.code ?? 'RULE_REJECTED', result.issues[0]?.message ?? 'Action rejected.', { issues: result.issues });
  }
}
