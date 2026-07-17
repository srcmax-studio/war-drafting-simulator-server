import type { MatchStore, MessageBus, PlayerProfileStore, RoomStore, SessionStore } from './Store.js';

export class InMemorySessionStore<T extends { sessionId: string }> implements SessionStore<T> {
  private readonly records = new Map<string, T>();
  get(sessionId: string): T | undefined { return this.records.get(sessionId); }
  set(session: T): void { this.records.set(session.sessionId, session); }
  delete(sessionId: string): void { this.records.delete(sessionId); }
  values(): T[] { return [...this.records.values()]; }
}

export class InMemoryRoomStore<T extends { roomId: string }> implements RoomStore<T> {
  private readonly records = new Map<string, T>();
  get(roomId: string): T | undefined { return this.records.get(roomId); }
  set(room: T): void { this.records.set(room.roomId, room); }
  delete(roomId: string): void { this.records.delete(roomId); }
  values(): T[] { return [...this.records.values()]; }
}

export class InMemoryMatchStore<T extends { matchId: string }> implements MatchStore<T> {
  private readonly records = new Map<string, T>();
  get(matchId: string): T | undefined { return this.records.get(matchId); }
  set(match: T): void { this.records.set(match.matchId, match); }
  delete(matchId: string): void { this.records.delete(matchId); }
  values(): T[] { return [...this.records.values()]; }
}

export class InMemoryPlayerProfileStore<T extends { playerId: string }> implements PlayerProfileStore<T> {
  private readonly records = new Map<string, T>();
  get(playerId: string): T | undefined { return this.records.get(playerId); }
  set(profile: T): void { this.records.set(profile.playerId, profile); }
  delete(playerId: string): void { this.records.delete(playerId); }
  values(): T[] { return [...this.records.values()]; }
}

export class InMemoryMessageBus implements MessageBus {
  private readonly listeners = new Map<string, Set<(message: unknown) => void>>();
  publish(topic: string, message: unknown): void { for (const listener of this.listeners.get(topic) ?? []) listener(message); }
  subscribe(topic: string, listener: (message: unknown) => void): () => void {
    const listeners = this.listeners.get(topic) ?? new Set<(message: unknown) => void>();
    listeners.add(listener);
    this.listeners.set(topic, listeners);
    return () => listeners.delete(listener);
  }
}
