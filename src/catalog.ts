import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DECK_SCHEMA_VERSION,
  validateDeck,
  type CardDefinition,
  type SubmittedDeck,
  type ValidationIssue,
  type ValidationResult
} from './common/src/index.js';

export interface PresetDeck {
  deckId: string;
  nameZh: string;
  nameEn: string;
  strategyZh: string;
  cardIds: string[];
}

export interface ContentPack {
  packId: string;
  setCode: string;
  nameZh: string;
  nameEn?: string;
  version: string;
  releaseStatus: 'development' | 'preview' | 'released' | 'retired';
  cards: string[];
  fronts: string[];
  tokens: string[];
  minimumGameVersion: string;
  descriptionZh: string;
}

export interface Catalog {
  cards: CardDefinition[];
  presets: PresetDeck[];
  catalogVersion: string;
  cardVersion: string;
  assetVersion: string;
  packVersions: Record<string, string>;
  packs: ContentPack[];
}

interface CatalogMetadata {
  schemaVersion: number;
  catalogVersion: string;
  packVersions: Record<string, string>;
  cards: number;
}

export interface DeckSubmissionEnvelope {
  cardIds: unknown;
  catalogVersion?: unknown;
  deck?: unknown;
  deckId?: unknown;
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

export function loadCatalog(root = resolve('config/characters')): Catalog {
  const cards = readJson<CardDefinition[]>(resolve(root, 'generated/tcg-cards.json'));
  const presets = readJson<PresetDeck[]>(resolve(root, 'generated/preset-decks.json'));
  const metadata = readJson<CatalogMetadata>(resolve(root, 'generated/catalog.json'));
  const packManifest = readJson<{ packs: Array<{ path: string }> }>(resolve(root, 'data/packs/manifest.json'));
  const packs = packManifest.packs.map((entry) => readJson<ContentPack>(resolve(root, 'data/packs', entry.path)));
  if (metadata.cards !== cards.length) throw new Error(`Catalog metadata expects ${metadata.cards} cards, received ${cards.length}.`);
  if (cards.some((card) => card.catalogVersion !== metadata.catalogVersion)) throw new Error('Card catalog versions are inconsistent.');
  const activePacks = packs.filter((pack) => ['preview', 'released'].includes(pack.releaseStatus));
  const ownedCards = new Set(activePacks.flatMap((pack) => pack.cards));
  if (cards.some((card) => !ownedCards.has(card.cardId))) throw new Error('A card is missing from active content packs.');
  return {
    cards,
    presets,
    catalogVersion: metadata.catalogVersion,
    cardVersion: metadata.catalogVersion,
    assetVersion: digest(cards.map((card) => [card.cardId, card.imageKey])),
    packVersions: metadata.packVersions,
    packs
  };
}

export function validateSubmittedDeck(value: DeckSubmissionEnvelope, catalog: Catalog): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!value.deck || typeof value.deck !== 'object') {
    issues.push({ code: 'DECK_PAYLOAD_REQUIRED', message: 'A versioned deck payload is required.', path: 'deck' });
    return { ok: false, issues };
  }
  const deck = value.deck as Partial<SubmittedDeck> & Record<string, unknown>;
  if (deck.schemaVersion !== DECK_SCHEMA_VERSION) issues.push({ code: 'DECK_SCHEMA_MISMATCH', message: `Expected deck schema ${DECK_SCHEMA_VERSION}.`, path: 'deck.schemaVersion' });
  if (typeof deck.deckId !== 'string' || deck.deckId.length < 1 || deck.deckId.length > 128) issues.push({ code: 'INVALID_DECK_ID', message: 'Deck ID must contain 1 to 128 characters.', path: 'deck.deckId' });
  if (typeof deck.name !== 'string' || deck.name.trim().length < 1 || deck.name.trim().length > 80) issues.push({ code: 'INVALID_DECK_NAME', message: 'Deck name must contain 1 to 80 characters.', path: 'deck.name' });
  if (deck.catalogVersion !== catalog.catalogVersion || value.catalogVersion !== catalog.catalogVersion) {
    issues.push({ code: 'CATALOG_VERSION_MISMATCH', message: `Expected catalog ${catalog.catalogVersion}.`, path: 'deck.catalogVersion' });
  }
  if (!deck.packVersions || typeof deck.packVersions !== 'object') {
    issues.push({ code: 'PACK_VERSIONS_REQUIRED', message: 'Deck pack versions are required.', path: 'deck.packVersions' });
  } else {
    for (const [packId, version] of Object.entries(catalog.packVersions)) {
      if (deck.packVersions[packId] !== version) issues.push({ code: 'PACK_VERSION_MISMATCH', message: `Expected ${packId} pack ${version}.`, path: `deck.packVersions.${packId}` });
    }
  }
  if (!Array.isArray(deck.cardIds) || !Array.isArray(value.cardIds) || JSON.stringify(deck.cardIds) !== JSON.stringify(value.cardIds)) {
    issues.push({ code: 'DECK_CARD_LIST_MISMATCH', message: 'Envelope and deck card lists must match.', path: 'cardIds' });
  } else {
    const result = validateDeck(deck.cardIds, Object.fromEntries(catalog.cards.map((card) => [card.cardId, card])));
    if (!result.ok) issues.push(...result.issues);
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export function sanitizeSubmittedDeck(value: DeckSubmissionEnvelope, catalog: Catalog): SubmittedDeck {
  const result = validateSubmittedDeck(value, catalog);
  if (!result.ok) throw new Error(result.issues[0]?.message ?? 'Invalid deck submission.');
  const deck = value.deck as SubmittedDeck;
  return {
    schemaVersion: DECK_SCHEMA_VERSION,
    deckId: deck.deckId.slice(0, 128),
    name: deck.name.trim().slice(0, 80),
    cardIds: [...deck.cardIds],
    catalogVersion: catalog.catalogVersion,
    packVersions: { ...catalog.packVersions }
  };
}
