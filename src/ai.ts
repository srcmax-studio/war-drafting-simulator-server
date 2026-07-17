import { SeededRandom, type CardDefinition, type FrontDefinition, type PlayerView, type TurnIntent } from './common/src/index.js';

const numberArg = (front: FrontDefinition, key: string, fallback: number): number => {
  const value = front.effectArgs?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const adjustedCost = (card: CardDefinition, front: FrontDefinition, turn: number, firstHere: boolean): number => {
  let cost = card.cost;
  if (front.effectId === 'cost_down') cost -= numberArg(front, 'amount', 1);
  if (front.effectId === 'cost_up') cost += numberArg(front, 'amount', 1);
  if (front.effectId === 'future_beacon' && card.era === String(front.effectArgs?.era ?? '未来时代')) cost -= numberArg(front, 'cost', 1);
  if (front.effectId === 'hand_cost_down' && card.cost >= numberArg(front, 'threshold', 4)) cost -= numberArg(front, 'amount', 1);
  if (front.effectId === 'low_cost_surcharge' && card.cost <= numberArg(front, 'threshold', 2)) cost += numberArg(front, 'amount', 1);
  if (front.effectId === 'final_turn_discount' && turn === numberArg(front, 'turn', 6)) cost -= numberArg(front, 'amount', 2);
  if (firstHere && front.effectId === 'first_card_discount') cost -= numberArg(front, 'amount', 1);
  if (firstHere && front.effectId === 'high_cost_discount' && card.cost >= numberArg(front, 'threshold', 5)) cost -= numberArg(front, 'amount', 2);
  return Math.max(1, Math.floor(cost));
};

const allowed = (card: CardDefinition, front: FrontDefinition): boolean =>
  !(front.effectId === 'ban_high_cost' && card.cost >= numberArg(front, 'threshold', 4))
  && !(front.effectId === 'ban_low_cost' && card.cost <= numberArg(front, 'threshold', 2));

const capacity = (front: FrontDefinition, turn: number): number => {
  let result = front.effectId === 'capacity_up' ? 5 : front.effectId === 'capacity_down' ? 3 : 4;
  if (front.effectId === 'capacity_by_turn') {
    const turns = Array.isArray(front.effectArgs?.turns) ? front.effectArgs.turns.map(Number) : [3, 5];
    result += turns.filter((threshold) => turn >= threshold).length * numberArg(front, 'amount', 1);
  }
  return result;
};

const traitScore = (card: CardDefinition, front: FrontDefinition): number => {
  if (front.effectId === 'era_bonus' && card.era === front.effectArgs?.era) return 3;
  if (front.effectId === 'region_bonus' && card.region === front.effectArgs?.region) return 3;
  if (front.effectId === 'profession_bonus' && card.profession.includes(String(front.effectArgs?.professionIncludes ?? ''))) return 3;
  if (front.effectId === 'identity_bonus' && Array.isArray(front.effectArgs?.identities) && front.effectArgs.identities.includes(card.identity)) return 3;
  if (front.effectId === 'future_beacon' && card.era === front.effectArgs?.era) return 4;
  if (front.effectId === 'ancient_concord' && Array.isArray(front.effectArgs?.eras) && front.effectArgs.eras.includes(card.era)) return 2;
  if (front.effectId === 'medieval_bastion' && card.era.includes(String(front.effectArgs?.eraIncludes ?? '中世纪'))) return 4;
  return 0;
};

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
    .map((card) => ({ card, tie: rng.next() }))
    .sort((left, right) => {
      const leftValue = left.card.balance?.expectedTotalValue ?? left.card.power;
      const rightValue = right.card.balance?.expectedTotalValue ?? right.card.power;
      return rightValue / right.card.cost - leftValue / left.card.cost || left.tie - right.tie || left.card.cardId.localeCompare(right.card.cardId);
    })
    .map(({ card }) => card);
  const laneCounts = new Map(view.fronts.map((front) => [front.definition.frontId, front.cards[aiPlayerId]?.length ?? 0]));
  const turnDeployments = new Map<string, number>();
  const deployments: TurnIntent['deployments'] = [];
  for (const card of hand) {
    const candidates = view.fronts
      .filter((front) => allowed(card, front.definition))
      .filter((front) => !front.deploymentBlocked[aiPlayerId])
      .filter((front) => (laneCounts.get(front.definition.frontId) ?? 0) < (front.capacity[aiPlayerId] ?? capacity(front.definition, view.turn)))
      .filter((front) => front.definition.effectId !== 'single_deploy' || (turnDeployments.get(front.definition.frontId) ?? 0) < 1)
      .map((front) => {
        const firstHere = (front.cards[aiPlayerId]?.some((instance) => instance.deployedTurn === view.turn) ?? false) === false && (turnDeployments.get(front.definition.frontId) ?? 0) === 0;
        const cost = adjustedCost(card, front.definition, view.turn, firstHere);
        const own = front.power[aiPlayerId] ?? 0;
        const opponent = Object.entries(front.power).find(([id]) => id !== aiPlayerId)?.[1] ?? 0;
        const hiddenUncertainty = front.revealed ? 0 : 1.5;
        const cardValue = card.balance?.expectedTotalValue ?? card.power;
        const score = cardValue + traitScore(card, front.definition) - Math.abs(own - opponent) * 0.08 - hiddenUncertainty + rng.next();
        return { front, cost, score };
      })
      .filter((candidate) => candidate.cost <= remaining)
      .sort((left, right) => right.score - left.score || left.front.definition.frontId.localeCompare(right.front.definition.frontId));
    const target = candidates[0];
    if (!target) continue;
    deployments.push({ cardId: card.cardId, frontId: target.front.definition.frontId, order: deployments.length });
    laneCounts.set(target.front.definition.frontId, (laneCounts.get(target.front.definition.frontId) ?? 0) + 1);
    turnDeployments.set(target.front.definition.frontId, (turnDeployments.get(target.front.definition.frontId) ?? 0) + 1);
    remaining -= target.cost;
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
  if (view.turn >= 5 && advantage <= -24) return 'withdraw';
  if (!player?.bannerUsed && view.turn >= 3 && advantage >= 10 && new SeededRandom(seed).next() > 0.35) return 'raise';
  return 'hold';
}
