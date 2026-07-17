import { afterEach, describe, expect, it } from 'vitest';
import { ServerHarness, TestClient } from './helpers/server-harness.js';

describe('protocol scope and request safety', () => {
  let harness: ServerHarness;
  afterEach(async () => harness?.close());

  it('preserves request idempotency after reconnect token rotation', async () => {
    harness = new ServerHarness({ reconnectWindowMs: 5_000 });
    await harness.start();
    const original = await harness.connect('幂等玩家');
    const requestId = 'stable-create-request';
    original.client.send({
      action: 'createRoom',
      requestId,
      room: { name: '唯一房间', visibility: 'public', allowSpectators: false, turnDurationMs: 45_000, packIds: ['core'], tags: [], revealDecks: false }
    });
    await original.client.waitFor('roomCreated', (message) => message.requestId === requestId);
    await original.client.close();
    const replacement = await TestClient.connect(harness.url);
    harness.clients.push(replacement);
    const reconnectRequest = replacement.send({ action: 'join', name: '幂等玩家', reconnectToken: original.reconnectToken });
    await replacement.waitFor('reconnected', (message) => message.requestId === reconnectRequest);
    replacement.send({
      action: 'createRoom',
      requestId,
      room: { name: '重复房间', visibility: 'public', allowSpectators: false, turnDurationMs: 45_000, packIds: ['core'], tags: [], revealDecks: false }
    });
    const duplicate = await replacement.waitFor('requestAccepted', (message) => message.requestId === requestId);
    expect(duplicate.payload.duplicate).toBe(true);
    const health = await fetch(`${harness.httpUrl}/health`).then((response) => response.json()) as any;
    expect(health.rooms).toBe(1);
  });

  it('rejects invalid room and game scopes without affecting valid sessions', async () => {
    harness = new ServerHarness();
    await harness.start();
    const first = await harness.connect('作用域甲');
    const second = await harness.connect('作用域乙');
    const roomErrorRequest = first.client.send({ action: 'joinRoom', roomId: 'room-does-not-exist' });
    const roomError = await first.client.waitFor('error', (message) => message.requestId === roomErrorRequest);
    expect(roomError.payload.code).toBe('ROOM_NOT_FOUND');
    const roomId = await harness.createRoom(first.client, '作用域房');
    await harness.joinRoom(second.client, roomId);
    const [state] = await harness.readyPair(first.client, second.client, roomId);
    const gameErrorRequest = first.client.send({ action: 'lockTurn', gameId: 'game-does-not-exist', turn: 1 });
    const gameError = await first.client.waitFor('error', (message) => message.requestId === gameErrorRequest);
    expect(gameError.payload.code).toBe('GAME_NOT_FOUND');
    expect(state.payload.phase).toBe('planning');
  });
});
