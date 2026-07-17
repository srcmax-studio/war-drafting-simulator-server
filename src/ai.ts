import { SeededRandom, type CardDefinition, type PlayerView, type TurnIntent } from './common/src/index.js';

const adjustedCost = (card: CardDefinition, effectId: string): number => {
  if (effectId === 'cost_down') return Math.max(1, card.cost - 1);
  if (effectId === 'cost_up') return card.cost + 1;
  return card.cost;
};

const allowed = (card: CardDefinition, effectId: string): boolean =>
  !(effectId === 'ban_high_cost' && card.cost >= 4) && !(effectId === 'ban_low_cost' && card.cost <= 2);

export function choosePracticeIntent(
  view: PlayerView,
  aiPlayerId: string,
  catalog: Readonly<Record<string, CardDefinition>>,
  seed: number
): TurnIntent {
  const player = view.players.find((candidate) => candidate.playerId === aiPlayerId);
  if (!player?.hand) throw new Error('Practice AI requires its private hand view.');
  const rng = new SeededRandom(seed);
  let remaining = player.energy;
  const hand = player.hand
    .map((cardId) => catalog[cardId])
    .filter((card): card is CardDefinition => Boolean(card))
    .sort((left, right) => (right.power / right.cost) - (left.power / left.cost) || rng.int(3) - 1);
  const laneCounts = new Map(view.fronts.map((front) => [front.definition.frontId, front.cards[aiPlayerId]?.length ?? 0]));
  const deployments: TurnIntent['deployments'] = [];
  for (const card of hand) {
    const candidates = view.fronts
      .filter((front) => allowed(card, front.definition.effectId))
      .filter((front) => {
        const base = front.definition.effectId === 'capacity_up' ? 5 : front.definition.effectId === 'capacity_down' ? 3 : 4;
        return (laneCounts.get(front.definition.frontId) ?? 0) < base;
      })
      .map((front) => {
        const own = front.power[aiPlayerId] ?? 0;
        const opponent = Object.entries(front.power).find(([id]) => id !== aiPlayerId)?.[1] ?? 0;
        const strategic = ['era_bonus', 'region_bonus', 'profession_bonus', 'identity_bonus'].includes(front.definition.effectId) ? 2 : 0;
        return { front, score: own - opponent - strategic + rng.next() };
      })
      .sort((left, right) => left.score - right.score);
    const target = candidates[0]?.front;
    if (!target) continue;
    const cost = adjustedCost(card, target.definition.effectId);
    if (cost > remaining) continue;
    deployments.push({ cardId: card.cardId, frontId: target.definition.frontId, order: deployments.length });
    laneCounts.set(target.definition.frontId, (laneCounts.get(target.definition.frontId) ?? 0) + 1);
    remaining -= cost;
  }
  return { requestId: `ai-plan-${view.turn}-${seed >>> 0}`, turn: view.turn, deployments };
}

export function choosePracticeRisk(view: PlayerView, aiPlayerId: string, seed: number): 'raise' | 'withdraw' | 'hold' {
  if (view.phase !== 'planning') return 'hold';
  let advantage = 0;
  for (const front of view.fronts.filter((item) => item.revealed)) {
    const own = front.power[aiPlayerId] ?? 0;
    const opponent = Object.entries(front.power).find(([id]) => id !== aiPlayerId)?.[1];
    if (opponent !== null && opponent !== undefined) advantage += own - opponent;
  }
  const player = view.players.find((candidate) => candidate.playerId === aiPlayerId);
  if (view.turn >= 4 && advantage <= -15) return 'withdraw';
  if (!player?.bannerUsed && view.turn >= 3 && advantage >= 8 && new SeededRandom(seed).next() > 0.35) return 'raise';
  return 'hold';
}
