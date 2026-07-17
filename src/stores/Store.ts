export interface SessionStore<T extends { sessionId: string }> {
  get(sessionId: string): T | undefined;
  set(session: T): void;
  delete(sessionId: string): void;
  values(): T[];
}

export interface RoomStore<T extends { roomId: string }> {
  get(roomId: string): T | undefined;
  set(room: T): void;
  delete(roomId: string): void;
  values(): T[];
}

export interface MatchStore<T extends { matchId: string }> {
  get(matchId: string): T | undefined;
  set(match: T): void;
  delete(matchId: string): void;
  values(): T[];
}

export interface PlayerProfileStore<T extends { playerId: string }> {
  get(playerId: string): T | undefined;
  set(profile: T): void;
  delete(playerId: string): void;
  values(): T[];
}

export interface MessageBus {
  publish(topic: string, message: unknown): void;
  subscribe(topic: string, listener: (message: unknown) => void): () => void;
}
