import { randomUUID } from 'node:crypto';
import { RuleError, type MatchmakingState, type RoomState, type SubmittedDeck } from '../common/src/index.js';
import type { RoomManager } from '../rooms/RoomManager.js';
import type { SessionManager } from '../server/SessionManager.js';
import type { PlayerSession } from '../server/models.js';
import type { MatchStore } from '../stores/Store.js';

interface QueueEntry {
  ticketId: string;
  playerId: string;
  deck: SubmittedDeck;
  queuedAt: number;
  mmr: number | null;
}

export interface MatchRecord {
  matchId: string;
  roomId: string;
  playerIds: [string, string];
  acceptedPlayerIds: string[];
  createdAt: number;
  acceptBy: number;
}

export interface MatchFoundResult {
  match: MatchRecord;
  room: RoomState;
  players: [PlayerSession, PlayerSession];
}

export interface MatchCancellation {
  playerIds: string[];
  roomId: string | null;
  reason: string;
}

export class MatchmakingQueue {
  private readonly queue: QueueEntry[] = [];

  constructor(
    private readonly matches: MatchStore<MatchRecord>,
    private readonly sessions: SessionManager,
    private readonly rooms: RoomManager,
    private readonly confirmationMs: number
  ) {}

  join(session: PlayerSession, deck: SubmittedDeck, mmr?: number, now = Date.now()): { state: MatchmakingState; found?: MatchFoundResult } {
    if (session.roomId || session.gameId) throw new RuleError('PLAYER_BUSY', 'Leave the current room or game before matchmaking.');
    if (this.queue.some((entry) => entry.playerId === session.playerId) || this.pendingFor(session.playerId)) throw new RuleError('ALREADY_QUEUED', 'The player is already matchmaking.');
    this.queue.push({ ticketId: randomUUID(), playerId: session.playerId, deck, queuedAt: now, mmr: typeof mmr === 'number' && Number.isFinite(mmr) ? mmr : null });
    session.selectedDeck = deck;
    this.sessions.update(session);
    const found = this.tryMatch(now);
    return { state: this.state(session.playerId, now), ...(found ? { found } : {}) };
  }

  leave(playerId: string): MatchCancellation | null {
    const queueIndex = this.queue.findIndex((entry) => entry.playerId === playerId);
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1);
      return { playerIds: [playerId], roomId: null, reason: 'left_queue' };
    }
    const pending = this.pendingFor(playerId);
    return pending ? this.cancel(pending, 'declined') : null;
  }

  accept(session: PlayerSession, roomId: string, now = Date.now()): { state: MatchmakingState; ready: boolean; players: PlayerSession[] } {
    const match = this.matches.values().find((candidate) => candidate.roomId === roomId && candidate.playerIds.includes(session.playerId));
    if (!match) throw new RuleError('MATCH_NOT_FOUND', 'The match is no longer available.');
    if (match.acceptBy < now) {
      this.cancel(match, 'accept_timeout');
      throw new RuleError('MATCH_EXPIRED', 'The match acceptance window expired.');
    }
    if (!match.acceptedPlayerIds.includes(session.playerId)) match.acceptedPlayerIds.push(session.playerId);
    this.matches.set(match);
    const players = match.playerIds.map((playerId) => this.sessions.byPlayer(playerId)).filter((player): player is PlayerSession => Boolean(player));
    const ready = match.acceptedPlayerIds.length === match.playerIds.length;
    if (ready) {
      for (const player of players) this.rooms.setReady(player, true);
      this.matches.delete(match.matchId);
    }
    return { state: this.state(session.playerId, now), ready, players };
  }

  decline(playerId: string): MatchCancellation {
    const match = this.pendingFor(playerId);
    if (!match) throw new RuleError('MATCH_NOT_FOUND', 'The match is no longer available.');
    return this.cancel(match, 'declined');
  }

  cleanup(now = Date.now()): MatchCancellation[] {
    return this.matches.values().filter((match) => match.acceptBy <= now).map((match) => this.cancel(match, 'accept_timeout'));
  }

  state(playerId: string, now = Date.now()): MatchmakingState {
    const queued = this.queue.find((entry) => entry.playerId === playerId);
    if (queued) return {
      status: 'queued',
      queuedAt: queued.queuedAt,
      elapsedMs: Math.max(0, now - queued.queuedAt),
      queueSize: this.queue.length,
      ticketId: queued.ticketId,
      roomId: null,
      acceptBy: null,
      acceptedPlayerIds: [],
      ...(queued.mmr === null ? {} : { mmrBand: { minimum: queued.mmr - 200, maximum: queued.mmr + 200 } })
    };
    const pending = this.pendingFor(playerId);
    if (pending) return {
      status: pending.acceptedPlayerIds.includes(playerId) ? 'confirming' : 'found',
      queuedAt: pending.createdAt,
      elapsedMs: Math.max(0, now - pending.createdAt),
      queueSize: this.queue.length,
      ticketId: pending.matchId,
      roomId: pending.roomId,
      acceptBy: pending.acceptBy,
      acceptedPlayerIds: [...pending.acceptedPlayerIds]
    };
    return { status: 'idle', queuedAt: null, elapsedMs: 0, queueSize: this.queue.length, ticketId: null, roomId: null, acceptBy: null, acceptedPlayerIds: [] };
  }

  size(): number {
    return this.queue.length + this.matches.values().length * 2;
  }

  private tryMatch(now: number): MatchFoundResult | undefined {
    if (this.queue.length < 2) return undefined;
    const first = this.queue.shift()!;
    const second = this.queue.shift()!;
    const firstSession = this.sessions.byPlayer(first.playerId);
    const secondSession = this.sessions.byPlayer(second.playerId);
    if (!firstSession || !secondSession || !firstSession.connectionId || !secondSession.connectionId) return this.tryMatch(now);
    const room = this.rooms.createMatched(firstSession, secondSession, first.deck, second.deck);
    const match: MatchRecord = {
      matchId: `match-${randomUUID()}`,
      roomId: room.roomId,
      playerIds: [first.playerId, second.playerId],
      acceptedPlayerIds: [],
      createdAt: now,
      acceptBy: now + this.confirmationMs
    };
    this.matches.set(match);
    return { match, room, players: [firstSession, secondSession] };
  }

  private pendingFor(playerId: string): MatchRecord | undefined {
    return this.matches.values().find((match) => match.playerIds.includes(playerId));
  }

  private cancel(match: MatchRecord, reason: string): MatchCancellation {
    this.matches.delete(match.matchId);
    this.rooms.remove(match.roomId);
    for (const playerId of match.playerIds) {
      const session = this.sessions.byPlayer(playerId);
      if (!session) continue;
      session.roomId = null;
      session.gameId = null;
      session.status = session.connectionId ? 'lobby' : 'reconnecting';
      this.sessions.update(session);
    }
    return { playerIds: [...match.playerIds], roomId: match.roomId, reason };
  }
}
