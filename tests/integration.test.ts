import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, verifyReplay } from '../src/common/src/index.js';
import { loadCatalog, type Catalog } from '../src/catalog.js';
import { DEFAULT_CONFIG, type ServerConfig } from '../src/config.js';
import { AeonfrontServer } from '../src/server.js';

interface Message {
  event: string;
  requestId?: string;
  sequence: number;
  payload: any;
}

class TestClient {
  private readonly messages: Message[] = [];
  private readonly waiters: Array<{
    event: string;
    predicate: (message: Message) => boolean;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private counter = 0;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as Message;
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.event === message.event && waiter.predicate(message));
      if (waiterIndex >= 0) {
        const waiter = this.waiters.splice(waiterIndex, 1)[0]!;
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
    return client;
  }

  send(action: Record<string, unknown>): string {
    const requestId = typeof action.requestId === 'string' ? action.requestId : `request-${++this.counter}`;
    this.ws.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, requestId, ...action }));
    return requestId;
  }

  async waitFor(event: string, predicate: (message: Message) => boolean = () => true, timeoutMs = 3_000): Promise<Message> {
    const existingIndex = this.messages.findIndex((message) => message.event === event && predicate(message));
    if (existingIndex >= 0) return this.messages.splice(existingIndex, 1)[0]!;
    return new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${event}.`));
      }, timeoutMs);
      this.waiters.push({ event, predicate, resolve, reject, timer });
    });
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close();
    await once(this.ws, 'close');
  }
}

const catalog: Catalog = loadCatalog();
const servers: AeonfrontServer[] = [];
const clients: TestClient[] = [];

const startServer = async (overrides: Partial<ServerConfig> = {}): Promise<{ server: AeonfrontServer; url: string }> => {
  const config: ServerConfig = {
    ...DEFAULT_CONFIG,
    ...overrides,
    port: 0,
    generation: { ...DEFAULT_CONFIG.generation, ...(overrides.generation ?? {}) }
  };
  const server = new AeonfrontServer(config, catalog);
  const address = await server.listen();
  servers.push(server);
  return { server, url: `ws://127.0.0.1:${address.port}` };
};

const connect = async (url: string): Promise<TestClient> => {
  const client = await TestClient.connect(url);
  clients.push(client);
  await client.waitFor('serverStatus');
  return client;
};

const join = async (client: TestClient, name: string, reconnectToken?: string): Promise<Message> => {
  const requestId = client.send({ action: 'join', name, ...(reconnectToken ? { reconnectToken } : {}) });
  return client.waitFor(reconnectToken ? 'reconnected' : 'joined', (message) => message.requestId === requestId);
};

const makePlan = (view: any, playerId: string): any => {
  const player = view.players.find((candidate: any) => candidate.playerId === playerId);
  const catalogById = new Map(catalog.cards.map((card) => [card.cardId, card]));
  for (const cardId of player.hand ?? []) {
    const card = catalogById.get(cardId)!;
    for (const front of view.fronts) {
      const effect = front.definition.effectId;
      if (effect === 'ban_high_cost' && card.cost >= 4) continue;
      if (effect === 'ban_low_cost' && card.cost <= 2) continue;
      const cost = effect === 'cost_down' ? Math.max(1, card.cost - 1) : effect === 'cost_up' ? card.cost + 1 : card.cost;
      const capacity = effect === 'capacity_up' ? 5 : effect === 'capacity_down' ? 3 : 4;
      if (cost <= player.energy && (front.cards[playerId]?.length ?? 0) < capacity) {
        return { requestId: 'client-plan', turn: view.turn, deployments: [{ cardId, frontId: front.definition.frontId, order: 0 }] };
      }
    }
  }
  return { requestId: 'client-plan', turn: view.turn, deployments: [] };
};

afterEach(async () => {
  while (clients.length > 0) await clients.pop()!.close().catch(() => undefined);
  while (servers.length > 0) await servers.pop()!.close();
});

describe('authoritative WebSocket integration', () => {
  it('runs two clients through a complete six-turn game without leaking hands', async () => {
    const { server, url } = await startServer();
    const first = await connect(url);
    const second = await connect(url);
    await join(first, '甲');
    await join(second, '乙');
    first.send({ action: 'selectDeck', cardIds: catalog.presets[0]!.cardIds });
    second.send({ action: 'selectDeck', cardIds: catalog.presets[1]!.cardIds });
    first.send({ action: 'ready' });
    second.send({ action: 'ready' });
    let firstState = (await first.waitFor('privateGameState', (message) => message.payload.turn === 1)).payload;
    let secondState = (await second.waitFor('privateGameState', (message) => message.payload.turn === 1)).payload;
    expect(firstState.players.find((player: any) => player.playerId === 'player-1').hand).toHaveLength(4);
    expect(firstState.players.find((player: any) => player.playerId === 'player-2').hand).toBeUndefined();
    for (let turn = 1; turn <= 6; turn += 1) {
      first.send({ action: 'submitTurn', intent: makePlan(firstState, 'player-1') });
      second.send({ action: 'submitTurn', intent: makePlan(secondState, 'player-2') });
      first.send({ action: 'lockTurn', turn });
      second.send({ action: 'lockTurn', turn });
      firstState = (await first.waitFor('privateGameState', (message) => message.payload.phase === 'ended' || message.payload.turn > turn)).payload;
      secondState = (await second.waitFor('privateGameState', (message) => message.payload.phase === 'ended' || message.payload.turn > turn)).payload;
    }
    expect(firstState.phase).toBe('ended');
    expect(firstState.turn).toBe(6);
    expect(firstState.winner).toBeTruthy();
    expect(server.getGameForTesting()?.players.flatMap((player) => Object.values(player.fronts).flat()).length).toBeGreaterThan(0);
    expect(server.getGameForTesting()?.eventLog.some((event) => event.type === 'reveal_order')).toBe(true);
  });

  it('restores the same private game after reconnect', async () => {
    const { url } = await startServer({ reconnectWindowMs: 5_000 });
    const first = await connect(url);
    const second = await connect(url);
    const joined = await join(first, '甲');
    const token = joined.payload.reconnectToken as string;
    await join(second, '乙');
    first.send({ action: 'selectDeck', cardIds: catalog.presets[0]!.cardIds });
    second.send({ action: 'selectDeck', cardIds: catalog.presets[1]!.cardIds });
    first.send({ action: 'ready' });
    second.send({ action: 'ready' });
    const before = await first.waitFor('privateGameState', (message) => message.payload.turn === 1);
    await first.close();
    await second.waitFor('roomState', (message) => message.payload.players.some((player: any) => player.playerId === 'player-1' && !player.connected));
    const reconnected = await connect(url);
    await join(reconnected, '甲', token);
    const restored = await reconnected.waitFor('privateGameState');
    expect(restored.payload.gameId).toBe(before.payload.gameId);
    expect(restored.payload.turn).toBe(before.payload.turn);
    expect(restored.payload.players.find((player: any) => player.playerId === 'player-1').hand).toEqual(before.payload.players.find((player: any) => player.playerId === 'player-1').hand);
  });

  it('practice AI completes a legal match and the event log replays identically', async () => {
    const { server, url } = await startServer();
    const human = await connect(url);
    await join(human, '演武者');
    human.send({ action: 'practice', cardIds: catalog.presets[0]!.cardIds });
    let view = (await human.waitFor('privateGameState')).payload;
    while (view.phase !== 'ended') {
      const turn = view.turn as number;
      human.send({ action: 'lockTurn', turn });
      view = (await human.waitFor('privateGameState', (message) => message.payload.phase === 'ended' || message.payload.turn > turn)).payload;
    }
    const game = server.getGameForTesting();
    expect(game?.winner).toBeTruthy();
    expect(game?.turn).toBeLessThanOrEqual(6);
    expect(game && verifyReplay(game)).toBe(true);
  });

  it('rejects protocol mismatches with a structured error', async () => {
    const { url } = await startServer();
    const client = await connect(url);
    client.ws.send(JSON.stringify({ action: 'status', protocolVersion: 'wrong/0', requestId: 'bad-version' }));
    const error = await client.waitFor('error', (message) => message.requestId === 'bad-version');
    expect(error.payload.code).toBe('PROTOCOL_MISMATCH');
  });

  it('authoritatively locks both players when the turn deadline expires', async () => {
    const { url } = await startServer({ turnDurationMs: 1_000 });
    const first = await connect(url);
    const second = await connect(url);
    await join(first, '甲');
    await join(second, '乙');
    first.send({ action: 'selectDeck', cardIds: catalog.presets[0]!.cardIds });
    second.send({ action: 'selectDeck', cardIds: catalog.presets[1]!.cardIds });
    first.send({ action: 'ready' });
    second.send({ action: 'ready' });
    await first.waitFor('privateGameState', (message) => message.payload.turn === 1);
    const next = await first.waitFor('privateGameState', (message) => message.payload.turn === 2, 2_500);
    expect(next.payload.eventLog).toBeUndefined();
    expect(next.payload.events.some((event: any) => event.type === 'turn_resolved')).toBe(true);
  });

  it('settles withdrawal at the active stake after an opponent raises a banner', async () => {
    const { server, url } = await startServer();
    const first = await connect(url);
    const second = await connect(url);
    await join(first, '甲');
    await join(second, '乙');
    first.send({ action: 'selectDeck', cardIds: catalog.presets[0]!.cardIds });
    second.send({ action: 'selectDeck', cardIds: catalog.presets[1]!.cardIds });
    first.send({ action: 'ready' });
    second.send({ action: 'ready' });
    await first.waitFor('privateGameState', (message) => message.payload.turn === 1);
    first.send({ action: 'raiseBanner', turn: 1 });
    await second.waitFor('bannerRaised');
    second.send({ action: 'withdraw', turn: 1 });
    const ended = await first.waitFor('gameEnded');
    expect(ended.payload.winner.winnerId).toBe('player-1');
    expect(ended.payload.winner.stake).toBe(1);
    expect(server.getGameForTesting()?.stake.pending).toBe(2);
  });
});
