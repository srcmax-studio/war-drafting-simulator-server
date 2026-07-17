import { once } from 'node:events';
import WebSocket from 'ws';
import { DECK_SCHEMA_VERSION, PROTOCOL_VERSION } from '../../src/common/src/index.js';
import { loadCatalog } from '../../src/catalog.js';
import { DEFAULT_CONFIG, type ServerConfig } from '../../src/config.js';
import { AeonfrontServer } from '../../src/server.js';

export interface TestMessage {
  event: string;
  requestId?: string;
  roomId?: string;
  gameId?: string;
  sequence: number;
  payload: any;
}

export class TestClient {
  private readonly messages: TestMessage[] = [];
  private readonly waiters: Array<{
    event: string;
    predicate: (message: TestMessage) => boolean;
    resolve: (message: TestMessage) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private counter = 0;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as TestMessage;
      const index = this.waiters.findIndex((waiter) => waiter.event === message.event && waiter.predicate(message));
      if (index >= 0) {
        const waiter = this.waiters.splice(index, 1)[0]!;
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
  }

  static async connect(url: string): Promise<TestClient> {
    const ws = new WebSocket(url);
    const client = new TestClient(ws);
    await once(ws, 'open');
    await client.waitFor('serverStatus');
    return client;
  }

  send(action: Record<string, unknown>): string {
    const requestId = typeof action.requestId === 'string' ? action.requestId : `request-${++this.counter}`;
    this.ws.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, requestId, ...action }));
    return requestId;
  }

  drain(): void {
    this.messages.length = 0;
  }

  async waitFor(event: string, predicate: (message: TestMessage) => boolean = () => true, timeoutMs = 5_000): Promise<TestMessage> {
    const existing = this.messages.findIndex((message) => message.event === event && predicate(message));
    if (existing >= 0) return this.messages.splice(existing, 1)[0]!;
    return new Promise<TestMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${event}.`));
      }, timeoutMs);
      this.waiters.push({ event, predicate, resolve, timer });
    });
  }

  async expectNoEvent(event: string, timeoutMs = 150): Promise<void> {
    const existing = this.messages.find((message) => message.event === event);
    if (existing) throw new Error(`Unexpected ${event}.`);
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        event,
        predicate: () => true,
        resolve: () => { clearTimeout(timer); reject(new Error(`Unexpected ${event}.`)); },
        timer: null as unknown as NodeJS.Timeout
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve();
      }, timeoutMs);
      waiter.timer = timer;
      this.waiters.push(waiter);
    });
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close();
    await once(this.ws, 'close');
  }
}

export const catalog = loadCatalog();

export const deckPayload = (index: number) => {
  const preset = catalog.presets[index % catalog.presets.length]!;
  return {
    cardIds: [...preset.cardIds],
    catalogVersion: catalog.catalogVersion,
    deck: {
      schemaVersion: DECK_SCHEMA_VERSION,
      deckId: preset.deckId,
      name: preset.nameZh,
      cardIds: [...preset.cardIds],
      catalogVersion: catalog.catalogVersion,
      packVersions: { ...catalog.packVersions }
    }
  };
};

export class ServerHarness {
  readonly clients: TestClient[] = [];
  readonly server: AeonfrontServer;
  url = '';
  httpUrl = '';

  constructor(overrides: Partial<ServerConfig> = {}) {
    this.server = new AeonfrontServer({
      ...DEFAULT_CONFIG,
      ...overrides,
      port: 0,
      generation: { ...DEFAULT_CONFIG.generation, ...(overrides.generation ?? {}) }
    }, catalog);
  }

  async start(): Promise<void> {
    const address = await this.server.listen();
    this.url = `ws://127.0.0.1:${address.port}`;
    this.httpUrl = `http://127.0.0.1:${address.port}`;
  }

  async connect(name?: string): Promise<{ client: TestClient; playerId?: string; reconnectToken?: string }> {
    const client = await TestClient.connect(this.url);
    this.clients.push(client);
    if (!name) return { client };
    const requestId = client.send({ action: 'join', name });
    const joined = await client.waitFor('joined', (message) => message.requestId === requestId);
    const lobbyRequest = client.send({ action: 'enterLobby' });
    await client.waitFor('lobbyEntered', (message) => message.requestId === lobbyRequest);
    return { client, playerId: joined.payload.playerId as string, reconnectToken: joined.payload.reconnectToken as string };
  }

  async createRoom(host: TestClient, name: string, turnDurationMs = 45_000, password = ''): Promise<string> {
    const requestId = host.send({
      action: 'createRoom',
      room: { name, visibility: password ? 'private' : 'public', ...(password ? { password } : {}), allowSpectators: false, turnDurationMs, packIds: ['core'], tags: ['标准'], revealDecks: false }
    });
    const created = await host.waitFor('roomCreated', (message) => message.requestId === requestId);
    return created.payload.roomId as string;
  }

  async joinRoom(client: TestClient, roomId: string, password = ''): Promise<void> {
    const requestId = client.send({ action: 'joinRoom', roomId, ...(password ? { password } : {}) });
    await client.waitFor('roomJoined', (message) => message.requestId === requestId);
  }

  async readyPair(first: TestClient, second: TestClient, roomId: string, firstDeck = 0, secondDeck = 1): Promise<[TestMessage, TestMessage]> {
    first.send({ action: 'selectDeck', roomId, ...deckPayload(firstDeck) });
    second.send({ action: 'selectDeck', roomId, ...deckPayload(secondDeck) });
    first.send({ action: 'setReady', roomId, ready: true });
    second.send({ action: 'setReady', roomId, ready: true });
    return Promise.all([
      first.waitFor('privateGameState', (message) => message.payload.turn === 1),
      second.waitFor('privateGameState', (message) => message.payload.turn === 1)
    ]);
  }

  async close(): Promise<void> {
    while (this.clients.length > 0) await this.clients.pop()!.close().catch(() => undefined);
    await this.server.close();
  }
}
