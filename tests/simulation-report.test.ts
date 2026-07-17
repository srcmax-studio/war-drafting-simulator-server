import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface FullReport {
  completedGames: number;
  failures: number;
  invalidPlans: number;
  replayChecks: number;
  replayFailures: number;
  hardFailures: number;
  warnings: string[];
  costs: Array<{ cost: number; averageFinalBattlefieldPower: number }>;
  decks: Array<{ deckId: string; games: number; winRate: number }>;
  matchups: Array<{ matchup: string; games: number; firstDeckWinRate: number }>;
  cards: Array<{ cardId: string; includedGames: number; deploymentRate: number }>;
  fronts: Array<{ frontId: string; games: number }>;
}

const report = JSON.parse(readFileSync(resolve('reports/simulation-full.json'), 'utf8')) as FullReport;
const presets = new Set(['dynasty-command', 'vanguard-charge', 'grand-strategy', 'civilization-concord', 'mythic-coalition', 'stellar-competition']);

describe('committed full balance simulation', () => {
  it('contains fifty thousand successful seeded games and replay checks', () => {
    expect(report.completedGames).toBe(50_000);
    expect(report.failures).toBe(0);
    expect(report.invalidPlans).toBe(0);
    expect(report.replayChecks).toBeGreaterThanOrEqual(100);
    expect(report.replayFailures).toBe(0);
    expect(report.hardFailures).toBe(0);
    expect(report.warnings).toEqual([]);
  });

  it('covers every card and enabled front', () => {
    expect(report.cards).toHaveLength(824);
    expect(report.cards.every((card) => card.includedGames > 0 && card.deploymentRate > 0)).toBe(true);
    expect(report.fronts).toHaveLength(72);
    expect(report.fronts.every((front) => front.games > 0)).toBe(true);
  });

  it('preserves a strictly increasing battlefield contribution by cost', () => {
    expect(report.costs.map((row) => row.cost)).toEqual([1, 2, 3, 4, 5, 6]);
    for (let index = 1; index < report.costs.length; index += 1) {
      expect(report.costs[index]!.averageFinalBattlefieldPower).toBeGreaterThan(report.costs[index - 1]!.averageFinalBattlefieldPower);
    }
  });

  it('keeps preset and ordered matchup win rates in target bands', () => {
    const presetRows = report.decks.filter((deck) => presets.has(deck.deckId));
    expect(presetRows).toHaveLength(6);
    expect(presetRows.every((deck) => deck.games > 1_000 && deck.winRate >= 42 && deck.winRate <= 58)).toBe(true);
    const matchups = report.matchups.filter((matchup) => matchup.games >= 100 && matchup.matchup.split('::').every((deckId) => presets.has(deckId)));
    expect(matchups).toHaveLength(30);
    expect(matchups.every((matchup) => matchup.firstDeckWinRate >= 35 && matchup.firstDeckWinRate <= 65)).toBe(true);
  });
});
