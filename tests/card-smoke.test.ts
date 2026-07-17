import { describe, expect, it } from 'vitest';
import {
  FRONT_DEFINITIONS,
  createGame,
  getCardAbilities,
  resolveAbility,
  serializeGame,
  validateCardDefinitions,
  type CardDefinition,
  type CardInstance,
  type GameState
} from '../src/common/src/index.js';
import { loadCatalog } from '../src/catalog.js';

const catalog = loadCatalog();
const filler = catalog.cards.slice(0, 24);

const instance = (state: GameState, card: CardDefinition, ownerId: string, frontId: string, suffix: string): CardInstance => ({
  instanceId: `smoke-${suffix}`,
  cardId: card.cardId,
  ownerId,
  currentPower: card.power,
  currentCost: card.cost,
  frontId,
  revealed: true,
  silenced: false,
  deployedTurn: 5,
  modifiers: [],
  markers: { 传世: 3, 旌记: 3, 追忆: 3 },
  statuses: [],
  abilityUsage: {},
  moved: true,
  createdByEffect: true
});

function richState(source: CardDefinition): { state: GameState; source: CardInstance } {
  const selected = [source, ...filler.filter((card) => card.cardId !== source.cardId)].slice(0, 24);
  const state = createGame({
    seed: 20260717,
    cards: selected,
    fronts: FRONT_DEFINITIONS,
    catalogVersion: catalog.catalogVersion,
    packVersions: catalog.packVersions,
    players: [
      { playerId: 'p1', name: '甲', deck: selected.slice(0, 12).map((card) => card.cardId) },
      { playerId: 'p2', name: '乙', deck: selected.slice(12, 24).map((card) => card.cardId) }
    ]
  });
  state.turn = 6;
  state.players.forEach((player) => {
    player.energy = 6;
    player.hand = selected.slice(0, 6).map((card) => card.cardId);
    player.deck = selected.slice(6, 12).map((card) => card.cardId);
    player.discarded = [selected[6]!.cardId];
    player.counters = { deployments: 6, moves: 4, deaths: 3, discards: 2, cardsDrawn: 6 };
  });
  state.fronts.forEach((front) => { front.revealed = true; front.revealedTurn = 1; });
  const frontId = state.fronts[1]!.definition.frontId;
  const sourceInstance = instance(state, source, 'p1', frontId, `${source.characterUid}-source`);
  const ally = instance(state, selected[1]!, 'p1', state.fronts[0]!.definition.frontId, `${source.characterUid}-ally`);
  const enemy = instance(state, selected[12]!, 'p2', frontId, `${source.characterUid}-enemy`);
  const secondEnemy = instance(state, selected[13]!, 'p2', state.fronts[2]!.definition.frontId, `${source.characterUid}-enemy-2`);
  state.players[0].fronts[frontId] = [sourceInstance];
  state.players[0].fronts[state.fronts[0]!.definition.frontId] = [ally];
  state.players[1].fronts[frontId] = [enemy];
  state.players[1].fronts[state.fronts[2]!.definition.frontId] = [secondEnemy];
  state.players[0].graveyard = [instance(state, selected[2]!, 'p1', frontId, `${source.characterUid}-grave`)];
  state.players[1].graveyard = [instance(state, selected[14]!, 'p2', frontId, `${source.characterUid}-enemy-grave`)];
  return { state, source: sourceInstance };
}

describe('complete card catalog smoke coverage', () => {
  it('validates all authoritative card definitions', () => {
    expect(catalog.cards).toHaveLength(824);
    expect(validateCardDefinitions(catalog.cards)).toEqual({ ok: true });
  });

  it('executes every configured ability in a rich legal state', () => {
    let abilities = 0;
    for (const card of catalog.cards) {
      for (const configured of getCardAbilities(card)) {
        abilities += 1;
        const { state, source } = richState(card);
        const executable = { ...configured, conditions: [] };
        let events;
        try {
          events = resolveAbility({
            gameState: state,
            ability: executable,
            sourceCardId: card.cardId,
            sourceInstanceId: source.instanceId,
            sourcePlayerId: 'p1',
            sourceFrontId: source.frontId,
            triggeringInstanceId: state.players[1].fronts[source.frontId]![0]!.instanceId,
            triggeringPlayerId: 'p2',
            triggeringFrontId: source.frontId,
            turn: state.turn,
            eventQueue: [],
            depth: 0
          });
        } catch (error) {
          throw new Error(`${card.cardId}/${configured.abilityId}: ${error instanceof Error ? error.message : String(error)}`);
        }
        expect(events.length, `${card.cardId}/${configured.abilityId}`).toBeLessThanOrEqual(512);
        expect(() => serializeGame(state)).not.toThrow();
      }
    }
    expect(abilities).toBeGreaterThan(824);
  });
});
