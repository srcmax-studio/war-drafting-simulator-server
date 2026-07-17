import { createHash, randomUUID } from 'node:crypto';
import { RuleError } from '../common/src/index.js';
import type { SessionStore } from '../stores/Store.js';
import type { PlayerSession, SessionConnectionResult } from './models.js';

const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

export class SessionManager {
  constructor(
    private readonly store: SessionStore<PlayerSession>,
    private readonly reconnectWindowMs: number,
    private readonly maximumSessions: number
  ) {}

  connect(connectionId: string, nameValue: string, reconnectToken?: string, now = Date.now()): SessionConnectionResult {
    const name = nameValue.trim().slice(0, 24);
    if (!name) throw new RuleError('NAME_REQUIRED', 'Player name is required.');
    if (reconnectToken) {
      const hash = tokenHash(reconnectToken);
      const existing = this.store.values().find((session) => session.reconnectTokenHash === hash && (session.expiresAt === null || session.expiresAt >= now));
      if (existing) {
        if (existing.connectionId && existing.connectionId !== connectionId) throw new RuleError('PLAYER_ALREADY_CONNECTED', 'That player is already connected.');
        const rotated = randomUUID();
        existing.connectionId = connectionId;
        existing.reconnectTokenHash = tokenHash(rotated);
        existing.status = existing.gameId ? 'game' : existing.roomId ? 'room' : 'lobby';
        existing.lastSeenAt = now;
        existing.disconnectedAt = null;
        existing.expiresAt = null;
        this.store.set(existing);
        return { session: existing, reconnectToken: rotated, reconnected: true };
      }
    }
    const activeName = this.store.values().some((session) => session.name === name && (session.connectionId !== null || session.expiresAt === null || session.expiresAt >= now));
    if (activeName) throw new RuleError('NAME_IN_USE', 'That name is already in use.');
    if (this.store.values().length >= this.maximumSessions) throw new RuleError('SERVER_FULL', 'The server reached its session limit.');
    const token = randomUUID();
    const playerId = `player-${randomUUID()}`;
    const session: PlayerSession = {
      sessionId: randomUUID(),
      playerId,
      name,
      reconnectTokenHash: tokenHash(token),
      connectionId,
      status: 'lobby',
      roomId: null,
      gameId: null,
      selectedDeck: null,
      joinedAt: now,
      lastSeenAt: now,
      disconnectedAt: null,
      expiresAt: null,
      latencyMs: null,
      processedRequestIds: []
    };
    this.store.set(session);
    return { session, reconnectToken: token, reconnected: false };
  }

  byConnection(connectionId: string): PlayerSession | undefined {
    return this.store.values().find((session) => session.connectionId === connectionId);
  }

  byPlayer(playerId: string): PlayerSession | undefined {
    return this.store.values().find((session) => session.playerId === playerId);
  }

  requireConnection(connectionId: string): PlayerSession {
    const session = this.byConnection(connectionId);
    if (!session) throw new RuleError('JOIN_REQUIRED', 'Join the server before this action.');
    session.lastSeenAt = Date.now();
    this.store.set(session);
    return session;
  }

  disconnect(connectionId: string, now = Date.now()): PlayerSession | undefined {
    const session = this.byConnection(connectionId);
    if (!session) return undefined;
    session.connectionId = null;
    session.status = 'reconnecting';
    session.disconnectedAt = now;
    session.expiresAt = now + this.reconnectWindowMs;
    session.lastSeenAt = now;
    this.store.set(session);
    return session;
  }

  update(session: PlayerSession): void {
    session.lastSeenAt = Date.now();
    this.store.set(session);
  }

  remove(playerId: string): void {
    const session = this.byPlayer(playerId);
    if (session) this.store.delete(session.sessionId);
  }

  expired(now = Date.now()): PlayerSession[] {
    return this.store.values().filter((session) => session.connectionId === null && session.expiresAt !== null && session.expiresAt <= now);
  }

  values(): PlayerSession[] {
    return this.store.values();
  }
}
