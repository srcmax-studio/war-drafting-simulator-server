import { randomUUID } from 'node:crypto';
import {
  FRONT_DEFINITIONS,
  RuleError,
  createGame,
  type BattleSummary,
  type CardDefinition,
  type GameState,
  type SubmittedDeck
} from '../common/src/index.js';
import type { Catalog } from '../catalog.js';
import type { RoomManager } from '../rooms/RoomManager.js';
import type { SessionManager } from '../server/SessionManager.js';
import type { PlayerSession } from '../server/models.js';
import { GameSession } from './GameSession.js';

interface GameManagerCallbacks {
  onStarting: (session: GameSession) => void;
  onUpdate: (session: GameSession) => void;
  onEnd: (session: GameSession, summary: BattleSummary, serializedGame: string) => void;
  onTimeout: (session: GameSession) => void;
}

export class GameSessionManager {
  private readonly games = new Map<string, GameSession>();
  private readonly rematches = new Map<string, Set<string>>();
  private seedCounter = 1;
  private lastGameId: string | null = null;

  constructor(
    private readonly catalog: Catalog,
    private readonly sessions: SessionManager,
    private readonly rooms: RoomManager,
    private readonly maximumActiveGames: number,
    private readonly callbacks: GameManagerCallbacks
  ) {}

  startRoom(roomId: string): GameSession {
    this.assertCapacity();
    const room = this.rooms.require(roomId);
    if (room.record.members.length !== 2 || room.record.members.some((member) => !member.deck)) throw new RuleError('ROOM_NOT_READY', 'Two valid decks are required.');
    if (room.record.status === 'playing') throw new RuleError('GAME_ACTIVE', 'This room already has an active game.');
    const seed = this.nextSeed();
    const scopedCards = this.scopedCards(room.record.members.map((member) => member.deck!.cardIds));
    const game = createGame({
      gameId: `online-${randomUUID()}`,
      seed,
      cards: scopedCards,
      fronts: FRONT_DEFINITIONS,
      catalogVersion: this.catalog.catalogVersion,
      packVersions: this.catalog.packVersions,
      players: room.record.members.map((member) => ({
        playerId: member.playerId,
        name: member.name,
        deck: [...member.deck!.cardIds],
        deckId: member.deck!.deckId,
        deckName: member.deck!.name
      })) as GameState['setup']['players']
    });
    const gameSession = this.makeSession(roomId, 'online', game, room.record.settings.turnDurationMs, null);
    room.record.gameId = game.gameId;
    room.record.status = 'playing';
    for (const member of room.record.members) {
      member.ready = false;
      const player = this.sessions.byPlayer(member.playerId);
      if (player) {
        player.gameId = game.gameId;
        player.status = 'game';
        this.sessions.update(player);
      }
    }
    this.rooms.save(room);
    this.register(gameSession);
    return gameSession;
  }

  startPractice(session: PlayerSession, deck: SubmittedDeck, turnDurationMs: number): GameSession {
    this.assertCapacity();
    if (session.gameId && this.games.get(session.gameId)?.game.phase !== 'ended') throw new RuleError('GAME_ACTIVE', 'The player already has an active game.');
    const aiDeck = this.catalog.presets[1]?.cardIds ?? this.catalog.presets[0]?.cardIds;
    if (!aiDeck) throw new RuleError('PRESET_MISSING', 'No practice deck is available.');
    const game = createGame({
      gameId: `practice-${randomUUID()}`,
      seed: this.nextSeed(),
      cards: this.scopedCards([deck.cardIds, aiDeck]),
      fronts: FRONT_DEFINITIONS,
      catalogVersion: this.catalog.catalogVersion,
      packVersions: this.catalog.packVersions,
      players: [
        { playerId: session.playerId, name: session.name, deck: [...deck.cardIds], deckId: deck.deckId, deckName: deck.name },
        { playerId: `practice-ai-${session.playerId}`, name: '演武官', deck: [...aiDeck], deckId: this.catalog.presets[1]?.deckId ?? 'practice-ai', deckName: this.catalog.presets[1]?.nameZh ?? '演武牌组' }
      ]
    });
    const gameSession = this.makeSession(null, 'practice', game, turnDurationMs, game.players[1].playerId);
    session.selectedDeck = deck;
    session.gameId = game.gameId;
    session.status = 'game';
    this.sessions.update(session);
    this.register(gameSession);
    return gameSession;
  }

  requireFor(session: PlayerSession, requestedGameId?: string): GameSession {
    const gameId = requestedGameId ?? session.gameId;
    if (!gameId || session.gameId !== gameId) throw new RuleError('GAME_NOT_FOUND', 'The requested game is not active for this player.');
    const game = this.games.get(gameId);
    if (!game || !game.playerIds.includes(session.playerId)) throw new RuleError('NOT_IN_GAME', 'The player is not part of this game.');
    return game;
  }

  requestRematch(session: PlayerSession): GameSession | null {
    const game = this.requireFor(session);
    if (game.game.phase !== 'ended') throw new RuleError('GAME_NOT_ENDED', 'Rematch is available after the game ends.');
    if (game.mode === 'practice') {
      if (!session.selectedDeck) throw new RuleError('DECK_REQUIRED', 'A valid deck is required.');
      return this.startPractice(session, session.selectedDeck, game.turnDurationMs);
    }
    const requests = this.rematches.get(game.gameId) ?? new Set<string>();
    requests.add(session.playerId);
    this.rematches.set(game.gameId, requests);
    if (requests.size < 2 || !game.roomId) return null;
    this.rematches.delete(game.gameId);
    return this.startRoom(game.roomId);
  }

  forfeitExpired(playerId: string): void {
    const session = this.sessions.byPlayer(playerId);
    if (!session?.gameId) return;
    const game = this.games.get(session.gameId);
    if (game && game.game.phase !== 'ended') game.withdraw(playerId, `reconnect-expired:${game.gameId}:${playerId}`);
  }

  activeCount(): number {
    return [...this.games.values()].filter((game) => game.game.phase !== 'ended').length;
  }

  values(): GameSession[] {
    return [...this.games.values()];
  }

  getGameForTesting(gameId?: string): GameState | null {
    const selected = gameId ?? this.lastGameId;
    return selected ? this.games.get(selected)?.game ?? null : null;
  }

  close(): void {
    for (const game of this.games.values()) game.close();
  }

  private makeSession(roomId: string | null, mode: 'online' | 'practice', game: GameState, turnDurationMs: number, aiPlayerId: string | null): GameSession {
    return new GameSession(roomId, mode, game, turnDurationMs, Object.fromEntries(this.catalog.cards.map((card) => [card.cardId, card])), aiPlayerId, {
      onUpdate: (session) => this.callbacks.onUpdate(session),
      onTimeout: (session) => this.callbacks.onTimeout(session),
      onEnd: (session, summary, serializedGame) => {
        if (session.roomId) {
          const room = this.rooms.require(session.roomId);
          room.record.status = 'finished';
          this.rooms.save(room);
        }
        this.callbacks.onEnd(session, summary, serializedGame);
      }
    });
  }

  private register(game: GameSession): void {
    this.games.set(game.gameId, game);
    this.lastGameId = game.gameId;
    this.callbacks.onStarting(game);
    game.start();
  }

  private assertCapacity(): void {
    if (this.activeCount() >= this.maximumActiveGames) throw new RuleError('GAME_LIMIT', 'The server reached its active game limit.');
  }

  private nextSeed(): number {
    const seed = (Date.now() ^ this.seedCounter) >>> 0;
    this.seedCounter += 1;
    return seed;
  }

  private scopedCards(decks: readonly (readonly string[])[]): CardDefinition[] {
    const catalog = new Map(this.catalog.cards.map((card) => [card.cardId, card]));
    const selected = new Set(decks.flat());
    const queue = [...selected];
    while (queue.length > 0) {
      const cardId = queue.shift()!;
      const card = catalog.get(cardId);
      if (!card) continue;
      const visit = (value: unknown, key = ''): void => {
        if (typeof value === 'string' && ['cardId', 'tokenId'].includes(key) && catalog.has(value) && !selected.has(value)) {
          selected.add(value);
          queue.push(value);
          return;
        }
        if (Array.isArray(value)) for (const entry of value) visit(entry);
        else if (value && typeof value === 'object') for (const [entryKey, entry] of Object.entries(value)) visit(entry, entryKey);
      };
      visit(card.abilities ?? []);
      visit(card.abilityArgs ?? {});
    }
    return [...selected].map((cardId) => catalog.get(cardId)).filter((card): card is CardDefinition => Boolean(card));
  }
}
