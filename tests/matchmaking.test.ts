import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServerHarness, deckPayload } from './helpers/server-harness.js';

describe('quick matchmaking', () => {
  let harness: ServerHarness;

  beforeEach(async () => {
    harness = new ServerHarness({ matchmakingConfirmMs: 1_000 });
    await harness.start();
  });

  afterEach(async () => harness.close());

  it('prevents duplicate queue entries and starts after both players accept', async () => {
    const first = await harness.connect('匹配甲');
    const second = await harness.connect('匹配乙');
    first.client.send({ action: 'joinMatchmaking', deck: deckPayload(0).deck });
    await first.client.waitFor('matchmakingQueued');
    const duplicateRequest = first.client.send({ action: 'joinMatchmaking', deck: deckPayload(0).deck });
    const duplicate = await first.client.waitFor('error', (message) => message.requestId === duplicateRequest);
    expect(duplicate.payload.code).toBe('ALREADY_QUEUED');
    second.client.send({ action: 'joinMatchmaking', deck: deckPayload(1).deck });
    const [firstFound, secondFound] = await Promise.all([
      first.client.waitFor('matchFound'),
      second.client.waitFor('matchFound')
    ]);
    expect(firstFound.payload.room.roomId).toBe(secondFound.payload.room.roomId);
    const roomId = firstFound.payload.room.roomId as string;
    first.client.send({ action: 'acceptMatch', roomId });
    second.client.send({ action: 'acceptMatch', roomId });
    const [firstState, secondState] = await Promise.all([
      first.client.waitFor('privateGameState', (message) => message.payload.turn === 1),
      second.client.waitFor('privateGameState', (message) => message.payload.turn === 1)
    ]);
    expect(firstState.gameId).toBe(secondState.gameId);
    expect(firstState.payload.players).toHaveLength(2);
  });

  it('releases both players and removes the match room on decline', async () => {
    const first = await harness.connect('取消甲');
    const second = await harness.connect('取消乙');
    first.client.send({ action: 'joinMatchmaking', deck: deckPayload(0).deck });
    second.client.send({ action: 'joinMatchmaking', deck: deckPayload(1).deck });
    const found = await first.client.waitFor('matchFound');
    await second.client.waitFor('matchFound');
    const roomId = found.payload.room.roomId as string;
    first.client.send({ action: 'declineMatch', roomId });
    const cancelled = await second.client.waitFor('matchCancelled');
    expect(cancelled.payload.reason).toBe('declined');
    const snapshotRequest = second.client.send({ action: 'requestLobbySnapshot' });
    const snapshot = await second.client.waitFor('lobbySnapshot', (message) => message.requestId === snapshotRequest);
    expect(snapshot.payload.rooms.some((room: any) => room.roomId === roomId)).toBe(false);
    expect(snapshot.payload.matchmaking.status).toBe('idle');
  });
});
