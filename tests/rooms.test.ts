import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServerHarness } from './helpers/server-harness.js';

describe('room lifecycle and isolation', () => {
  let harness: ServerHarness;

  beforeEach(async () => {
    harness = new ServerHarness({ chatIntervalMs: 10 });
    await harness.start();
  });

  afterEach(async () => harness.close());

  it('isolates room chat and state broadcasts between simultaneous rooms', async () => {
    const participants = await Promise.all(['甲一', '甲二', '乙一', '乙二'].map((name) => harness.connect(name)));
    const a1 = participants[0]!;
    const a2 = participants[1]!;
    const b1 = participants[2]!;
    const b2 = participants[3]!;
    const roomA = await harness.createRoom(a1.client, '甲房');
    const roomB = await harness.createRoom(b1.client, '乙房');
    await harness.joinRoom(a2.client, roomA);
    await harness.joinRoom(b2.client, roomB);
    a1.client.send({ action: 'sendRoomChat', roomId: roomA, message: '只在甲房' });
    const message = await a2.client.waitFor('roomChatMessage');
    expect(message.roomId).toBe(roomA);
    expect(message.payload.content).toBe('只在甲房');
    await b1.client.expectNoEvent('roomChatMessage');
    await b2.client.expectNoEvent('roomChatMessage');
  });

  it('protects private rooms, enforces capacity and transfers host ownership', async () => {
    const host = await harness.connect('房主');
    const guest = await harness.connect('来客');
    const extra = await harness.connect('额外玩家');
    const roomId = await harness.createRoom(host.client, '密室', 45_000, '通关令');
    const wrongRequest = guest.client.send({ action: 'joinRoom', roomId, password: '错误' });
    const wrong = await guest.client.waitFor('error', (message) => message.requestId === wrongRequest);
    expect(wrong.payload.code).toBe('ROOM_PASSWORD_INVALID');
    await harness.joinRoom(guest.client, roomId, '通关令');
    const fullRequest = extra.client.send({ action: 'joinRoom', roomId, password: '通关令' });
    const full = await extra.client.waitFor('error', (message) => message.requestId === fullRequest);
    expect(full.payload.code).toBe('ROOM_FULL');
    const leaveRequest = host.client.send({ action: 'leaveRoom', roomId });
    await host.client.waitFor('roomLeft', (message) => message.requestId === leaveRequest);
    const transferred = await guest.client.waitFor('roomUpdated', (message) => message.payload.hostId === guest.playerId);
    expect(transferred.payload.members.find((member: any) => member.playerId === guest.playerId).role).toBe('host');
  });

  it('lets hosts remove a player without exposing the selected card list', async () => {
    const host = await harness.connect('主将');
    const guest = await harness.connect('副将');
    const roomId = await harness.createRoom(host.client, '整备房');
    await harness.joinRoom(guest.client, roomId);
    const requestId = host.client.send({ action: 'kickPlayer', roomId, playerId: guest.playerId });
    const updated = await host.client.waitFor('roomUpdated', (message) => message.requestId === requestId);
    expect(updated.payload.members).toHaveLength(1);
    const left = await guest.client.waitFor('roomLeft');
    expect(left.payload.reason).toBe('kicked');
    expect(JSON.stringify(updated.payload)).not.toContain('cardIds');
  });
});
