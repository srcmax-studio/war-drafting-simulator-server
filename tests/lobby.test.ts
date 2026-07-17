import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServerHarness } from './helpers/server-harness.js';

describe('online lobby', () => {
  let harness: ServerHarness;

  beforeEach(async () => {
    harness = new ServerHarness();
    await harness.start();
  });

  afterEach(async () => harness.close());

  it('publishes bounded public presence without credentials or network identifiers', async () => {
    const first = await harness.connect('大厅甲');
    await harness.connect('大厅乙');
    const requestId = first.client.send({ action: 'requestLobbySnapshot' });
    const snapshot = await first.client.waitFor('lobbySnapshot', (message) => message.requestId === requestId);
    expect(snapshot.payload.server.connectedUsers).toBe(2);
    expect(snapshot.payload.server.lobbyUsers).toBe(2);
    expect(snapshot.payload.presence.map((entry: any) => entry.name)).toEqual(['大厅甲', '大厅乙']);
    const serialized = JSON.stringify(snapshot.payload);
    expect(serialized).not.toContain('reconnectToken');
    expect(serialized).not.toContain('remoteName');
    expect(serialized).not.toContain('password');
  });

  it('broadcasts only public room summaries to players who remain in the lobby', async () => {
    const host = await harness.connect('开房者');
    const observer = await harness.connect('大厅观察者');
    const roomId = await harness.createRoom(host.client, '公开演武房');
    const snapshot = await observer.client.waitFor(
      'roomListSnapshot',
      (message) => message.payload.some((room: any) => room.roomId === roomId)
    );
    expect(snapshot.payload).toEqual([
      expect.objectContaining({ roomId, name: '公开演武房', hostName: '开房者', players: 1 })
    ]);
    const serialized = JSON.stringify(snapshot.payload);
    expect(serialized).not.toContain('members');
    expect(serialized).not.toContain('cardIds');
    expect(serialized).not.toContain('passwordHash');
    await observer.client.expectNoEvent('roomCreated');
  });

  it('broadcasts filtered lobby chat and rate limits rapid repeats', async () => {
    const first = await harness.connect('发言者');
    const second = await harness.connect('接收者');
    const requestId = first.client.send({ action: 'sendLobbyChat', message: '<军令>  已到\u0000' });
    const received = await second.client.waitFor('lobbyChatMessage');
    expect(received.payload.content).toBe('军令 已到');
    expect(received.payload.senderName).toBe('发言者');
    await first.client.waitFor('requestAccepted', (message) => message.requestId === requestId);
    const limitedRequest = first.client.send({ action: 'sendLobbyChat', message: '第二条' });
    const error = await first.client.waitFor('error', (message) => message.requestId === limitedRequest);
    expect(error.payload.code).toBe('CHAT_RATE_LIMIT');
  });

  it('serves health, readiness and anonymous operational metrics', async () => {
    await harness.connect('运维检查');
    const health = await fetch(`${harness.httpUrl}/health`).then((response) => response.json()) as any;
    const ready = await fetch(`${harness.httpUrl}/ready`).then((response) => response.json()) as any;
    const metrics = await fetch(`${harness.httpUrl}/metrics`).then((response) => response.text());
    expect(health.status).toBe('ready');
    expect(health.connectedUsers).toBe(1);
    expect(ready).toEqual(expect.objectContaining({ ok: true, status: 'ready' }));
    expect(metrics).toContain('aeonfront_connected_users 1');
    expect(metrics).not.toContain('运维检查');
  });
});
