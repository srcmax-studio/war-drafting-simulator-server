import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../src/common/src/index.js';
import { ServerHarness, TestClient } from './helpers/server-harness.js';

describe('local multiplayer load baseline', () => {
  let harness: ServerHarness;
  afterEach(async () => harness?.close());

  it('sustains 100 connections, 25 rooms, 20 games and 50 lobby users without cross-room leakage', async () => {
    globalThis.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    harness = new ServerHarness({ maxConnections: 120, maxRooms: 30, maxActiveGames: 25, turnDurationMs: 30_000, reconnectWindowMs: 5_000 });
    await harness.start();
    const users = await Promise.all(Array.from({ length: 100 }, (_, index) => harness.connect(`负载${String(index).padStart(3, '0')}`)));
    const roomUsers = users.slice(0, 50);
    const pairs = Array.from({ length: 25 }, (_, index) => [roomUsers[index * 2]!, roomUsers[index * 2 + 1]!] as const);
    const rooms = await Promise.all(pairs.map(async ([host, guest], index) => {
      const roomId = await harness.createRoom(host.client, `负载房${String(index).padStart(2, '0')}`);
      await harness.joinRoom(guest.client, roomId);
      return roomId;
    }));
    const activePairs = pairs.slice(0, 20);
    const initialStates = await Promise.all(activePairs.map(([first, second], index) => harness.readyPair(first.client, second.client, rooms[index]!, index, index + 1)));
    const health = await fetch(`${harness.httpUrl}/health`).then((response) => response.json()) as any;
    expect(health).toEqual(expect.objectContaining({ connectedUsers: 100, lobbyUsers: 50, rooms: 25, activeGames: 20 }));
    pairs[20]![0].client.send({ action: 'sendRoomChat', roomId: rooms[20], message: '隔离负载消息' });
    await pairs[20]![1].client.waitFor('roomChatMessage');
    await pairs[21]![0].client.expectNoEvent('roomChatMessage');

    const reconnecting = activePairs[0]![0];
    const reconnectToken = reconnecting.reconnectToken!;
    const expectedGameId = initialStates[0]![0].gameId;
    await reconnecting.client.close();
    const replacement = await TestClient.connect(harness.url);
    harness.clients.push(replacement);
    const requestId = replacement.send({ action: 'join', name: '负载000', reconnectToken, protocolVersion: PROTOCOL_VERSION });
    const reconnected = await replacement.waitFor('reconnected', (message) => message.requestId === requestId);
    const restored = await replacement.waitFor('privateGameState');
    expect(reconnected.payload.playerId).toBe(reconnecting.playerId);
    expect(restored.gameId).toBe(expectedGameId);

    for (const user of users) user.client.drain();
    replacement.drain();
    if (globalThis.gc) {
      globalThis.gc();
      const heapAfter = process.memoryUsage().heapUsed;
      expect(heapAfter - heapBefore).toBeLessThan(192 * 1024 * 1024);
    }
  }, 30_000);
});
