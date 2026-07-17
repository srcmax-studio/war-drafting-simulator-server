import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FRONT_DEFINITIONS,
  SeededRandom,
  createGame,
  createPlayerView,
  lockTurn,
  submitTurnIntent,
  verifyReplay,
  type CardDefinition,
  type GameState
} from '../src/common/src/index.js';
import { choosePracticeIntent } from '../src/ai.js';
import { loadCatalog } from '../src/catalog.js';

type Mode = 'quick' | 'full' | 'presets' | 'cost-curves';
type DeckKind = 'preset' | 'balanced' | 'tempo' | 'heavy';

interface DeckSpec {
  deckId: string;
  name: string;
  kind: DeckKind;
  cardIds: string[];
}

interface Aggregate {
  games: number;
  wins: number;
  draws: number;
}

interface CardAggregate extends Aggregate {
  included: number;
  deployed: number;
  deployedWins: number;
  held: number;
  heldWins: number;
  finalPower: number;
}

const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, value = 'true'] = argument.replace(/^--/, '').split('=', 2);
  return [key, value];
}));
const mode = (args.get('mode') ?? 'quick') as Mode;
const defaultGames: Record<Mode, number> = { quick: 500, full: 50_000, presets: 6_000, 'cost-curves': 6_000 };
const gamesRequested = Number(args.get('games') ?? defaultGames[mode]);
if (!Number.isInteger(gamesRequested) || gamesRequested < 1) throw new Error('Simulation games must be a positive integer.');
if (!['quick', 'full', 'presets', 'cost-curves'].includes(mode)) throw new Error(`Unknown simulation mode: ${mode}`);

const catalog = loadCatalog(process.env.AEONFRONT_CATALOG_ROOT);
const cardById = new Map(catalog.cards.map((card) => [card.cardId, card]));
const cardsByCost = new Map(Array.from({ length: 6 }, (_, index) => [index + 1, catalog.cards.filter((card) => card.cost === index + 1)]));
const presetDecks: DeckSpec[] = catalog.presets.map((preset) => ({ deckId: preset.deckId, name: preset.nameZh, kind: 'preset', cardIds: [...preset.cardIds] }));
const orderedPresetPairs = presetDecks.flatMap((first) => presetDecks.filter((second) => second.deckId !== first.deckId).map((second) => [first, second] as const));
const costCurves: Record<Exclude<DeckKind, 'preset'>, number[]> = {
  balanced: [1, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6],
  tempo: [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 5, 6],
  heavy: [1, 2, 2, 3, 3, 4, 4, 4, 5, 5, 6, 6]
};

const randomDeck = (rng: SeededRandom, kind: Exclude<DeckKind, 'preset'>, index: number): DeckSpec => {
  const selected = new Set<string>();
  for (const cost of costCurves[kind]) {
    const candidates = rng.shuffle(cardsByCost.get(cost)!).filter((card) => !selected.has(card.cardId));
    const card = candidates[0];
    if (!card) throw new Error(`Unable to build ${kind} deck at cost ${cost}.`);
    selected.add(card.cardId);
  }
  return { deckId: `${kind}-${index}`, name: `${kind}-${index}`, kind, cardIds: [...selected] };
};

const decksForGame = (index: number): [DeckSpec, DeckSpec] => {
  if (mode === 'presets' || (mode !== 'cost-curves' && index % 2 === 0)) {
    const pairingIndex = mode === 'presets' ? index : Math.floor(index / 2);
    return [...orderedPresetPairs[pairingIndex % orderedPresetPairs.length]!] as [DeckSpec, DeckSpec];
  }
  const rng = new SeededRandom((0x6ae0f17 ^ Math.imul(index + 1, 2_654_435_761)) >>> 0);
  const kinds = Object.keys(costCurves) as Array<Exclude<DeckKind, 'preset'>>;
  const firstKind = kinds[index % kinds.length]!;
  const secondKind = kinds[(index + 1) % kinds.length]!;
  return [randomDeck(rng, firstKind, index * 2), randomDeck(rng, secondKind, index * 2 + 1)];
};

const cardStats = new Map<string, CardAggregate>(catalog.cards.map((card) => [card.cardId, { games: 0, wins: 0, draws: 0, included: 0, deployed: 0, deployedWins: 0, held: 0, heldWins: 0, finalPower: 0 }]));
const deckStats = new Map<string, Aggregate>();
const matchupStats = new Map<string, Aggregate>();
const frontStats = new Map<string, { games: number; firstWins: number; secondWins: number; draws: number }>();
const costStats = new Map<number, { deployed: number; finalPower: number }>(Array.from({ length: 6 }, (_, index) => [index + 1, { deployed: 0, finalPower: 0 }]));
let failures = 0;
let invalidPlans = 0;
let replayChecks = 0;
let replayFailures = 0;
let fizzles = 0;
let totalEvents = 0;
let maximumEvents = 0;

const aggregate = (map: Map<string, Aggregate>, key: string, won: boolean, draw: boolean): void => {
  const row = map.get(key) ?? { games: 0, wins: 0, draws: 0 };
  row.games += 1;
  if (won) row.wins += 1;
  if (draw) row.draws += 1;
  map.set(key, row);
};

const fallbackIntent = (state: GameState, playerId: string) => ({ requestId: `fallback-${playerId}-${state.turn}`, turn: state.turn, deployments: [] });

const playGame = (index: number, firstDeck: DeckSpec, secondDeck: DeckSpec): GameState => {
  const seed = (0xae0f0000 + Math.imul(index + 1, 104_729)) >>> 0;
  const gameCards = [...new Set([...firstDeck.cardIds, ...secondDeck.cardIds])].map((cardId) => cardById.get(cardId)!);
  const runtimeCatalog: Record<string, CardDefinition> = Object.fromEntries(gameCards.map((card) => [card.cardId, card]));
  const state = createGame({
    gameId: `balance-${mode}-${index}-${seed}`,
    seed,
    cards: gameCards,
    fronts: FRONT_DEFINITIONS,
    catalogVersion: catalog.catalogVersion,
    packVersions: catalog.packVersions,
    players: [
      { playerId: 'p1', name: firstDeck.name, deck: firstDeck.cardIds, deckId: firstDeck.deckId, deckName: firstDeck.name },
      { playerId: 'p2', name: secondDeck.name, deck: secondDeck.cardIds, deckId: secondDeck.deckId, deckName: secondDeck.name }
    ]
  });
  while (state.phase !== 'ended') {
    for (const [playerIndex, playerId] of ['p1', 'p2'].entries()) {
      const view = createPlayerView(state, playerId);
      const intent = choosePracticeIntent(view, playerId, runtimeCatalog, (seed + state.turn * 4099 + playerIndex * 65_537) >>> 0);
      const submitted = submitTurnIntent(state, playerId, intent);
      if (!submitted.ok) {
        invalidPlans += 1;
        if (invalidPlans <= 5) console.error(`Invalid plan in game ${index}, turn ${state.turn}, ${playerId}: ${JSON.stringify(submitted.issues)}; ${JSON.stringify(intent.deployments)}`);
        const fallback = submitTurnIntent(state, playerId, fallbackIntent(state, playerId));
        if (!fallback.ok) throw new Error(`Fallback plan rejected: ${fallback.issues[0]?.code}`);
      }
    }
    const turn = state.turn;
    const firstLock = lockTurn(state, 'p1', `lock-p1-${turn}`);
    const secondLock = lockTurn(state, 'p2', `lock-p2-${turn}`);
    if (!firstLock.ok || !secondLock.ok) throw new Error(`Lock rejected on turn ${turn}.`);
  }
  return state;
};

const recordGame = (state: GameState, decks: [DeckSpec, DeckSpec], index: number): void => {
  const winnerId = state.winner?.winnerId ?? null;
  const draw = winnerId === null;
  decks.forEach((deck, playerIndex) => {
    const playerId = `p${playerIndex + 1}`;
    const won = winnerId === playerId;
    aggregate(deckStats, deck.deckId, won, draw);
    for (const cardId of deck.cardIds) {
      const row = cardStats.get(cardId)!;
      row.games += 1;
      row.included += 1;
      if (won) row.wins += 1;
      if (draw) row.draws += 1;
    }
    const player = state.players[playerIndex]!;
    for (const cardId of new Set(player.hand)) {
      if (!deck.cardIds.includes(cardId)) continue;
      const row = cardStats.get(cardId)!;
      row.held += 1;
      if (won) row.heldWins += 1;
    }
    const instances = [...Object.values(player.fronts).flat(), ...player.graveyard];
    const deployedIds = new Set(instances.map((instance) => instance.cardId));
    for (const cardId of deployedIds) {
      if (!deck.cardIds.includes(cardId)) continue;
      const row = cardStats.get(cardId)!;
      row.deployed += 1;
      if (won) row.deployedWins += 1;
      row.finalPower += instances.filter((instance) => instance.cardId === cardId).reduce((sum, instance) => sum + instance.currentPower, 0);
    }
    for (const instance of Object.values(player.fronts).flat()) {
      const card = cardById.get(instance.cardId);
      if (!card || !deck.cardIds.includes(card.cardId)) continue;
      const row = costStats.get(card.cost)!;
      row.deployed += 1;
      row.finalPower += instance.currentPower;
    }
  });
  const matchupKey = `${decks[0].deckId}::${decks[1].deckId}`;
  aggregate(matchupStats, matchupKey, winnerId === 'p1', draw);
  for (const front of state.fronts) {
    const frontId = front.definition.frontId;
    const row = frontStats.get(frontId) ?? { games: 0, firstWins: 0, secondWins: 0, draws: 0 };
    row.games += 1;
    const winner = state.winner?.frontWinners[frontId];
    if (winner === 'p1') row.firstWins += 1;
    else if (winner === 'p2') row.secondWins += 1;
    else row.draws += 1;
    frontStats.set(frontId, row);
  }
  const eventCount = state.eventLog.length;
  totalEvents += eventCount;
  maximumEvents = Math.max(maximumEvents, eventCount);
  fizzles += state.eventLog.filter((event) => event.type === 'deployment_fizzled').length;
  const replayInterval = mode === 'quick' ? 25 : 500;
  if (index % replayInterval === 0) {
    replayChecks += 1;
    if (!verifyReplay(state)) replayFailures += 1;
  }
};

for (let index = 0; index < gamesRequested; index += 1) {
  const decks = decksForGame(index);
  try {
    const state = playGame(index, ...decks);
    recordGame(state, decks, index);
  } catch (error) {
    failures += 1;
    if (failures <= 5) console.error(`Simulation ${index} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (gamesRequested >= 10_000 && (index + 1) % 5_000 === 0) console.log(`Completed ${index + 1}/${gamesRequested} games.`);
}

const percent = (wins: number, games: number) => games > 0 ? Number((wins / games * 100).toFixed(2)) : 0;
const deckRows = [...deckStats.entries()].map(([deckId, row]) => ({ deckId, ...row, winRate: percent(row.wins, row.games), drawRate: percent(row.draws, row.games) })).sort((left, right) => left.deckId.localeCompare(right.deckId));
const matchupRows = [...matchupStats.entries()].map(([matchup, row]) => ({ matchup, ...row, firstDeckWinRate: percent(row.wins, row.games), drawRate: percent(row.draws, row.games) })).sort((left, right) => left.matchup.localeCompare(right.matchup));
const cardRows = [...cardStats.entries()].map(([cardId, row]) => ({
  cardId,
  cost: cardById.get(cardId)!.cost,
  includedGames: row.included,
  winRate: percent(row.wins, row.games),
  deploymentRate: percent(row.deployed, row.included),
  deployedWinRate: percent(row.deployedWins, row.deployed),
  heldWinRate: percent(row.heldWins, row.held),
  averageFinalPowerWhenDeployed: row.deployed > 0 ? Number((row.finalPower / row.deployed).toFixed(2)) : 0
})).sort((left, right) => left.cardId.localeCompare(right.cardId));
const costRows = [...costStats.entries()].map(([cost, row]) => ({ cost, deployed: row.deployed, averageFinalBattlefieldPower: row.deployed > 0 ? Number((row.finalPower / row.deployed).toFixed(2)) : 0 }));
const frontRows = [...frontStats.entries()].map(([frontId, row]) => ({ frontId, ...row, firstPlayerWinRate: percent(row.firstWins, row.games), secondPlayerWinRate: percent(row.secondWins, row.games), drawRate: percent(row.draws, row.games) })).sort((left, right) => left.frontId.localeCompare(right.frontId));
const warnings: string[] = [];
for (const row of deckRows.filter((deck) => presetDecks.some((preset) => preset.deckId === deck.deckId))) if (row.games >= 100 && (row.winRate < 42 || row.winRate > 58)) warnings.push(`${row.deckId} overall win rate is ${row.winRate}%.`);
for (const row of matchupRows.filter((matchup) => matchup.games >= 100 && matchup.matchup.split('::').every((deckId) => presetDecks.some((preset) => preset.deckId === deckId)))) if (row.firstDeckWinRate < 35 || row.firstDeckWinRate > 65) warnings.push(`${row.matchup} first-deck win rate is ${row.firstDeckWinRate}%.`);
for (let index = 1; index < costRows.length; index += 1) if (costRows[index]!.averageFinalBattlefieldPower <= costRows[index - 1]!.averageFinalBattlefieldPower) warnings.push(`Cost ${index + 1} battlefield contribution does not exceed cost ${index}.`);
const hardFailures = failures + invalidPlans + replayFailures;
const report = {
  schemaVersion: 1,
  catalogVersion: catalog.catalogVersion,
  mode,
  seedFormula: '0xae0f0000 + gameIndex * 104729',
  requestedGames: gamesRequested,
  completedGames: gamesRequested - failures,
  failures,
  invalidPlans,
  replayChecks,
  replayFailures,
  fizzles,
  averageEventsPerGame: gamesRequested - failures > 0 ? Number((totalEvents / (gamesRequested - failures)).toFixed(2)) : 0,
  maximumEvents,
  hardFailures,
  warnings,
  costs: costRows,
  decks: deckRows,
  matchups: matchupRows,
  cards: cardRows,
  fronts: frontRows
};
const markdown = [
  '# Balance Simulation Report',
  '',
  `- Mode: ${mode}`,
  `- Catalog: ${catalog.catalogVersion}`,
  `- Completed games: ${report.completedGames.toLocaleString('en-US')}`,
  `- Replay checks: ${replayChecks.toLocaleString('en-US')}`,
  `- Hard failures: ${hardFailures}`,
  `- Deterministic deployment fizzles: ${fizzles.toLocaleString('en-US')}`,
  `- Average events: ${report.averageEventsPerGame}`,
  '',
  '## Cost Contribution',
  '',
  '| Cost | Deployments | Average final battlefield power |',
  '| ---: | ---: | ---: |',
  ...costRows.map((row) => `| ${row.cost} | ${row.deployed} | ${row.averageFinalBattlefieldPower} |`),
  '',
  '## Preset Decks',
  '',
  '| Deck | Games | Win rate | Draw rate |',
  '| --- | ---: | ---: | ---: |',
  ...deckRows.filter((deck) => presetDecks.some((preset) => preset.deckId === deck.deckId)).map((row) => `| ${row.deckId} | ${row.games} | ${row.winRate}% | ${row.drawRate}% |`),
  '',
  '## Warnings',
  '',
  ...(warnings.length > 0 ? warnings.map((warning) => `- ${warning}`) : ['- None']),
  ''
].join('\n');

const reportsDir = resolve('reports');
mkdirSync(reportsDir, { recursive: true });
writeFileSync(resolve(reportsDir, `simulation-${mode}.json`), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(resolve(reportsDir, `simulation-${mode}.md`), markdown);
console.log(`Simulated ${report.completedGames} ${mode} games with ${hardFailures} hard failures and ${warnings.length} balance warnings.`);
if (hardFailures > 0) process.exitCode = 1;
