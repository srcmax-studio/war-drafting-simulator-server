import type { PresenceStatus, SubmittedDeck } from '../common/src/index.js';

export interface PlayerSession {
  sessionId: string;
  playerId: string;
  name: string;
  reconnectTokenHash: string;
  connectionId: string | null;
  status: PresenceStatus;
  roomId: string | null;
  gameId: string | null;
  selectedDeck: SubmittedDeck | null;
  joinedAt: number;
  lastSeenAt: number;
  disconnectedAt: number | null;
  expiresAt: number | null;
  latencyMs: number | null;
  processedRequestIds: string[];
}

export interface SessionConnectionResult {
  session: PlayerSession;
  reconnectToken: string;
  reconnected: boolean;
}
