import { afterEach, describe, expect, it } from 'vitest';
import { ServerHarness } from './helpers/server-harness.js';

describe('concurrent game isolation', () => {
  let harness: ServerHarness;
  afterEach(async () => harness?.close());

  it('runs twenty independent 1v1 games with separate ids, turns and private views', async () => {
    harness = new ServerHarness({ maxConnections: 120, maxRooms: 40, maxActiveGames: 25, turnDurationMs: 30_000 });
    await harness.start();
    const players = await Promise.all(Array.from({ length: 40 }, (_, index) => harness.connect(`并发${String(index).padStart(2, '0')}`)));
    const pairs = Array.from({ length: 20 }, (_, index) => [players[index * 2]!, players[index * 2 + 1]!] as const);
    const rooms = await Promise.all(pairs.map(async ([host, guest], index) => {
      const roomId = await harness.createRoom(host.client, `并发房${index}`);
      await harness.joinRoom(guest.client, roomId);
      return roomId;
    }));
    const initialStates = await Promise.all(pairs.map(([first, second], index) => harness.readyPair(first.client, second.client, rooms[index]!, index, index + 1)));
    const gameIds = initialStates.map(([first]) => first.gameId as string);
    expect(new Set(gameIds).size).toBe(20);
    for (let index = 0; index < initialStates.length; index += 1) {
      const [firstState, secondState] = initialStates[index]!;
      const expectedIds = new Set([pairs[index]![0].playerId, pairs[index]![1].playerId]);
      expect(new Set(firstState.payload.players.map((player: any) => player.playerId))).toEqual(expectedIds);
      expect(new Set(secondState.payload.players.map((player: any) => player.playerId))).toEqual(expectedIds);
    }
    const nextStates = await Promise.all(pairs.map(async ([first, second], index) => {
      const gameId = gameIds[index]!;
      first.client.send({ action: 'lockTurn', gameId, turn: 1 });
      second.client.send({ action: 'lockTurn', gameId, turn: 1 });
      return first.client.waitFor('privateGameState', (message) => message.gameId === gameId && message.payload.turn === 2);
    }));
    expect(nextStates.every((message) => message.payload.turn === 2)).toBe(true);
    const health = await fetch(`${harness.httpUrl}/health`).then((response) => response.json()) as any;
    expect(health.activeGames).toBe(20);
    expect(health.rooms).toBe(20);
  }, 20_000);
});
