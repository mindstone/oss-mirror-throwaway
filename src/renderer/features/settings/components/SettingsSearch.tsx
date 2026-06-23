import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Input } from '@renderer/components/ui';
import { Search, X } from 'lucide-react';
import {
  filterSettingsSearchIndex,
  getMatchingDestinationsForQuery,
  SETTINGS_DESTINATION_LABELS,
  type SearchEntry,
} from '../searchIndex';
import { resolveSettingsNavigation } from '@shared/navigation/settingsNavigationContract';
import styles from './SettingsSearch.module.css';

/** @visibleForTesting */
export function highlightText(text: string, query: string): ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className={styles.highlight}>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

/** @visibleForTesting */
export function findMatchingKeyword(entry: SearchEntry, query: string): string | null {
  const q = query.toLowerCase();
  if (entry.label.toLowerCase().includes(q)) return null;
  return entry.keywords.find((kw) => kw.toLowerCase().includes(q)) ?? null;
}

export type SettingsSearchProps = {
  onNavigate: (tab: string, section?: string) => void;
  className?: string;
  onMatchesChange?: (matchedDestinations: string[] | null) => void;
  hiddenTabs?: string[];
};

export const SettingsSearch = ({ onNavigate, className, onMatchesChange, hiddenTabs }: SettingsSearchProps) => {
  const [query, setQuery] = useState('');

  const trimmedQuery = query.trim();
  const allResults = useMemo(() => filterSettingsSearchIndex(trimmedQuery), [trimmedQuery]);
  const results = useMemo(
    () => hiddenTabs?.length ? allResults.filter(r => !hiddenTabs.includes(r.tab)) : allResults,
    [allResults, hiddenTabs],
  );

  useEffect(() => {
    if (!onMatchesChange) return;

    if (!trimmedQuery || results.length === 0) {
      onMatchesChange(null);
      return;
    }

    onMatchesChange(getMatchingDestinationsForQuery(trimmedQuery));
  }, [onMatchesChange, trimmedQuery, results.length]);

  const handleNavigate = (tab: string, section?: string) => {
    onNavigate(tab, section);
    setQuery('');
    onMatchesChange?.(null);
  };

  const clearSearch = () => {
    setQuery('');
    onMatchesChange?.(null);
  };

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      <div className={styles.inputWrap}>
        <Search size={15} className={styles.icon} aria-hidden />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              clearSearch();
            }
          }}
          placeholder="Search settings"
          className={styles.input}
          aria-label="Search settings"
        />
        {trimmedQuery && (
          <button
            type="button"
            className={styles.clearButton}
            onClick={clearSearch}
            aria-label="Clear settings search"
          >
            <X size={14} aria-hidden />
          </button>
        )}
      </div>

      {trimmedQuery && (
        <div className={styles.results} aria-label="Settings search results">
          {results.length > 0 ? (
            results.map((result) => {
              const dest = resolveSettingsNavigation({
                tab: result.tab,
                section: result.section,
              }).destination;
              const destLabel = SETTINGS_DESTINATION_LABELS[dest] ?? dest;
              const matchedKeyword = findMatchingKeyword(result, trimmedQuery);
              return (
                <button
                  key={`${result.tab}:${result.section ?? 'root'}:${result.label}`}
                  type="button"
                  className={styles.result}
                  onClick={() => handleNavigate(result.tab, result.section)}
                >
                  <span className={styles.resultLabel}>
                    {highlightText(result.label, trimmedQuery)}
                  </span>
                  <span className={styles.resultTab}>
                    {destLabel}
                    {matchedKeyword && (
                      <span className={styles.keywordHint}>
                        {' \u2014 '}
                        {highlightText(matchedKeyword, trimmedQuery)}
                      </span>
                    )}
                  </span>
                </button>
              );
            })
          ) : (
            <p className={styles.empty}>No settings match that search</p>
          )}
        </div>
      )}
    </div>
  );
};
