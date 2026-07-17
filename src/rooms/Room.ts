import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { LobbyChatMessage, RoomMember, RoomSettings, RoomState, RoomSummary, SubmittedDeck } from '../common/src/index.js';
import type { PlayerSession } from '../server/models.js';

export interface RoomMemberRecord {
  playerId: string;
  name: string;
  role: 'host' | 'player';
  connected: boolean;
  ready: boolean;
  deck: SubmittedDeck | null;
  joinedAt: number;
}

export interface RoomRecord {
  roomId: string;
  ownerNodeId: string;
  name: string;
  hostId: string;
  passwordHash: string | null;
  settings: RoomSettings;
  members: RoomMemberRecord[];
  chat: LobbyChatMessage[];
  status: RoomState['status'];
  gameId: string | null;
  createdAt: number;
  updatedAt: number;
}

const hashPassword = (password: string): string => {
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 32);
  return `${salt.toString('hex')}:${digest.toString('hex')}`;
};

const passwordMatches = (password: string, encoded: string): boolean => {
  const [saltHex, digestHex] = encoded.split(':');
  if (!saltHex || !digestHex) return false;
  const expected = Buffer.from(digestHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export class Room {
  constructor(readonly record: RoomRecord) {}

  acceptsPassword(password = ''): boolean {
    return this.record.passwordHash === null || passwordMatches(password, this.record.passwordHash);
  }

  setPassword(password: string): void {
    this.record.passwordHash = password ? hashPassword(password) : null;
    this.record.settings.passwordProtected = Boolean(password);
    this.touch();
  }

  add(session: PlayerSession, role: RoomMemberRecord['role'] = 'player', deck: SubmittedDeck | null = null): void {
    if (this.record.members.some((member) => member.playerId === session.playerId)) return;
    this.record.members.push({ playerId: session.playerId, name: session.name, role, connected: Boolean(session.connectionId), ready: false, deck, joinedAt: Date.now() });
    this.touch();
  }

  remove(playerId: string): RoomMemberRecord | undefined {
    const member = this.record.members.find((candidate) => candidate.playerId === playerId);
    this.record.members = this.record.members.filter((candidate) => candidate.playerId !== playerId);
    if (member?.role === 'host' && this.record.members[0]) {
      this.record.members[0].role = 'host';
      this.record.hostId = this.record.members[0].playerId;
    }
    this.touch();
    return member;
  }

  member(playerId: string): RoomMemberRecord | undefined {
    return this.record.members.find((candidate) => candidate.playerId === playerId);
  }

  setConnected(playerId: string, connected: boolean): void {
    const member = this.member(playerId);
    if (member) { member.connected = connected; this.touch(); }
  }

  setDeck(playerId: string, deck: SubmittedDeck): void {
    const member = this.member(playerId);
    if (!member) return;
    member.deck = deck;
    member.ready = false;
    this.touch();
  }

  setReady(playerId: string, ready: boolean): void {
    const member = this.member(playerId);
    if (!member) return;
    member.ready = ready;
    this.record.status = this.record.members.length === 2 && this.record.members.every((candidate) => candidate.ready && candidate.deck) ? 'ready' : 'open';
    this.touch();
  }

  appendMessage(message: LobbyChatMessage, limit: number): void {
    this.record.chat.push(message);
    if (this.record.chat.length > limit) this.record.chat.splice(0, this.record.chat.length - limit);
    this.touch();
  }

  touch(now = Date.now()): void {
    this.record.updatedAt = now;
  }

  summary(): RoomSummary {
    const host = this.record.members.find((member) => member.playerId === this.record.hostId);
    return {
      roomId: this.record.roomId,
      name: this.record.name,
      hostId: this.record.hostId,
      hostName: host?.name ?? '已离开',
      players: this.record.members.length,
      maxPlayers: 2,
      spectators: 0,
      status: this.record.status,
      settings: { ...this.record.settings, packIds: [...this.record.settings.packIds], tags: [...this.record.settings.tags] },
      createdAt: this.record.createdAt,
      updatedAt: this.record.updatedAt,
      gameId: this.record.gameId
    };
  }

  state(): RoomState {
    return {
      ...this.summary(),
      members: this.record.members.map((member): RoomMember => ({
        playerId: member.playerId,
        name: member.name,
        role: member.role,
        connected: member.connected,
        ready: member.ready,
        deckId: member.deck?.deckId ?? null,
        deckName: member.deck?.name ?? null,
        deckValid: Boolean(member.deck),
        joinedAt: member.joinedAt
      })),
      chat: this.record.chat.map((message) => ({ ...message }))
    };
  }
}
