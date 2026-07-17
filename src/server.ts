import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type RequestListener, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import {
  FRONT_DEFINITIONS,
  PROTOCOL_VERSION,
  RuleError,
  createGame,
  createPlayerView,
  createPublicView,
  isClientAction,
  lockTurn,
  raiseBanner,
  submitTurnIntent,
  undoTurnIntent,
  withdraw,
  type CardDefinition,
  type ClientAction,
  type GameState,
  type PlayerView,
  type SubmittedDeck,
  type ValidationResult
} from './common/src/index.js';
import { choosePracticeIntent, choosePracticeRisk } from './ai.js';
import { sanitizeSubmittedDeck, validateSubmittedDeck, type Catalog, type DeckSubmissionEnvelope } from './catalog.js';
import type { ServerConfig } from './config.js';
import { Logger } from './utils.js';

interface Connection {
  id: string;
  ws: WebSocket;
  remoteName: string;
  authenticated: boolean;
  playerId: string | null;
  lastPong: number;
  processed: Set<string>;
}

interface PlayerRecord {
  playerId: string;
  name: string;
  reconnectToken: string;
  connection: Connection | null;
  selectedDeck: SubmittedDeck | null;
  ready: boolean;
  rematch: boolean;
  reconnectTimer: NodeJS.Timeout | null;
}

interface OutboundMessage {
  event: string;
  protocolVersion: string;
  sequence: number;
  requestId?: string;
  payload: unknown;
}

const MAX_MESSAGE_BYTES = 64 * 1024;

export class AeonfrontServer {
  private readonly httpServer: HttpServer;
  private readonly wss: WebSocketServer;
  private readonly connections = new Set<Connection>();
  private readonly players = new Map<string, PlayerRecord>();
  private readonly cardCatalog: Record<string, CardDefinition>;
  private heartbeat: NodeJS.Timeout | null = null;
  private turnTimer: NodeJS.Timeout | null = null;
  private transportSequence = 0;
  private seedCounter = 1;
  private mode: 'online' | 'practice' | null = null;
  private aiPlayerId: string | null = null;
  private game: GameState | null = null;
  private deadline: number | null = null;

  constructor(
    public readonly config: ServerConfig,
    public readonly catalog: Catalog
  ) {
    this.cardCatalog = Object.fromEntries(catalog.cards.map((card) => [card.cardId, card]));
    const activeFronts = new Set(catalog.packs.filter((pack) => ['preview', 'released'].includes(pack.releaseStatus)).flatMap((pack) => pack.fronts));
    if (FRONT_DEFINITIONS.some((front) => front.enabled && !activeFronts.has(front.frontId))) throw new Error('An enabled front is missing from active content packs.');
    const requestListener: RequestListener = (request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(this.health()));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'not_found' }));
    };
    this.httpServer = config.tls
      ? createHttpsServer({ key: readFileSync(config.privateKey!), cert: readFileSync(config.certificate!) }, requestListener)
      : createHttpServer(requestListener);
    this.wss = new WebSocketServer({ server: this.httpServer, maxPayload: MAX_MESSAGE_BYTES });
    this.wss.on('connection', (ws, request) => this.accept(ws, request.socket.remoteAddress ?? 'unknown'));
  }

  async listen(): Promise<AddressInfo> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.config.port, this.config.host, () => {
        this.httpServer.off('error', reject);
        resolve();
      });
    });
    this.heartbeat = setInterval(() => this.runHeartbeat(), 2_000);
    this.heartbeat.unref();
    const address = this.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Server did not expose a TCP address.');
    Logger.info(`Aeonfront server listening on ${address.address}:${address.port}.`);
    if (this.config.publishServer) void this.publish();
    return address;
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.turnTimer) clearTimeout(this.turnTimer);
    for (const player of this.players.values()) if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
    for (const connection of this.connections) connection.ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    if (this.httpServer.listening) await new Promise<void>((resolve, reject) => this.httpServer.close((error) => error ? reject(error) : resolve()));
  }

  address(): AddressInfo | null {
    const address = this.httpServer.address();
    return address && typeof address !== 'string' ? address : null;
  }

  health(): Record<string, unknown> {
    return {
      ok: true,
      product: 'Aeonfront',
      protocolVersion: PROTOCOL_VERSION,
      phase: this.game?.phase ?? 'lobby',
      turn: this.game?.turn ?? null,
      onlinePlayers: [...this.players.values()].filter((player) => player.connection).length,
      loadedCards: this.catalog.cards.length,
      enabledFronts: FRONT_DEFINITIONS.filter((front) => front.enabled).length,
      catalogVersion: this.catalog.catalogVersion,
      cardDataVersion: this.catalog.catalogVersion,
      packVersions: this.catalog.packVersions,
      assetDataVersion: this.catalog.assetVersion,
      generationEnabled: this.config.generation.enabled
    };
  }

  getGameForTesting(): GameState | null {
    return this.game;
  }

  private accept(ws: WebSocket, remoteName: string): void {
    const connection: Connection = {
      id: randomUUID(),
      ws,
      remoteName,
      authenticated: !this.config.password,
      playerId: null,
      lastPong: Date.now(),
      processed: new Set()
    };
    this.connections.add(connection);
    ws.on('message', (data) => this.receive(connection, data.toString()));
    ws.on('close', () => this.disconnect(connection));
    ws.on('error', (error) => Logger.warning(`WebSocket error from ${remoteName}: ${error.message}`));
    this.send(connection, 'serverStatus', this.statusPayload());
  }

  private receive(connection: Connection, raw: string): void {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isClientAction(parsed)) throw new RuleError('INVALID_MESSAGE', 'Message does not match the action envelope.');
      if (parsed.protocolVersion !== PROTOCOL_VERSION) {
        throw new RuleError('PROTOCOL_MISMATCH', `Expected protocol ${PROTOCOL_VERSION}.`, { received: parsed.protocolVersion });
      }
      if (connection.processed.has(parsed.requestId)) {
        this.send(connection, 'requestAccepted', { duplicate: true }, parsed.requestId);
        this.sendPrivateState(connection);
        return;
      }
      this.handle(connection, parsed);
      connection.processed.add(parsed.requestId);
    } catch (error) {
      const ruleError = error instanceof RuleError ? error : new RuleError('INVALID_REQUEST', error instanceof Error ? error.message : 'Invalid request.');
      let requestId: string | undefined;
      try {
        const candidate = JSON.parse(raw) as { requestId?: unknown };
        if (typeof candidate.requestId === 'string') requestId = candidate.requestId;
      } catch {
        // The structured error below is sufficient for malformed JSON.
      }
      this.send(connection, 'error', { code: ruleError.code, message: ruleError.message, details: ruleError.details }, requestId);
    }
  }

  private handle(connection: Connection, action: ClientAction): void {
    switch (action.action) {
      case 'status':
        this.send(connection, 'serverStatus', this.statusPayload(), action.requestId);
        break;
      case 'authenticate':
        this.authenticate(connection, action.password, action.requestId);
        break;
      case 'join':
        this.join(connection, action.name, action.reconnectToken, action.requestId);
        break;
      case 'selectDeck':
        this.selectDeck(connection, action, action.requestId);
        break;
      case 'ready':
        this.ready(connection, action.requestId);
        break;
      case 'practice':
        this.startPractice(connection, action, action.requestId);
        break;
      case 'submitTurn':
        this.requireGamePlayer(connection);
        this.assertResult(submitTurnIntent(this.game!, connection.playerId!, { ...action.intent, requestId: this.ruleRequestId(connection, action.requestId) }));
        this.send(connection, 'turnAccepted', { turn: this.game!.turn }, action.requestId);
        this.afterGameAction();
        break;
      case 'undoTurn':
        this.requireGamePlayer(connection);
        this.assertResult(undoTurnIntent(this.game!, connection.playerId!, this.ruleRequestId(connection, action.requestId)));
        this.send(connection, 'turnAccepted', { undone: true, turn: this.game!.turn }, action.requestId);
        this.afterGameAction();
        break;
      case 'lockTurn':
        this.requireGamePlayer(connection);
        this.assertResult(lockTurn(this.game!, connection.playerId!, this.ruleRequestId(connection, action.requestId)));
        this.send(connection, 'turnLocked', { turn: action.turn }, action.requestId);
        this.afterGameAction();
        break;
      case 'raiseBanner':
        this.requireGamePlayer(connection);
        this.assertResult(raiseBanner(this.game!, connection.playerId!, this.ruleRequestId(connection, action.requestId)));
        this.broadcast('bannerRaised', { playerId: connection.playerId, current: this.game!.stake.current, pending: this.game!.stake.pending }, action.requestId);
        this.afterGameAction();
        break;
      case 'withdraw':
        this.requireGamePlayer(connection);
        this.assertResult(withdraw(this.game!, connection.playerId!, this.ruleRequestId(connection, action.requestId)));
        this.broadcast('playerWithdrew', { playerId: connection.playerId, winner: this.game!.winner }, action.requestId);
        this.afterGameAction();
        break;
      case 'requestSync':
        this.sendPrivateState(connection, action.requestId);
        break;
      case 'requestRematch':
        this.requestRematch(connection, action.requestId);
        break;
      case 'chatMessage':
        this.chat(connection, action.message, action.requestId);
        break;
      case 'pong':
        connection.lastPong = Date.now();
        this.send(connection, 'pong', { serverTime: Date.now() }, action.requestId);
        break;
    }
  }

  private authenticate(connection: Connection, password: string, requestId: string): void {
    if (!this.config.password || password === this.config.password) {
      connection.authenticated = true;
      this.send(connection, 'authenticated', { ok: true }, requestId);
      return;
    }
    throw new RuleError('AUTHENTICATION_FAILED', 'Incorrect server password.');
  }

  private join(connection: Connection, nameValue: string, reconnectToken: string | undefined, requestId: string): void {
    if (!connection.authenticated) throw new RuleError('AUTHENTICATION_REQUIRED', 'Authenticate before joining.');
    if (connection.playerId) throw new RuleError('ALREADY_JOINED', 'This connection already joined the room.');
    const name = nameValue.trim().slice(0, 24);
    if (!name) throw new RuleError('NAME_REQUIRED', 'Player name is required.');
    if (reconnectToken) {
      const player = [...this.players.values()].find((candidate) => candidate.reconnectToken === reconnectToken);
      if (player) {
        if (player.connection) throw new RuleError('PLAYER_ALREADY_CONNECTED', 'That player is already connected.');
        player.connection = connection;
        connection.playerId = player.playerId;
        if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
        player.reconnectTimer = null;
        this.send(connection, 'reconnected', { playerId: player.playerId, name: player.name }, requestId);
        this.sendRoomState();
        this.sendPrivateState(connection);
        return;
      }
    }
    if (this.players.size >= 2 || this.mode === 'practice') throw new RuleError('ROOM_FULL', 'The room already has two players.');
    if ([...this.players.values()].some((player) => player.name === name)) throw new RuleError('NAME_IN_USE', 'That name is already in use.');
    const playerId = `player-${this.players.size + 1}`;
    const player: PlayerRecord = {
      playerId,
      name,
      reconnectToken: randomUUID(),
      connection,
      selectedDeck: null,
      ready: false,
      rematch: false,
      reconnectTimer: null
    };
    this.players.set(playerId, player);
    connection.playerId = playerId;
    this.send(connection, 'joined', { playerId, name, reconnectToken: player.reconnectToken }, requestId);
    this.send(connection, 'cardDataVersion', { version: this.catalog.catalogVersion, schemaVersion: 2, cards: this.catalog.cards.length, packVersions: this.catalog.packVersions });
    this.send(connection, 'assetDataVersion', { version: this.catalog.assetVersion });
    this.sendRoomState();
  }

  private submittedDeck(action: DeckSubmissionEnvelope): SubmittedDeck {
    const result = validateSubmittedDeck(action, this.catalog);
    this.assertResult(result);
    return sanitizeSubmittedDeck(action, this.catalog);
  }

  private selectDeck(connection: Connection, action: Extract<ClientAction, { action: 'selectDeck' }>, requestId: string): void {
    const player = this.requirePlayer(connection);
    player.selectedDeck = this.submittedDeck(action);
    player.ready = false;
    this.send(connection, 'deckSelected', { deckId: player.selectedDeck.deckId, name: player.selectedDeck.name, cards: player.selectedDeck.cardIds.length, catalogVersion: player.selectedDeck.catalogVersion }, requestId);
    this.sendRoomState();
  }

  private ready(connection: Connection, requestId: string): void {
    const player = this.requirePlayer(connection);
    if (!player.selectedDeck) throw new RuleError('DECK_REQUIRED', 'Select a valid deck before readying.');
    if (this.game && this.game.phase !== 'ended') throw new RuleError('GAME_ACTIVE', 'A game is already active.');
    player.ready = true;
    this.send(connection, 'readyAccepted', { ready: true }, requestId);
    this.sendRoomState();
    if (this.players.size === 2 && [...this.players.values()].every((candidate) => candidate.ready && candidate.selectedDeck)) {
      this.startOnlineGame();
    }
  }

  private startOnlineGame(): void {
    const players = [...this.players.values()];
    const seed = this.nextSeed();
    this.mode = 'online';
    this.aiPlayerId = null;
    this.game = createGame({
      gameId: `online-${seed}`,
      seed,
      cards: this.catalog.cards,
      fronts: FRONT_DEFINITIONS,
      catalogVersion: this.catalog.catalogVersion,
      packVersions: this.catalog.packVersions,
      players: players.map((player) => ({ playerId: player.playerId, name: player.name, deck: [...player.selectedDeck!.cardIds], deckId: player.selectedDeck!.deckId, deckName: player.selectedDeck!.name }))
    });
    for (const player of players) {
      player.ready = false;
      player.rematch = false;
    }
    this.broadcast('gameStarted', { gameId: this.game.gameId, mode: this.mode });
    this.scheduleTurn();
    this.broadcastGameState();
  }

  private startPractice(connection: Connection, action: Extract<ClientAction, { action: 'practice' }>, requestId: string): void {
    const human = this.requirePlayer(connection);
    const deck = this.submittedDeck(action);
    if (this.players.size > 1) throw new RuleError('ROOM_NOT_EMPTY', 'Practice mode requires an empty second seat.');
    const aiDeck = this.catalog.presets[1]?.cardIds ?? this.catalog.presets[0]?.cardIds;
    if (!aiDeck) throw new RuleError('PRESET_MISSING', 'No practice deck is available.');
    const seed = this.nextSeed();
    this.mode = 'practice';
    this.aiPlayerId = 'practice-ai';
    human.selectedDeck = deck;
    this.game = createGame({
      gameId: `practice-${seed}`,
      seed,
      cards: this.catalog.cards,
      fronts: FRONT_DEFINITIONS,
      catalogVersion: this.catalog.catalogVersion,
      packVersions: this.catalog.packVersions,
      players: [
        { playerId: human.playerId, name: human.name, deck: [...deck.cardIds], deckId: deck.deckId, deckName: deck.name },
        { playerId: this.aiPlayerId, name: '演武官', deck: [...aiDeck], deckId: this.catalog.presets[1]?.deckId ?? 'practice-ai', deckName: this.catalog.presets[1]?.nameZh ?? '演武牌组' }
      ]
    });
    this.send(connection, 'practiceStarted', { gameId: this.game.gameId }, requestId);
    this.scheduleTurn();
    this.runPracticeAi();
    this.broadcastGameState();
  }

  private requestRematch(connection: Connection, requestId: string): void {
    const player = this.requirePlayer(connection);
    if (!this.game || this.game.phase !== 'ended') throw new RuleError('GAME_NOT_ENDED', 'Rematch is available after the game ends.');
    player.rematch = true;
    this.send(connection, 'rematchRequested', { playerId: player.playerId }, requestId);
    if (this.mode === 'practice' && player.selectedDeck) {
      this.startPractice(connection, { action: 'practice', protocolVersion: PROTOCOL_VERSION, requestId: `${requestId}:start`, cardIds: player.selectedDeck.cardIds, catalogVersion: player.selectedDeck.catalogVersion, deck: player.selectedDeck }, `${requestId}:start`);
    } else if (this.mode === 'online' && [...this.players.values()].every((candidate) => candidate.rematch)) {
      this.startOnlineGame();
    } else {
      this.sendRoomState();
    }
  }

  private chat(connection: Connection, messageValue: string, requestId: string): void {
    const player = this.requirePlayer(connection);
    const message = messageValue.trim().slice(0, 500);
    if (!message) throw new RuleError('EMPTY_MESSAGE', 'Chat message cannot be empty.');
    this.broadcast('chatMessage', { playerId: player.playerId, name: player.name, message }, requestId);
  }

  private afterGameAction(): void {
    this.runPracticeAi();
    if (this.game?.phase === 'ended') {
      if (this.turnTimer) clearTimeout(this.turnTimer);
      this.turnTimer = null;
      this.deadline = null;
      this.broadcast('gameEnded', { winner: this.game.winner });
    } else {
      this.scheduleTurn();
    }
    this.broadcastGameState();
  }

  private runPracticeAi(): void {
    if (this.mode !== 'practice' || !this.game || !this.aiPlayerId || this.game.phase !== 'planning') return;
    const ai = this.game.players.find((player) => player.playerId === this.aiPlayerId);
    if (!ai || ai.locked) return;
    const view = createPlayerView(this.game, this.aiPlayerId);
    const riskSeed = this.game.seed + this.game.turn * 101;
    const risk = choosePracticeRisk(view, this.aiPlayerId, riskSeed);
    if (risk === 'withdraw') {
      withdraw(this.game, this.aiPlayerId, `ai-withdraw-${this.game.turn}`);
      return;
    }
    if (risk === 'raise') raiseBanner(this.game, this.aiPlayerId, `ai-banner-${this.game.turn}`);
    const intent = choosePracticeIntent(view, this.aiPlayerId, this.cardCatalog, riskSeed + 1);
    const submitted = submitTurnIntent(this.game, this.aiPlayerId, intent);
    if (!submitted.ok) throw new RuleError('AI_INVALID_PLAN', 'Practice AI produced an invalid plan.', { issues: submitted.issues });
    const locked = lockTurn(this.game, this.aiPlayerId, `ai-lock-${this.game.turn}`);
    if (!locked.ok) throw new RuleError('AI_LOCK_FAILED', 'Practice AI could not lock.', { issues: locked.issues });
  }

  private scheduleTurn(): void {
    if (!this.game || this.game.phase !== 'planning') return;
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.deadline = Date.now() + this.config.turnDurationMs;
    const gameId = this.game.gameId;
    const turn = this.game.turn;
    this.turnTimer = setTimeout(() => {
      if (!this.game || this.game.gameId !== gameId || this.game.turn !== turn || this.game.phase !== 'planning') return;
      for (const player of [...this.game.players]) {
        if (!player.locked) lockTurn(this.game, player.playerId, `timeout-${gameId}-${turn}-${player.playerId}`);
      }
      this.afterGameAction();
    }, this.config.turnDurationMs);
    this.turnTimer.unref();
  }

  private sendPrivateState(connection: Connection, requestId?: string): void {
    if (!this.game || !connection.playerId || !this.game.players.some((player) => player.playerId === connection.playerId)) return;
    const view = createPlayerView(this.game, connection.playerId);
    this.send(connection, 'privateGameState', { ...view, deadline: this.deadline }, requestId);
  }

  private broadcastGameState(): void {
    if (!this.game) return;
    for (const player of this.players.values()) if (player.connection) this.sendPrivateState(player.connection);
    const spectators = [...this.connections].filter((connection) => !connection.playerId);
    const publicView: PlayerView & { deadline: number | null } = { ...createPublicView(this.game), deadline: this.deadline };
    for (const spectator of spectators) this.send(spectator, 'publicGameState', publicView);
  }

  private sendRoomState(): void {
    const payload = {
      roomId: 'main',
      mode: this.mode,
      players: [...this.players.values()].map((player) => ({
        playerId: player.playerId,
        name: player.name,
        connected: Boolean(player.connection),
        ready: player.ready,
        deckSelected: Boolean(player.selectedDeck),
        deckId: player.selectedDeck?.deckId ?? null,
        deckName: player.selectedDeck?.name ?? null,
        rematch: player.rematch
      }))
    };
    this.broadcast('roomState', payload);
  }

  private statusPayload(): Record<string, unknown> {
    return { title: this.config.title, owner: this.config.owner, requirePassword: Boolean(this.config.password), tls: this.config.tls, ...this.health() };
  }

  private send(connection: Connection, event: string, payload: unknown, requestId?: string): void {
    if (connection.ws.readyState !== WebSocket.OPEN) return;
    this.transportSequence += 1;
    const message: OutboundMessage = { event, protocolVersion: PROTOCOL_VERSION, sequence: this.transportSequence, payload };
    if (requestId !== undefined) message.requestId = requestId;
    connection.ws.send(JSON.stringify(message));
    if (this.config.debug) Logger.debug(`Sent ${event} to ${connection.remoteName}.`);
  }

  private broadcast(event: string, payload: unknown, requestId?: string): void {
    for (const connection of this.connections) this.send(connection, event, payload, requestId);
  }

  private requirePlayer(connection: Connection): PlayerRecord {
    if (!connection.playerId) throw new RuleError('JOIN_REQUIRED', 'Join the room first.');
    const player = this.players.get(connection.playerId);
    if (!player) throw new RuleError('PLAYER_NOT_FOUND', 'Joined player record no longer exists.');
    return player;
  }

  private requireGamePlayer(connection: Connection): void {
    this.requirePlayer(connection);
    if (!this.game || this.game.phase === 'ended') throw new RuleError('GAME_NOT_ACTIVE', 'No active game exists.');
    if (!this.game.players.some((player) => player.playerId === connection.playerId)) throw new RuleError('NOT_IN_GAME', 'Player is not part of the active game.');
  }

  private assertResult(result: ValidationResult): void {
    if (!result.ok) throw new RuleError(result.issues[0]?.code ?? 'RULE_REJECTED', result.issues[0]?.message ?? 'Action rejected.', { issues: result.issues });
  }

  private ruleRequestId(connection: Connection, requestId: string): string {
    return `${connection.playerId ?? connection.id}:${requestId}`;
  }

  private disconnect(connection: Connection): void {
    this.connections.delete(connection);
    if (!connection.playerId) return;
    const player = this.players.get(connection.playerId);
    if (!player || player.connection !== connection) return;
    player.connection = null;
    this.sendRoomState();
    player.reconnectTimer = setTimeout(() => {
      if (player.connection) return;
      if (this.game?.phase !== 'ended' && this.game?.players.some((candidate) => candidate.playerId === player.playerId)) {
        withdraw(this.game, player.playerId, `disconnect-${this.game.gameId}-${player.playerId}`);
        this.broadcastGameState();
      }
      this.players.delete(player.playerId);
      this.sendRoomState();
    }, this.config.reconnectWindowMs);
    player.reconnectTimer.unref();
  }

  private runHeartbeat(): void {
    const now = Date.now();
    for (const connection of this.connections) {
      if (now - connection.lastPong > 10_000) {
        connection.ws.close(4001, 'Heartbeat timeout.');
      } else if (connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.ping();
      }
    }
  }

  private nextSeed(): number {
    const seed = (Date.now() ^ this.seedCounter) >>> 0;
    this.seedCounter += 1;
    return seed;
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
