import { randomUUID } from 'node:crypto';
import { LOBBY_LIMITS, RuleError, type LobbyChatMessage, type LobbySnapshot, type MatchmakingState, type PresenceEntry, type ServerStatus } from '../common/src/index.js';
import type { RoomManager } from '../rooms/RoomManager.js';
import type { SessionManager } from '../server/SessionManager.js';
import type { PlayerSession } from '../server/models.js';

const latencyBucket = (latency: number | null): PresenceEntry['latency'] => {
  if (latency === null) return 'unknown';
  if (latency < 60) return 'excellent';
  if (latency < 120) return 'good';
  if (latency < 220) return 'fair';
  return 'poor';
};

export class LobbyService {
  private readonly chat: LobbyChatMessage[] = [];

  constructor(
    private readonly sessions: SessionManager,
    private readonly rooms: RoomManager,
    private readonly status: () => ServerStatus,
    private readonly matchmakingState: (playerId: string) => MatchmakingState
  ) {}

  presence(): PresenceEntry[] {
    return this.sessions.values()
      .filter((session) => session.connectionId !== null || session.status === 'reconnecting')
      .map((session) => this.presenceEntry(session))
      .sort((left, right) => left.joinedAt - right.joinedAt || left.playerId.localeCompare(right.playerId))
      .slice(0, 250);
  }

  snapshot(session: PlayerSession): LobbySnapshot {
    return {
      server: this.status(),
      self: this.presenceEntry(session),
      presence: this.presence(),
      rooms: this.rooms.list('', false, 0, 100),
      chat: this.chat.map((message) => ({ ...message })),
      matchmaking: this.matchmakingState(session.playerId)
    };
  }

  playerMessage(session: PlayerSession, contentValue: string, now = Date.now()): LobbyChatMessage {
    const content = this.sanitize(contentValue);
    if (!content) throw new RuleError('EMPTY_MESSAGE', 'Chat message cannot be empty.');
    const message: LobbyChatMessage = {
      messageId: randomUUID(),
      scope: 'lobby',
      senderId: session.playerId,
      senderName: session.name,
      kind: 'player',
      content,
      createdAt: now
    };
    this.append(message);
    return message;
  }

  systemMessage(contentValue: string, roomId?: string, now = Date.now()): LobbyChatMessage {
    const content = this.sanitize(contentValue);
    const message: LobbyChatMessage = {
      messageId: randomUUID(),
      scope: roomId ? 'room' : 'lobby',
      ...(roomId ? { roomId } : {}),
      senderId: null,
      senderName: '系统',
      kind: 'system',
      content,
      createdAt: now
    };
    if (!roomId) this.append(message);
    return message;
  }

  roomMessage(session: PlayerSession, roomId: string, contentValue: string, now = Date.now()): LobbyChatMessage {
    const content = this.sanitize(contentValue);
    if (!content) throw new RuleError('EMPTY_MESSAGE', 'Chat message cannot be empty.');
    return {
      messageId: randomUUID(),
      scope: 'room',
      roomId,
      senderId: session.playerId,
      senderName: session.name,
      kind: 'player',
      content,
      createdAt: now
    };
  }

  private presenceEntry(session: PlayerSession): PresenceEntry {
    return {
      playerId: session.playerId,
      name: session.name,
      status: session.status,
      joinedAt: session.joinedAt,
      latency: latencyBucket(session.latencyMs)
    };
  }

  private sanitize(value: string): string {
    return [...value.normalize('NFKC')].filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    }).join('')
      .replace(/[<>]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, LOBBY_LIMITS.chatMessage);
  }

  private append(message: LobbyChatMessage): void {
    this.chat.push(message);
    if (this.chat.length > LOBBY_LIMITS.recentChatMessages) this.chat.splice(0, this.chat.length - LOBBY_LIMITS.recentChatMessages);
  }
}
