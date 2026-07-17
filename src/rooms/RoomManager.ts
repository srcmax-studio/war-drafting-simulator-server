import { randomUUID } from 'node:crypto';
import { LOBBY_LIMITS, RuleError, type RoomState, type RoomSummary, type SubmittedDeck } from '../common/src/index.js';
import type { PlayerSession } from '../server/models.js';
import type { RoomStore } from '../stores/Store.js';
import { Room, type RoomRecord } from './Room.js';
import { InMemoryRoomOwnership, type RoomOwnership } from './RoomOwnership.js';

export interface CreateRoomOptions {
  name: string;
  visibility: 'public' | 'private';
  password?: string;
  allowSpectators: boolean;
  turnDurationMs: number;
  packIds: string[];
  tags: string[];
  revealDecks: boolean;
}

export interface UpdateRoomOptions {
  name?: string;
  visibility?: 'public' | 'private';
  password?: string;
  allowSpectators?: boolean;
  turnDurationMs?: number;
  tags?: string[];
  revealDecks?: boolean;
}

const clampTurnDuration = (value: number): number => Math.max(1_000, Math.min(180_000, Math.floor(value)));

export class RoomManager {
  constructor(
    private readonly store: RoomStore<RoomRecord>,
    private readonly maximumRooms: number,
    private readonly idleMs: number,
    private readonly nodeId: string,
    private readonly ownership: RoomOwnership = new InMemoryRoomOwnership()
  ) {}

  create(session: PlayerSession, options: CreateRoomOptions): RoomState {
    if (session.roomId) throw new RuleError('ALREADY_IN_ROOM', 'Leave the current room first.');
    if (this.store.values().length >= this.maximumRooms) throw new RuleError('ROOM_LIMIT', 'The server reached its room limit.');
    const now = Date.now();
    const roomId = `room-${randomUUID()}`;
    const password = options.password?.slice(0, 128) ?? '';
    const record: RoomRecord = {
      roomId,
      ownerNodeId: this.nodeId,
      name: options.name.trim().slice(0, LOBBY_LIMITS.roomName),
      hostId: session.playerId,
      passwordHash: null,
      settings: {
        visibility: options.visibility,
        passwordProtected: Boolean(password),
        maxPlayers: 2,
        allowSpectators: options.allowSpectators,
        turnDurationMs: clampTurnDuration(options.turnDurationMs),
        packIds: options.packIds.slice(0, 20),
        tags: options.tags.map((tag) => tag.trim().slice(0, LOBBY_LIMITS.roomTag)).filter(Boolean).slice(0, LOBBY_LIMITS.roomTags),
        revealDecks: options.revealDecks
      },
      members: [],
      chat: [],
      status: 'open',
      gameId: null,
      createdAt: now,
      updatedAt: now
    };
    if (!record.name) throw new RuleError('ROOM_NAME_REQUIRED', 'Room name is required.');
    const room = new Room(record);
    if (password) room.setPassword(password);
    room.add(session, 'host');
    this.store.set(record);
    this.ownership.assign(roomId, this.nodeId);
    session.roomId = roomId;
    session.status = 'room';
    return room.state();
  }

  createMatched(first: PlayerSession, second: PlayerSession, firstDeck: SubmittedDeck, secondDeck: SubmittedDeck): RoomState {
    const state = this.create(first, {
      name: '快速匹配',
      visibility: 'private',
      allowSpectators: false,
      turnDurationMs: 45_000,
      packIds: ['core'],
      tags: ['快速匹配'],
      revealDecks: false
    });
    const room = this.require(state.roomId);
    room.add(second, 'player', secondDeck);
    room.setDeck(first.playerId, firstDeck);
    second.roomId = room.record.roomId;
    second.status = 'room';
    this.save(room);
    return room.state();
  }

  join(session: PlayerSession, roomId: string, password = ''): RoomState {
    if (session.roomId && session.roomId !== roomId) throw new RuleError('ALREADY_IN_ROOM', 'Leave the current room first.');
    const room = this.require(roomId);
    if (room.record.members.length >= 2 && !room.member(session.playerId)) throw new RuleError('ROOM_FULL', 'The room is full.');
    if (!room.acceptsPassword(password)) throw new RuleError('ROOM_PASSWORD_INVALID', 'Room password is incorrect.');
    if (!['open', 'ready'].includes(room.record.status)) throw new RuleError('ROOM_NOT_JOINABLE', 'The room cannot be joined now.');
    room.add(session);
    session.roomId = roomId;
    session.status = 'room';
    this.save(room);
    return room.state();
  }

  leave(session: PlayerSession): { roomId: string; removed: boolean; state: RoomState | null } {
    if (!session.roomId) throw new RuleError('ROOM_REQUIRED', 'The player is not in a room.');
    const roomId = session.roomId;
    const room = this.require(roomId);
    if (room.record.status === 'playing') throw new RuleError('GAME_ACTIVE', 'Return after the active game ends.');
    room.remove(session.playerId);
    session.roomId = null;
    session.gameId = null;
    session.status = 'lobby';
    if (room.record.members.length === 0) {
      this.store.delete(roomId);
      this.ownership.release(roomId);
      return { roomId, removed: true, state: null };
    }
    this.save(room);
    return { roomId, removed: false, state: room.state() };
  }

  update(session: PlayerSession, patch: UpdateRoomOptions): RoomState {
    const room = this.requireSessionRoom(session);
    if (room.record.hostId !== session.playerId) throw new RuleError('HOST_REQUIRED', 'Only the room host can change settings.');
    if (room.record.status === 'playing') throw new RuleError('GAME_ACTIVE', 'Room settings are locked during a game.');
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, LOBBY_LIMITS.roomName);
      if (!name) throw new RuleError('ROOM_NAME_REQUIRED', 'Room name is required.');
      room.record.name = name;
    }
    if (patch.visibility !== undefined) room.record.settings.visibility = patch.visibility;
    if (patch.password !== undefined) room.setPassword(patch.password.slice(0, 128));
    if (patch.allowSpectators !== undefined) room.record.settings.allowSpectators = patch.allowSpectators;
    if (patch.turnDurationMs !== undefined) room.record.settings.turnDurationMs = clampTurnDuration(patch.turnDurationMs);
    if (patch.tags !== undefined) room.record.settings.tags = patch.tags.map((tag) => tag.trim().slice(0, LOBBY_LIMITS.roomTag)).filter(Boolean).slice(0, LOBBY_LIMITS.roomTags);
    if (patch.revealDecks !== undefined) room.record.settings.revealDecks = patch.revealDecks;
    for (const member of room.record.members) member.ready = false;
    room.record.status = 'open';
    room.touch();
    this.save(room);
    return room.state();
  }

  kick(session: PlayerSession, playerId: string): { state: RoomState; kickedId: string } {
    const room = this.requireSessionRoom(session);
    if (room.record.hostId !== session.playerId) throw new RuleError('HOST_REQUIRED', 'Only the room host can remove a player.');
    if (playerId === session.playerId) throw new RuleError('CANNOT_KICK_SELF', 'Use leaveRoom to leave.');
    if (!room.remove(playerId)) throw new RuleError('PLAYER_NOT_IN_ROOM', 'Player is not in this room.');
    this.save(room);
    return { state: room.state(), kickedId: playerId };
  }

  selectDeck(session: PlayerSession, deck: SubmittedDeck): RoomState {
    const room = this.requireSessionRoom(session);
    room.setDeck(session.playerId, deck);
    session.selectedDeck = deck;
    this.save(room);
    return room.state();
  }

  setReady(session: PlayerSession, ready: boolean): RoomState {
    const room = this.requireSessionRoom(session);
    const member = room.member(session.playerId);
    if (!member?.deck) throw new RuleError('DECK_REQUIRED', 'Select a valid deck before readying.');
    room.setReady(session.playerId, ready);
    this.save(room);
    return room.state();
  }

  setConnected(playerId: string, connected: boolean): RoomState | null {
    const room = this.store.values().map((record) => new Room(record)).find((candidate) => candidate.member(playerId));
    if (!room) return null;
    room.setConnected(playerId, connected);
    this.save(room);
    return room.state();
  }

  require(roomId: string): Room {
    const record = this.store.get(roomId);
    if (!record) throw new RuleError('ROOM_NOT_FOUND', 'Room does not exist.');
    const ownerNodeId = this.ownership.ownerOf(roomId) ?? record.ownerNodeId;
    if (ownerNodeId !== this.nodeId) throw new RuleError('ROOM_NODE_MISMATCH', 'Room is assigned to another server node.', { ownerNodeId });
    return new Room(record);
  }

  requireSessionRoom(session: PlayerSession): Room {
    if (!session.roomId) throw new RuleError('ROOM_REQUIRED', 'Join a room first.');
    const room = this.require(session.roomId);
    if (!room.member(session.playerId)) throw new RuleError('PLAYER_NOT_IN_ROOM', 'Player is not a member of this room.');
    return room;
  }

  list(query = '', joinableOnly = false, offset = 0, limit = 100): RoomSummary[] {
    const normalized = query.trim().toLocaleLowerCase();
    return this.store.values().map((record) => new Room(record).summary())
      .filter((room) => room.settings.visibility === 'public')
      .filter((room) => !joinableOnly || room.status === 'open' && room.players < room.maxPlayers)
      .filter((room) => !normalized || `${room.name} ${room.hostName} ${room.settings.tags.join(' ')}`.toLocaleLowerCase().includes(normalized))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.roomId.localeCompare(right.roomId))
      .slice(Math.max(0, offset), Math.max(0, offset) + Math.min(100, Math.max(1, limit)));
  }

  cleanup(now = Date.now()): string[] {
    const removed: string[] = [];
    for (const record of this.store.values()) {
      if (record.status === 'playing') continue;
      if (record.members.length === 0 || now - record.updatedAt >= this.idleMs) {
        this.store.delete(record.roomId);
        this.ownership.release(record.roomId);
        removed.push(record.roomId);
      }
    }
    return removed;
  }

  values(): Room[] {
    return this.store.values().map((record) => new Room(record));
  }

  remove(roomId: string): void {
    this.store.delete(roomId);
    this.ownership.release(roomId);
  }

  save(room: Room): void {
    room.touch();
    this.store.set(room.record);
  }
}
