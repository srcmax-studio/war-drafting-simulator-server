import { describe, expect, it } from 'vitest';
import { DECK_SCHEMA_VERSION } from '../src/common/src/index.js';
import { loadCatalog, sanitizeSubmittedDeck, validateSubmittedDeck } from '../src/catalog.js';

const catalog = loadCatalog();

const submission = (overrides: Record<string, unknown> = {}) => {
  const preset = catalog.presets[0]!;
  const cardIds = [...preset.cardIds];
  return {
    cardIds,
    catalogVersion: catalog.catalogVersion,
    deck: {
      schemaVersion: DECK_SCHEMA_VERSION,
      deckId: 'custom-authoritative-test',
      name: '权威校验牌组',
      cardIds: [...cardIds],
      catalogVersion: catalog.catalogVersion,
      packVersions: { ...catalog.packVersions }
    },
    ...overrides
  };
};

describe('authoritative catalog', () => {
  it('loads versioned cards and active content packs', () => {
    expect(catalog.cards).toHaveLength(824);
    expect(catalog.catalogVersion).toMatch(/^CORE-2-/);
    expect(catalog.packVersions).toEqual({ core: '2.0.0' });
    expect(catalog.packs.find((pack) => pack.packId === 'core')?.fronts).toHaveLength(72);
  });

  it('accepts and sanitizes a complete versioned deck', () => {
    expect(validateSubmittedDeck(submission(), catalog)).toEqual({ ok: true });
    const sanitized = sanitizeSubmittedDeck(submission(), catalog);
    expect(sanitized.cardIds).toEqual(catalog.presets[0]!.cardIds);
    expect(sanitized.catalogVersion).toBe(catalog.catalogVersion);
    expect(Object.keys(sanitized)).toEqual(['schemaVersion', 'deckId', 'name', 'cardIds', 'catalogVersion', 'packVersions']);
  });

  it('rejects missing payloads, stale catalogs and stale packs', () => {
    expect(validateSubmittedDeck({ cardIds: [] }, catalog)).toMatchObject({ ok: false, issues: [{ code: 'DECK_PAYLOAD_REQUIRED' }] });
    const staleCatalog = submission();
    staleCatalog.catalogVersion = 'CORE-1-stale';
    staleCatalog.deck.catalogVersion = 'CORE-1-stale';
    expect(validateSubmittedDeck(staleCatalog, catalog)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'CATALOG_VERSION_MISMATCH' })]) });
    const stalePack = submission();
    stalePack.deck.packVersions = { core: '1.0.0' };
    expect(validateSubmittedDeck(stalePack, catalog)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'PACK_VERSION_MISMATCH' })]) });
  });

  it('rejects unknown, duplicate and mismatched card lists', () => {
    const unknown = submission();
    unknown.cardIds[0] = 'af-unknown-card';
    unknown.deck.cardIds[0] = 'af-unknown-card';
    expect(validateSubmittedDeck(unknown, catalog)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'UNKNOWN_CARD' })]) });
    const duplicate = submission();
    duplicate.cardIds[1] = duplicate.cardIds[0]!;
    duplicate.deck.cardIds[1] = duplicate.deck.cardIds[0]!;
    expect(validateSubmittedDeck(duplicate, catalog)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'DUPLICATE_CARD' })]) });
    const mismatch = submission();
    mismatch.deck.cardIds.reverse();
    expect(validateSubmittedDeck(mismatch, catalog)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'DECK_CARD_LIST_MISMATCH' })]) });
  });
});
