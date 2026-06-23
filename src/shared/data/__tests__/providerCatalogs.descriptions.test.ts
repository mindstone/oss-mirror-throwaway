import { describe, expect, it } from 'vitest';
import {
  HAND_MAINTAINED_CATALOG_DESCRIPTION_MAPS,
  PROVIDER_CATALOGS,
  type CatalogProviderType,
} from '../providerCatalogs';
import { MODEL_CATALOG } from '../modelCatalog';

const HAND_MAINTAINED_DESCRIPTION_MAP_NAMES: Readonly<
  Record<keyof typeof HAND_MAINTAINED_CATALOG_DESCRIPTION_MAPS, string>
> = {
  anthropic: 'ANTHROPIC_CATALOG_DESCRIPTIONS',
  openrouter: 'OPENROUTER_CATALOG_DESCRIPTIONS',
};

// A description is "stale" only if its model was RENAMED or REMOVED from the
// catalog — NOT if the row still exists but is merely hidden from selection
// (e.g. a temporarily-withdrawn model like Claude Fable 5, isMainModel/
// isAuxiliaryModel false while its API access is withdrawn). Such a model keeps
// its row + description for when it returns, so we check existence against the
// raw MODEL_CATALOG (all rows for the provider), not the offerable derived
// PROVIDER_CATALOGS. ('anthropic'/'openrouter' map 1:1 to MODEL_CATALOG
// provider values; only those two have hand-maintained description maps.)
function catalogModelIds(provider: CatalogProviderType): Set<string> {
  return new Set(MODEL_CATALOG.filter(entry => entry.provider === provider).map(entry => entry.id));
}

describe('PROVIDER_CATALOGS description coverage', () => {
  it('keeps every user-visible catalog entry described in 80 characters or less', () => {
    for (const [provider, entries] of Object.entries(PROVIDER_CATALOGS)) {
      const companionMapName =
        provider in HAND_MAINTAINED_DESCRIPTION_MAP_NAMES
          ? HAND_MAINTAINED_DESCRIPTION_MAP_NAMES[
              provider as keyof typeof HAND_MAINTAINED_DESCRIPTION_MAP_NAMES
            ]
          : null;

      for (const entry of entries) {
        const description = entry.description?.trim();
        const label = `${provider}:${entry.routeSurface}:${entry.model}`;

        if (companionMapName) {
          expect(
            description,
            `${label} is missing a picker description — add an entry to ${companionMapName} in src/shared/data/providerCatalogs.ts when adding a visible ${provider} catalog row`,
          ).toBeTruthy();
        } else {
          expect(description, `${label} should have a description`).toBeTruthy();
        }
        expect(
          description?.length,
          `${label} description should fit picker rows`,
        ).toBeLessThanOrEqual(80);
      }
    }
  });

  it('has no stale keys in hand-maintained catalog description maps', () => {
    for (const [provider, descriptionMap] of Object.entries(
      HAND_MAINTAINED_CATALOG_DESCRIPTION_MAPS,
    )) {
      const mapName =
        HAND_MAINTAINED_DESCRIPTION_MAP_NAMES[
          provider as keyof typeof HAND_MAINTAINED_DESCRIPTION_MAP_NAMES
        ];
      const catalogIds = catalogModelIds(provider as CatalogProviderType);

      for (const staleKey of Object.keys(descriptionMap)) {
        expect(
          catalogIds.has(staleKey),
          `Stale description key "${staleKey}" in ${mapName} — remove it from src/shared/data/providerCatalogs.ts after renaming or removing the catalog row`,
        ).toBe(true);
      }
    }
  });
});
