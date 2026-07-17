import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type RequestListener, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import {
  FRONT_DEFINITIONS,
  LOBBY_LIMITS,
  PROTOCOL_VERSION,
  RuleError,
  validateClientAction,
  type BattleSummary,
  type ClientAction,
  type MatchmakingState,
  type ServerStatus,
  type SubmittedDeck,
  type ValidationResult
} from '../common/src/index.js';
import type { Catalog, DeckSubmissionEnvelope } from '../catalog.js';
import { sanitizeSubmittedDeck, validateSubmittedDeck } from '../catalog.js';
import type { ServerConfig } from '../config.js';
import { GameSession } from '../games/GameSession.js';
import { GameSessionManager } from '../games/GameSessionManager.js';
import { LobbyService } from '../lobby/LobbyService.js';
import { MatchmakingQueue, type MatchCancellation } from '../matchmaking/MatchmakingQueue.js';
import { MetricsService } from '../metrics/MetricsService.js';
import { CooldownLimiter } from '../rate-limit/RateLimiter.js';
import { RoomManager, type CreateRoomOptions, type UpdateRoomOptions } from '../rooms/RoomManager.js';
import { InMemoryMatchStore, InMemoryRoomStore, InMemorySessionStore } from '../stores/InMemoryStore.js';
import { Logger } from '../utils.js';
import { ConnectionManager, type ManagedConnection, type OutboundScope } from './ConnectionManager.js';
import { SessionManager } from './SessionManager.js';
import type { PlayerSession } from './models.js';

const secureEquals = (left: string, right: string): boolean => {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
};

export class AeonfrontServer {
  private readonly httpServer: HttpServer;
  private readonly wss: WebSocketServer;
  private readonly metrics = new MetricsService();
  private readonly cooldowns = new CooldownLimiter();
  private readonly sessions: SessionManager;
  private readonly rooms: RoomManager;
  private readonly matchmaking: MatchmakingQueue;
  private readonly games: GameSessionManager;
  private readonly lobby: LobbyService;
  private readonly connections: ConnectionManager;
  private housekeeping: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(
    public readonly config: ServerConfig,
    public readonly catalog: Catalog
  ) {
    const activeFronts = new Set(catalog.packs.filter((pack) => ['preview', 'released'].includes(pack.releaseStatus)).flatMap((pack) => pack.fronts));
    if (FRONT_DEFINITIONS.some((front) => front.enabled && !activeFronts.has(front.frontId))) throw new Error('An enabled front is missing from active content packs.');
    this.sessions = new SessionManager(new InMemorySessionStore(), config.reconnectWindowMs, config.maxConnections);
    this.rooms = new RoomManager(new InMemoryRoomStore(), config.maxRooms, config.roomIdleMs, config.nodeId);
    this.matchmaking = new MatchmakingQueue(new InMemoryMatchStore(), this.sessions, this.rooms, config.matchmakingConfirmMs);
    this.games = new GameSessionManager(catalog, this.sessions, this.rooms, config.maxActiveGames, {
      onStarting: (game) => this.gameStarting(game),
      onUpdate: (game) => this.broadcastGameState(game),
      onEnd: (game, summary, serializedGame) => this.gameEnded(game, summary, serializedGame),
      onTimeout: () => this.metrics.recordTimeout()
    });
    this.lobby = new LobbyService(this.sessions, this.rooms, () => this.statusPayload(), (playerId) => this.matchmaking.state(playerId));
    this.connections = new ConnectionManager(config, {
      onMessage: (connection, raw) => this.receive(connection, raw),
      onClose: (connection) => this.disconnect(connection),
      onMessageRecorded: () => this.metrics.recordMessage(),
      onErrorRecorded: () => this.metrics.recordError()
    });
    const requestListener: RequestListener = (request, response) => this.httpRequest(request, response);
    this.httpServer = config.tls
      ? createHttpsServer({ key: readFileSync(config.privateKey!), cert: readFileSync(config.certificate!) }, requestListener)
      : createHttpServer(requestListener);
    this.wss = new WebSocketServer({ server: this.httpServer, maxPayload: config.maxMessageBytes, perMessageDeflate: false });
    this.wss.on('connection', (ws, request) => {
      const connection = this.connections.accept(ws, request.socket.remoteAddress ?? 'unknown');
      if (connection) this.send(connection, 'serverStatus', this.statusPayload());
    });
  }

  async listen(): Promise<AddressInfo> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.config.port, this.config.host, () => {
        this.httpServer.off('error', reject);
        resolve();
      });
    });
    this.housekeeping = setInterval(() => this.tick(), 2_000);
    this.housekeeping.unref();
    const address = this.address();
    if (!address) throw new Error('Server did not expose a TCP address.');
    Logger.info(`Aeonfront server listening on ${address.address}:${address.port}.`);
    if (this.config.publishServer) void this.publish();
    return address;
  }

  async close(): Promise<void> {
    this.draining = true;
    if (this.housekeeping) clearInterval(this.housekeeping);
    this.housekeeping = null;
    this.games.close();
    this.connections.closeAll();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    if (this.httpServer.listening) await new Promise<void>((resolve, reject) => this.httpServer.close((error) => error ? reject(error) : resolve()));
  }

  address(): AddressInfo | null {
    const address = this.httpServer.address();
    return address && typeof address !== 'string' ? address : null;
  }

  health(): Record<string, unknown> {
    return { ...this.statusPayload(), metrics: this.metrics.counters(), loadedCards: this.catalog.cards.length, packVersions: this.catalog.packVersions };
  }

  getGameForTesting(gameId?: string): ReturnType<GameSessionManager['getGameForTesting']> {
    return this.games.getGameForTesting(gameId);
  }

  private receive(connection: ManagedConnection, raw: string): void {
    let requestId: string | undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).requestId === 'string') requestId = (parsed as Record<string, unknown>).requestId as string;
      const issues = validateClientAction(parsed);
      if (issues.length > 0) throw new RuleError('INVALID_MESSAGE', 'Message failed runtime validation.', { issues });
      const action = parsed as ClientAction;
      if (action.protocolVersion !== PROTOCOL_VERSION) throw new RuleError('PROTOCOL_MISMATCH', `Expected protocol ${PROTOCOL_VERSION}.`, { received: action.protocolVersion });
      const currentSession = this.sessions.byConnection(connection.id);
      if (connection.processed.has(action.requestId) || currentSession?.processedRequestIds.includes(action.requestId)) {
        this.send(connection, 'requestAccepted', { duplicate: true }, { requestId: action.requestId });
        const session = this.sessions.byConnection(connection.id);
        if (session) this.sync(connection, session);
        return;
      }
      this.handle(connection, action);
      this.connections.markProcessed(connection, action.requestId);
      const updatedSession = this.sessions.byConnection(connection.id);
      if (updatedSession && !updatedSession.processedRequestIds.includes(action.requestId)) {
        updatedSession.processedRequestIds.push(action.requestId);
        if (updatedSession.processedRequestIds.length > 500) updatedSession.processedRequestIds.splice(0, updatedSession.processedRequestIds.length - 500);
        this.sessions.update(updatedSession);
      }
    } catch (error) {
      this.metrics.recordError();
      const ruleError = error instanceof RuleError ? error : new RuleError('INVALID_REQUEST', error instanceof Error ? error.message : 'Invalid request.');
      this.send(connection, 'error', { code: ruleError.code, message: ruleError.message, retryable: ['RATE_LIMITED', 'SERVER_BUSY'].includes(ruleError.code), details: ruleError.details }, { ...(requestId ? { requestId } : {}) });
    }
  }

  private handle(connection: ManagedConnection, action: ClientAction): void {
    switch (action.action) {
      case 'status':
        this.send(connection, 'serverStatus', this.statusPayload(), { requestId: action.requestId });
        break;
      case 'authenticate':
        this.authenticate(connection, action.password, action.requestId);
        break;
      case 'join':
        this.join(connection, action.name, action.reconnectToken, action.requestId);
        break;
      case 'enterLobby':
        this.enterLobby(connection, action.requestId);
        break;
      case 'leaveLobby':
        this.send(connection, 'returnedToLobby', { playerId: this.requireSession(connection).playerId }, { requestId: action.requestId });
        break;
      case 'requestLobbySnapshot':
        this.sendLobbySnapshot(connection, this.requireSession(connection), action.requestId);
        break;
      case 'requestRoomList':
        this.send(connection, 'roomListSnapshot', this.rooms.list(action.query ?? '', action.joinableOnly === true, action.offset ?? 0, action.limit ?? 100), { requestId: action.requestId });
        break;
      case 'requestPresence':
        this.send(connection, 'presenceUpdated', this.lobby.presence(), { requestId: action.requestId });
        break;
      case 'createRoom':
        this.createRoom(connection, action.room, action.requestId);
        break;
      case 'joinRoom':
        this.joinRoom(connection, action.roomId, action.password, action.requestId);
        break;
      case 'leaveRoom':
        this.leaveRoom(connection, action.roomId, action.requestId);
        break;
      case 'updateRoom':
        this.updateRoom(connection, action.roomId, action.patch, action.requestId);
        break;
      case 'kickPlayer':
        this.kickPlayer(connection, action.roomId, action.playerId, action.requestId);
        break;
      case 'selectDeck':
        this.selectDeck(connection, action, action.requestId);
        break;
      case 'setReady':
        this.setReady(connection, action.roomId, action.ready, action.requestId);
        break;
      case 'ready': {
        const session = this.requireSession(connection);
        this.setReady(connection, action.roomId ?? session.roomId ?? '', true, action.requestId);
        break;
      }
      case 'sendLobbyChat':
        this.lobbyChat(connection, action.message, action.requestId);
        break;
      case 'sendRoomChat':
        this.roomChat(connection, action.roomId, action.message, action.requestId);
        break;
      case 'chatMessage': {
        const session = this.requireSession(connection);
        if (session.roomId) this.roomChat(connection, session.roomId, action.message, action.requestId);
        else this.lobbyChat(connection, action.message, action.requestId);
        break;
      }
      case 'joinMatchmaking':
        this.joinMatchmaking(connection, action.deck, action.mmr, action.requestId);
        break;
      case 'leaveMatchmaking':
        this.leaveMatchmaking(connection, action.requestId);
        break;
      case 'acceptMatch':
        this.acceptMatch(connection, action.roomId, action.requestId);
        break;
      case 'declineMatch':
        this.declineMatch(connection, action.roomId, action.requestId);
        break;
      case 'practice':
        this.startPractice(connection, action, action.requestId);
        break;
      case 'submitTurn':
        this.gameAction(connection, action.gameId, action.requestId, (game, session) => {
          this.assertResult(game.submit(session.playerId, action.intent, this.ruleRequestId(session, action.requestId)));
          this.send(connection, 'turnAccepted', { turn: game.game.turn }, { requestId: action.requestId, gameId: game.gameId });
        });
        break;
      case 'undoTurn':
        this.gameAction(connection, action.gameId, action.requestId, (game, session) => this.assertResult(game.undo(session.playerId, this.ruleRequestId(session, action.requestId))));
        break;
      case 'lockTurn':
        this.gameAction(connection, action.gameId, action.requestId, (game, session) => {
          this.assertResult(game.lock(session.playerId, this.ruleRequestId(session, action.requestId)));
          this.send(connection, 'turnLocked', { turn: action.turn }, { requestId: action.requestId, gameId: game.gameId });
        });
        break;
      case 'raiseBanner':
        this.gameAction(connection, action.gameId, action.requestId, (game, session) => {
          this.assertResult(game.banner(session.playerId, this.ruleRequestId(session, action.requestId)));
          this.broadcastGame(game, 'bannerRaised', { playerId: session.playerId, current: game.game.stake.current, pending: game.game.stake.pending }, { requestId: action.requestId });
        });
        break;
      case 'withdraw':
        this.gameAction(connection, action.gameId, action.requestId, (game, session) => {
          this.assertResult(game.withdraw(session.playerId, this.ruleRequestId(session, action.requestId)));
          this.broadcastGame(game, 'playerWithdrew', { playerId: session.playerId, winner: game.game.winner }, { requestId: action.requestId });
        });
        break;
      case 'requestSync':
        this.sync(connection, this.requireSession(connection), action.requestId);
        break;
      case 'requestRematch':
        this.requestRematch(connection, action.requestId);
        break;
      case 'returnToLobby':
        this.returnToLobby(connection, action.requestId);
        break;
      case 'pong': {
        const session = this.sessions.byConnection(connection.id);
        if (session && action.clientTime !== undefined) {
          session.latencyMs = Math.max(0, Math.min(10_000, Date.now() - action.clientTime));
          this.sessions.update(session);
        }
        connection.lastPong = Date.now();
        this.send(connection, 'pong', { serverTime: Date.now() }, { requestId: action.requestId });
        break;
      }
    }
  }

  private authenticate(connection: ManagedConnection, password: string, requestId: string): void {
    if (this.config.password && !secureEquals(password, this.config.password)) throw new RuleError('AUTHENTICATION_FAILED', 'Incorrect server password.');
    connection.authenticated = true;
    this.send(connection, 'authenticated', { ok: true }, { requestId });
  }

  private join(connection: ManagedConnection, name: string, reconnectToken: string | undefined, requestId: string): void {
    if (!connection.authenticated) throw new RuleError('AUTHENTICATION_REQUIRED', 'Authenticate before joining.');
    if (this.sessions.byConnection(connection.id)) throw new RuleError('ALREADY_JOINED', 'This connection already has a session.');
    const result = this.sessions.connect(connection.id, name, reconnectToken);
    if (result.reconnected) this.metrics.recordReconnect();
    this.send(connection, result.reconnected ? 'reconnected' : 'joined', { playerId: result.session.playerId, name: result.session.name, reconnectToken: result.reconnectToken }, { requestId });
    if (result.session.roomId) {
      const roomState = this.rooms.setConnected(result.session.playerId, true);
      if (roomState) this.broadcastRoomState(roomState.roomId);
    }
    this.sync(connection, result.session);
    this.broadcastPresence();
  }

  private enterLobby(connection: ManagedConnection, requestId: string): void {
    const session = this.requireSession(connection);
    if (session.gameId || session.roomId) throw new RuleError('PLAYER_BUSY', 'Return from the current room or game before entering the lobby.');
    session.status = 'lobby';
    this.sessions.update(session);
    this.send(connection, 'lobbyEntered', { playerId: session.playerId }, { requestId });
    this.sendLobbySnapshot(connection, session);
    this.broadcastPresence();
  }

  private createRoom(connection: ManagedConnection, options: CreateRoomOptions, requestId: string): void {
    const session = this.requireSession(connection);
    if (!this.cooldowns.allow(`room:${session.playerId}`, this.config.roomCreateIntervalMs)) throw new RuleError('ROOM_CREATE_RATE_LIMIT', 'Create rooms less frequently.');
    const state = this.rooms.create(session, options);
    this.sessions.update(session);
    this.send(connection, 'roomCreated', state, { requestId, roomId: state.roomId });
    this.broadcastRoomState(state.roomId);
    this.broadcastRoomList('roomCreated', state);
    this.broadcastPresence();
  }

  private joinRoom(connection: ManagedConnection, roomId: string, password: string | undefined, requestId: string): void {
    const session = this.requireSession(connection);
    const state = this.rooms.join(session, roomId, password);
    this.sessions.update(session);
    this.send(connection, 'roomJoined', state, { requestId, roomId });
    this.broadcastRoomState(roomId);
    this.broadcastRoomList('roomUpdated', state);
    this.broadcastPresence();
  }

  private leaveRoom(connection: ManagedConnection, roomId: string, requestId: string): void {
    const session = this.requireSession(connection);
    if (session.roomId !== roomId) throw new RuleError('PLAYER_NOT_IN_ROOM', 'Player is not in that room.');
    const result = this.rooms.leave(session);
    this.sessions.update(session);
    this.send(connection, 'roomLeft', { roomId }, { requestId, roomId });
    if (result.removed) this.broadcastRoomRemoved(roomId);
    else if (result.state) {
      this.broadcastRoomState(roomId);
      this.broadcastRoomList('roomUpdated', result.state);
    }
    this.sendLobbySnapshot(connection, session);
    this.broadcastPresence();
  }

  private updateRoom(connection: ManagedConnection, roomId: string, patch: UpdateRoomOptions, requestId: string): void {
    const session = this.requireSession(connection);
    if (session.roomId !== roomId) throw new RuleError('PLAYER_NOT_IN_ROOM', 'Player is not in that room.');
    const state = this.rooms.update(session, patch);
    this.send(connection, 'roomUpdated', state, { requestId, roomId });
    this.broadcastRoomState(roomId);
    this.broadcastRoomList('roomUpdated', state);
  }

  private kickPlayer(connection: ManagedConnection, roomId: string, playerId: string, requestId: string): void {
    const session = this.requireSession(connection);
    if (session.roomId !== roomId) throw new RuleError('PLAYER_NOT_IN_ROOM', 'Player is not in that room.');
    const result = this.rooms.kick(session, playerId);
    const kicked = this.sessions.byPlayer(playerId);
    if (kicked) {
      kicked.roomId = null;
      kicked.status = kicked.connectionId ? 'lobby' : 'reconnecting';
      this.sessions.update(kicked);
      this.sendSession(kicked, 'roomLeft', { roomId, reason: 'kicked' }, { roomId });
    }
    this.send(connection, 'roomUpdated', result.state, { requestId, roomId });
    this.broadcastRoomState(roomId);
    this.broadcastRoomList('roomUpdated', result.state);
    this.broadcastPresence();
  }

  private selectDeck(connection: ManagedConnection, action: Extract<ClientAction, { action: 'selectDeck' }>, requestId: string): void {
    const session = this.requireSession(connection);
    const deck = this.submittedDeck(action);
    if (!session.roomId) throw new RuleError('ROOM_REQUIRED', 'Join a room before selecting an online deck.');
    if (action.roomId && action.roomId !== session.roomId) throw new RuleError('PLAYER_NOT_IN_ROOM', 'Deck selection is scoped to another room.');
    const state = this.rooms.selectDeck(session, deck);
    this.sessions.update(session);
    this.send(connection, 'deckSelected', { deckId: deck.deckId, name: deck.name, cards: deck.cardIds.length, catalogVersion: deck.catalogVersion }, { requestId, roomId: state.roomId });
    this.broadcastRoomState(state.roomId);
  }

  private setReady(connection: ManagedConnection, roomId: string, ready: boolean, requestId: string): void {
    const session = this.requireSession(connection);
    if (session.roomId !== roomId) throw new RuleError('PLAYER_NOT_IN_ROOM', 'Player is not in that room.');
    const state = this.rooms.setReady(session, ready);
    this.send(connection, 'readyAccepted', { ready }, { requestId, roomId });
    this.broadcastRoomState(roomId);
    this.broadcastRoomList('roomUpdated', state);
    if (state.status === 'ready') this.games.startRoom(roomId);
  }

  private lobbyChat(connection: ManagedConnection, content: string, requestId: string): void {
    const session = this.requireSession(connection);
    this.assertChatRate(session);
    const message = this.lobby.playerMessage(session, content);
    this.send(connection, 'requestAccepted', { sent: true }, { requestId });
    this.broadcastLobby('lobbyChatMessage', message);
  }

  private roomChat(connection: ManagedConnection, roomId: string, content: string, requestId: string): void {
    const session = this.requireSession(connection);
    if (session.roomId !== roomId) throw new RuleError('PLAYER_NOT_IN_ROOM', 'Player is not in that room.');
    this.assertChatRate(session);
    const room = this.rooms.require(roomId);
    const message = this.lobby.roomMessage(session, roomId, content);
    room.appendMessage(message, LOBBY_LIMITS.recentChatMessages);
    this.rooms.save(room);
    this.send(connection, 'requestAccepted', { sent: true }, { requestId, roomId });
    this.broadcastRoom(roomId, 'roomChatMessage', message);
  }

  private joinMatchmaking(connection: ManagedConnection, deckValue: SubmittedDeck, mmr: number | undefined, requestId: string): void {
    const session = this.requireSession(connection);
    const deck = this.submittedDeck({ cardIds: deckValue.cardIds, catalogVersion: deckValue.catalogVersion, deck: deckValue });
    const result = this.matchmaking.join(session, deck, mmr);
    this.send(connection, 'matchmakingQueued', result.state, { requestId });
    if (result.found) {
      for (const player of result.found.players) this.sendSession(player, 'matchFound', { ...this.matchmaking.state(player.playerId), room: result.found.room }, { roomId: result.found.room.roomId });
      this.broadcastRoomList('roomCreated', result.found.room);
      this.broadcastPresence();
    } else {
      this.broadcastMatchmakingUpdates();
    }
  }

  private leaveMatchmaking(connection: ManagedConnection, requestId: string): void {
    const session = this.requireSession(connection);
    const cancellation = this.matchmaking.leave(session.playerId);
    if (!cancellation) throw new RuleError('NOT_QUEUED', 'The player is not matchmaking.');
    this.notifyCancellation(cancellation);
    this.send(connection, 'matchCancelled', { reason: cancellation.reason }, { requestId });
    this.broadcastMatchmakingUpdates();
  }

  private acceptMatch(connection: ManagedConnection, roomId: string, requestId: string): void {
    const session = this.requireSession(connection);
    const result = this.matchmaking.accept(session, roomId);
    for (const player of result.players) this.sendSession(player, 'matchmakingUpdated', this.matchmaking.state(player.playerId), { roomId });
    this.send(connection, 'requestAccepted', { accepted: true }, { requestId, roomId });
    if (result.ready) this.games.startRoom(roomId);
  }

  private declineMatch(connection: ManagedConnection, roomId: string, requestId: string): void {
    const session = this.requireSession(connection);
    if (session.roomId !== roomId) throw new RuleError('MATCH_NOT_FOUND', 'The match is no longer available.');
    const cancellation = this.matchmaking.decline(session.playerId);
    this.notifyCancellation(cancellation);
    this.send(connection, 'matchCancelled', { reason: cancellation.reason }, { requestId, roomId });
    this.broadcastRoomRemoved(roomId);
  }

  private startPractice(connection: ManagedConnection, action: Extract<ClientAction, { action: 'practice' }>, requestId: string): void {
    const session = this.requireSession(connection);
    const deck = this.submittedDeck(action);
    const game = this.games.startPractice(session, deck, this.config.turnDurationMs);
    this.send(connection, 'practiceStarted', { gameId: game.gameId, mode: 'practice' }, { requestId, gameId: game.gameId });
  }

  private gameAction(connection: ManagedConnection, gameId: string | undefined, _requestId: string, action: (game: GameSession, session: PlayerSession) => void): void {
    const session = this.requireSession(connection);
    const game = this.games.requireFor(session, gameId);
    if (game.game.phase === 'ended') throw new RuleError('GAME_NOT_ACTIVE', 'The game has ended.');
    action(game, session);
  }

  private requestRematch(connection: ManagedConnection, requestId: string): void {
    const session = this.requireSession(connection);
    const next = this.games.requestRematch(session);
    this.send(connection, 'rematchRequested', { playerId: session.playerId }, { requestId, ...(session.gameId ? { gameId: session.gameId } : {}) });
    if (next) this.send(connection, 'requestAccepted', { gameId: next.gameId }, { requestId, gameId: next.gameId });
  }

  private returnToLobby(connection: ManagedConnection, requestId: string): void {
    const session = this.requireSession(connection);
    if (session.gameId) {
      const game = this.games.requireFor(session);
      if (game.game.phase !== 'ended') throw new RuleError('GAME_ACTIVE', 'The active game has not ended.');
      session.gameId = null;
    }
    if (session.roomId) {
      const room = this.rooms.require(session.roomId);
      if (room.record.status === 'playing') throw new RuleError('GAME_ACTIVE', 'The room game has not ended.');
      this.rooms.leave(session);
    }
    session.status = 'lobby';
    this.sessions.update(session);
    this.send(connection, 'returnedToLobby', { playerId: session.playerId }, { requestId });
    this.sendLobbySnapshot(connection, session);
    this.broadcastRoomList();
    this.broadcastPresence();
  }

  private gameStarting(game: GameSession): void {
    const startsAt = Date.now();
    for (const playerId of game.playerIds) {
      const session = this.sessions.byPlayer(playerId);
      if (!session) continue;
      this.sendSession(session, 'gameStarting', { gameId: game.gameId, startsAt }, { ...(game.roomId ? { roomId: game.roomId } : {}), gameId: game.gameId });
      this.sendSession(session, 'gameStarted', { gameId: game.gameId, mode: game.mode }, { ...(game.roomId ? { roomId: game.roomId } : {}), gameId: game.gameId });
    }
    if (game.roomId) {
      this.broadcastRoomState(game.roomId);
      this.broadcastPresence();
    }
  }

  private broadcastGameState(game: GameSession): void {
    for (const playerId of game.playerIds) {
      const session = this.sessions.byPlayer(playerId);
      if (!session) continue;
      this.sendSession(session, 'privateGameState', game.privateView(playerId), { ...(game.roomId ? { roomId: game.roomId } : {}), gameId: game.gameId });
    }
  }

  private gameEnded(game: GameSession, summary: BattleSummary, serializedGame: string): void {
    this.metrics.recordCompletedGame(summary.durationMs);
    for (const playerId of game.playerIds) {
      const session = this.sessions.byPlayer(playerId);
      if (!session) continue;
      this.sendSession(session, 'gameEnded', { summary, serializedGame }, { ...(game.roomId ? { roomId: game.roomId } : {}), gameId: game.gameId });
    }
    if (game.roomId) {
      this.broadcastRoomState(game.roomId);
      this.broadcastRoomList();
    }
  }

  private sync(connection: ManagedConnection, session: PlayerSession, requestId?: string): void {
    if (session.gameId) {
      const game = this.games.requireFor(session);
      this.send(connection, 'privateGameState', game.privateView(session.playerId), { ...(requestId ? { requestId } : {}), ...(game.roomId ? { roomId: game.roomId } : {}), gameId: game.gameId });
      return;
    }
    if (session.roomId) {
      const room = this.rooms.require(session.roomId).state();
      this.send(connection, 'roomJoined', room, { ...(requestId ? { requestId } : {}), roomId: room.roomId });
      return;
    }
    this.sendLobbySnapshot(connection, session, requestId);
  }

  private disconnect(connection: ManagedConnection): void {
    const session = this.sessions.disconnect(connection.id);
    if (!session) return;
    const cancellation = this.matchmaking.leave(session.playerId);
    if (cancellation) this.notifyCancellation(cancellation);
    if (session.roomId) {
      const state = this.rooms.setConnected(session.playerId, false);
      if (state) this.broadcastRoomState(state.roomId);
    }
    this.broadcastPresence();
  }

  private tick(): void {
    const now = Date.now();
    this.connections.heartbeat(now);
    for (const cancellation of this.matchmaking.cleanup(now)) this.notifyCancellation(cancellation);
    for (const session of this.sessions.expired(now)) {
      this.games.forfeitExpired(session.playerId);
      if (session.roomId) {
        try {
          const room = this.rooms.require(session.roomId);
          if (room.record.status !== 'playing') this.rooms.leave(session);
        } catch {
          session.roomId = null;
        }
      }
      this.sessions.remove(session.playerId);
    }
    for (const roomId of this.rooms.cleanup(now)) this.broadcastRoomRemoved(roomId);
  }

  private statusPayload(): ServerStatus {
    const sessions = this.sessions.values();
    return {
      ok: true,
      status: this.draining ? 'draining' : this.httpServer?.listening ? 'ready' : 'starting',
      nodeId: this.config.nodeId,
      title: this.config.title,
      owner: this.config.owner,
      requirePassword: Boolean(this.config.password),
      tls: this.config.tls,
      connectedUsers: this.connections?.values().length ?? 0,
      lobbyUsers: sessions.filter((session) => session.connectionId && session.status === 'lobby').length,
      rooms: this.rooms.values().length,
      activeGames: this.games.activeCount(),
      matchmakingUsers: this.matchmaking.size(),
      uptime: this.metrics.uptime(),
      protocolVersion: PROTOCOL_VERSION,
      catalogVersion: this.catalog.catalogVersion,
      enabledFronts: FRONT_DEFINITIONS.filter((front) => front.enabled).length
    };
  }

  private httpRequest(request: IncomingMessage, response: Parameters<RequestListener>[1]): void {
    if (request.url === '/health' || request.url === '/ready') {
      const ready = !this.draining && this.httpServer.listening;
      response.writeHead(request.url === '/ready' && !ready ? 503 : 200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(request.url === '/ready' ? { ok: ready, status: ready ? 'ready' : 'starting', nodeId: this.config.nodeId } : this.health()));
      return;
    }
    if (request.url === '/metrics' && this.config.metricsEnabled) {
      if (this.config.metricsToken) {
        const provided = request.headers.authorization?.replace(/^Bearer\s+/iu, '') ?? '';
        if (!secureEquals(provided, this.config.metricsToken)) {
          response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
      }
      const status = this.statusPayload();
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      response.end(this.metrics.prometheus(status));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'not_found' }));
  }

  private submittedDeck(action: DeckSubmissionEnvelope): SubmittedDeck {
    const result = validateSubmittedDeck(action, this.catalog);
    this.assertResult(result);
    return sanitizeSubmittedDeck(action, this.catalog);
  }

  private assertResult(result: ValidationResult): void {
    if (!result.ok) throw new RuleError(result.issues[0]?.code ?? 'RULE_REJECTED', result.issues[0]?.message ?? 'Action rejected.', { issues: result.issues });
  }

  private requireSession(connection: ManagedConnection): PlayerSession {
    return this.sessions.requireConnection(connection.id);
  }

  private ruleRequestId(session: PlayerSession, requestId: string): string {
    return `${session.playerId}:${requestId}`;
  }

  private assertChatRate(session: PlayerSession): void {
    if (!this.cooldowns.allow(`chat:${session.playerId}`, this.config.chatIntervalMs)) throw new RuleError('CHAT_RATE_LIMIT', 'Send chat messages less frequently.');
  }

  private send(connection: ManagedConnection, event: string, payload: unknown, scope: OutboundScope = {}): void {
    this.connections.send(connection, event, payload, scope);
  }

  private sendSession(session: PlayerSession, event: string, payload: unknown, scope: OutboundScope = {}): void {
    if (!session.connectionId) return;
    const connection = this.connections.get(session.connectionId);
    if (connection) this.send(connection, event, payload, scope);
  }

  private broadcastLobby(event: string, payload: unknown): void {
    for (const session of this.sessions.values()) if (session.connectionId && session.status === 'lobby') this.sendSession(session, event, payload);
  }

  private broadcastRoom(roomId: string, event: string, payload: unknown): void {
    const room = this.rooms.require(roomId);
    for (const member of room.record.members) {
      const session = this.sessions.byPlayer(member.playerId);
      if (session) this.sendSession(session, event, payload, { roomId });
    }
  }

  private broadcastGame(game: GameSession, event: string, payload: unknown, scope: OutboundScope = {}): void {
    for (const playerId of game.playerIds) {
      const session = this.sessions.byPlayer(playerId);
      if (session) this.sendSession(session, event, payload, { ...scope, ...(game.roomId ? { roomId: game.roomId } : {}), gameId: game.gameId });
    }
  }

  private broadcastRoomState(roomId: string): void {
    const state = this.rooms.require(roomId).state();
    this.broadcastRoom(roomId, 'roomUpdated', state);
    this.broadcastRoom(roomId, 'roomState', state);
  }

  private broadcastPresence(): void {
    this.broadcastLobby('presenceUpdated', this.lobby.presence());
  }

  private broadcastRoomList(event = 'roomListSnapshot', state?: { roomId: string }): void {
    if (state && event !== 'roomListSnapshot') this.broadcastLobby(event, this.rooms.require(state.roomId).state());
    else this.broadcastLobby('roomListSnapshot', this.rooms.list('', false, 0, 100));
  }

  private broadcastRoomRemoved(roomId: string): void {
    this.broadcastLobby('roomRemoved', { roomId });
  }

  private sendLobbySnapshot(connection: ManagedConnection, session: PlayerSession, requestId?: string): void {
    this.send(connection, 'lobbySnapshot', this.lobby.snapshot(session), { ...(requestId ? { requestId } : {}) });
  }

  private broadcastMatchmakingUpdates(): void {
    for (const session of this.sessions.values()) {
      const state: MatchmakingState = this.matchmaking.state(session.playerId);
      if (state.status !== 'idle') this.sendSession(session, 'matchmakingUpdated', state);
    }
  }

  private notifyCancellation(cancellation: MatchCancellation): void {
    for (const playerId of cancellation.playerIds) {
      const session = this.sessions.byPlayer(playerId);
      if (session) this.sendSession(session, 'matchCancelled', { reason: cancellation.reason }, { ...(cancellation.roomId ? { roomId: cancellation.roomId } : {}) });
    }
    if (cancellation.roomId) this.broadcastRoomRemoved(cancellation.roomId);
  }

  private async publish(): Promise<void> {
    if (!this.config.publishEndpoint) return;
    try {
      const response = await fetch(this.config.publishEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ip: this.config.publishAddress, port: this.address()?.port ?? this.config.port, tls: this.config.tls, product: 'Aeonfront' })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      Logger.info('Server published to the configured listing.');
    } catch (error) {
      Logger.warning(`Server listing publication failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
}
