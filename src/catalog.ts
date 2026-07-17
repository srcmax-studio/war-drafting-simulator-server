import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CardDefinition } from './common/src/index.js';

export interface PresetDeck {
  deckId: string;
  nameZh: string;
  nameEn: string;
  strategyZh: string;
  cardIds: string[];
}

export interface Catalog {
  cards: CardDefinition[];
  presets: PresetDeck[];
  cardVersion: string;
  assetVersion: string;
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

export function loadCatalog(root = resolve('config/characters')): Catalog {
  const cards = JSON.parse(readFileSync(resolve(root, 'generated/tcg-cards.json'), 'utf8')) as CardDefinition[];
  const presets = JSON.parse(readFileSync(resolve(root, 'generated/preset-decks.json'), 'utf8')) as PresetDeck[];
  return { cards, presets, cardVersion: digest(cards), assetVersion: digest(cards.map((card) => [card.cardId, card.imageKey])) };
}
