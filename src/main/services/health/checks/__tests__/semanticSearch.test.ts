import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkEmbeddingServiceReady, checkSemanticIndexHealth, resetSemanticSearchHealthStateForTests } from '../semanticSearch';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';

vi.mock('@core/services/diagnosticEventsLedger', () => ({
  appendDiagnosticEvent: vi.fn(),
}));

vi.mock('../../../embeddingService', () => ({
  isEmbeddingServiceReady: vi.fn(),
  getServiceStatus: vi.fn(),
}));

vi.mock('../../../fileIndexService', () => ({
  hasIndex: vi.fn(),
  getIndexMetadata: vi.fn(),
  getSearchMetrics: vi.fn(),
  getFtsStatus: vi.fn(),
  CURRENT_EMBEDDING_MODEL: 'test-model-v1',
}));

vi.mock('../../../fileWatcherService', () => ({
  getWatcherStatus: vi.fn(),
}));

import { isEmbeddingServiceReady, getServiceStatus } from '../../../embeddingService';
import { hasIndex, getIndexMetadata, getSearchMetrics, getFtsStatus, CURRENT_EMBEDDING_MODEL } from '../../../fileIndexService';
import { getWatcherStatus } from '../../../fileWatcherService';

describe('semanticSearch health checks (Wave B.3 transition emits)', () => {
  const mockSettings = {
    indexingEnabled: true,
    coreDirectory: '/path/to/workspace',
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    resetSemanticSearchHealthStateForTests();

    // Default steady-state 'ok' / 'fresh' mocks for semantic index
    vi.mocked(hasIndex).mockReturnValue(true);
    vi.mocked(getIndexMetadata).mockReturnValue({ embeddingModel: CURRENT_EMBEDDING_MODEL } as any);
    vi.mocked(getSearchMetrics).mockReturnValue({} as any);
    vi.mocked(getFtsStatus).mockReturnValue('ready');
    vi.mocked(getWatcherStatus).mockReturnValue({
      isWatching: true,
      indexedFiles: 10,
      pendingFiles: 0,
      indexState: 'idle'
    } as any);

    // Default steady-state 'ready' mocks for embedding service
    vi.mocked(isEmbeddingServiceReady).mockReturnValue(true);
    vi.mocked(getServiceStatus).mockReturnValue({ failed: false, attempts: 1 } as any);
  });

  describe('checkSemanticIndexHealth', () => {
    it('B.3.T1 (transition): simulated semantic index flip ok → stale → exactly one emit', () => {
      // 1. Establish baseline ('fresh')
      checkSemanticIndexHealth(mockSettings);
      
      // Should emit once for the baseline transition (null -> fresh is not a transition we emit for according to our logic, 
      // wait, our logic says `if (lastSemanticIndexStatus !== null ...)` so it emits nothing on first call.)
      expect(appendDiagnosticEvent).not.toHaveBeenCalled();

      // 2. Flip to 'stale'
      vi.mocked(getIndexMetadata).mockReturnValue({ embeddingModel: 'old-model-v0' } as any);
      checkSemanticIndexHealth(mockSettings);

      expect(appendDiagnosticEvent).toHaveBeenCalledTimes(1);
      expect(appendDiagnosticEvent).toHaveBeenCalledWith({
        kind: 'embedding_index_health',
        data: {
          component: 'semantic_index',
          transition: 'fresh_to_stale',
        },
      });
    });

    it('B.3.T2 (no-flap): poll health check 100 times with index in steady-state ok → assert <=1 event', () => {
      // Poll 100 times in steady state 'fresh'
      for (let i = 0; i < 100; i++) {
        checkSemanticIndexHealth(mockSettings);
      }
      // Since it starts at null -> fresh (no emit), it should be 0.
      expect(appendDiagnosticEvent).toHaveBeenCalledTimes(0);
    });

    it('B.3.T3 (transition-once): baseline → flip once → poll 100 more times → assert exactly +1 event vs baseline', () => {
      // 1. Establish baseline
      checkSemanticIndexHealth(mockSettings);
      expect(appendDiagnosticEvent).toHaveBeenCalledTimes(0);

      // 2. Flip to 'stale'
      vi.mocked(getIndexMetadata).mockReturnValue({ embeddingModel: 'old-model-v0' } as any);
      checkSemanticIndexHealth(mockSettings);

      expect(appendDiagnosticEvent).toHaveBeenCalledTimes(1);
      expect(appendDiagnosticEvent).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ transition: 'fresh_to_stale' })
      }));

      vi.clearAllMocks();

      // 3. Poll 100 more times in 'stale' state
      for (let i = 0; i < 100; i++) {
        checkSemanticIndexHealth(mockSettings);
      }

      // Should not have emitted any more events
      expect(appendDiagnosticEvent).toHaveBeenCalledTimes(0);
    });

    it('transitions back to fresh: stale -> fresh', () => {
      // Baseline: stale
      vi.mocked(getIndexMetadata).mockReturnValue({ embeddingModel: 'old-model-v0' } as any);
      checkSemanticIndexHealth(mockSettings);

      // Flip to fresh
      vi.mocked(getIndexMetadata).mockReturnValue({ embeddingModel: CURRENT_EMBEDDING_MODEL } as any);
      checkSemanticIndexHealth(mockSettings);

      expect(appendDiagnosticEvent).toHaveBeenCalledTimes(1);
      expect(appendDiagnosticEvent).toHaveBeenCalledWith({
        kind: 'embedding_index_health',
        data: {
          component: 'semantic_index',
          transition: 'stale_to_fresh',
        },
      });
    });

    it('transitions to unready: fresh -> unready', () => {
      // Baseline: fresh
      checkSemanticIndexHealth(mockSettings);

      // Flip to unready
      vi.mocked(hasIndex).mockReturnValue(false);
      checkSemanticIndexHealth(mockSettings);

      expect(appendDiagnosticEvent).toHaveBeenCalledTimes(1);
      expect(appendDiagnosticEvent).toHaveBeenCalledWith({
        kind: 'embedding_index_health',
        data: {
          component: 'semantic_index',
          transition: 'ready_to_unready',
        },
      });
    });

    // RC-4 honesty: when the chunk-level search index handle isn't open
    // (`hasIndex() === false`), files are STILL findable — by name via Quick
    // Open (a local filename search over the live tree) and via the assistant's
    // direct read/grep tools. Only meaning-based (semantic) ranking is
    // temporarily unavailable, and it returns automatically once indexing
    // finishes. The health copy must reflect that and must NOT imply the files
    // are missing or that indexing must be turned on by hand.
    describe('RC-4 honest messaging when index is not open', () => {
      it('still-building (isWatching): reassures that files are findable by name and indexing is automatic', () => {
        vi.mocked(hasIndex).mockReturnValue(false);
        vi.mocked(getWatcherStatus).mockReturnValue({
          isWatching: true,
          indexedFiles: 5,
          pendingFiles: 20,
          indexState: 'indexing',
        } as any);

        const result = checkSemanticIndexHealth(mockSettings);

        expect(result.status).toBe('warn');
        // Honest: findable by name; does not claim files are absent.
        expect(result.message).toMatch(/findable by name/i);
        expect(result.message).not.toMatch(/no semantic index/i);
        // Remediation points to the automatic path + name-based recovery, not a
        // manual "turn indexing on" instruction.
        expect(result.remediation).toMatch(/automatically/i);
        expect(result.remediation).toMatch(/quick open|by name|assistant/i);
      });

      it('not-watching, no index: does not imply files are missing or that the user must enable indexing', () => {
        vi.mocked(hasIndex).mockReturnValue(false);
        vi.mocked(getWatcherStatus).mockReturnValue({
          isWatching: false,
          indexedFiles: 0,
          pendingFiles: 0,
          indexState: 'not_started',
        } as any);

        const result = checkSemanticIndexHealth(mockSettings);

        expect(result.status).toBe('warn');
        // Honest: still findable by name; not "No semantic index found".
        expect(result.message).toMatch(/findable by name/i);
        expect(result.message).not.toMatch(/no semantic index found/i);
        // The index builds automatically — the copy must say so rather than
        // implying indexing is off and the user must switch it on.
        expect(result.remediation).toMatch(/builds automatically/i);
        expect(result.remediation).toMatch(/quick open|by name|assistant/i);
      });
    });

    // FTS (keyword) degradation: an open index whose keyword-search half failed
    // to build degrades to vector-only ranking. Before the fix this passed as
    // "Index healthy" (the check never read ftsStatus) — the silent-failure bug.
    // After the fix it is a quiet `warn` with honest, non-alarming copy.
    // See docs/plans/260618_semantic-index-error-surfacing/PLAN.md.
    describe('FTS-degraded (keyword-index failed) surfaces as a quiet warn', () => {
      it('RED→GREEN: index open + matching model + ftsStatus "failed" → warn (was pass)', () => {
        vi.mocked(hasIndex).mockReturnValue(true);
        vi.mocked(getIndexMetadata).mockReturnValue({ embeddingModel: CURRENT_EMBEDDING_MODEL } as any);
        vi.mocked(getFtsStatus).mockReturnValue('failed');

        const result = checkSemanticIndexHealth(mockSettings);

        // Post-fix contract: a degraded keyword index is a warn, not a silent pass.
        expect(result.status).toBe('warn');
        // chief-designer copy: honest about what's reduced, reassures search works.
        expect(result.message).toBe('Keyword search ranking is temporarily reduced — search still works');
        // Remediation: self-heals + name/meaning search unaffected + manual rebuild path.
        expect(result.remediation).toMatch(/rebuilds itself automatically/i);
        expect(result.remediation).toMatch(/by name and meaning-based search are unaffected/i);
        expect(result.remediation).toMatch(/info icon/i);
        // Internal vocabulary must NEVER leak into user-facing copy.
        expect(result.message).not.toMatch(/FTS|index failed|vector-only/i);
        expect(result.remediation).not.toMatch(/\bFTS\b|index failed|vector-only/i);
        // ftsStatus is debug-only detail.
        expect(result.details).toMatchObject({ ftsStatus: 'failed' });
      });

      it('ftsStatus "unavailable" (still-building / no FTS yet) does NOT warn — it is benign', () => {
        vi.mocked(hasIndex).mockReturnValue(true);
        vi.mocked(getIndexMetadata).mockReturnValue({ embeddingModel: CURRENT_EMBEDDING_MODEL } as any);
        vi.mocked(getFtsStatus).mockReturnValue('unavailable');

        const result = checkSemanticIndexHealth(mockSettings);
        expect(result.status).toBe('pass');
      });

      it('ftsStatus "ready" → pass (no regression of the healthy path)', () => {
        vi.mocked(getFtsStatus).mockReturnValue('ready');
        const result = checkSemanticIndexHealth(mockSettings);
        expect(result.status).toBe('pass');
        expect(result.message).toMatch(/index healthy/i);
      });

      it('ordering: a not-open index ("failed" fts) keeps RC-4 building copy, not the FTS warn', () => {
        // hasIndex() false must short-circuit BEFORE the FTS branch so a
        // not-yet-open index is never mislabelled "keyword search reduced".
        vi.mocked(hasIndex).mockReturnValue(false);
        vi.mocked(getFtsStatus).mockReturnValue('failed');
        vi.mocked(getWatcherStatus).mockReturnValue({
          isWatching: true,
          indexedFiles: 5,
          pendingFiles: 20,
          indexState: 'indexing',
        } as any);

        const result = checkSemanticIndexHealth(mockSettings);
        expect(result.status).toBe('warn');
        expect(result.message).toMatch(/findable by name/i);
        expect(result.message).not.toMatch(/keyword search ranking/i);
      });

      it('ordering: model-mismatch wins over the FTS warn', () => {
        // A stale embedding model is the more urgent signal; the FTS branch must
        // sit AFTER it so the reindex remediation is not shadowed.
        vi.mocked(hasIndex).mockReturnValue(true);
        vi.mocked(getIndexMetadata).mockReturnValue({ embeddingModel: 'old-model-v0' } as any);
        vi.mocked(getFtsStatus).mockReturnValue('failed');

        const result = checkSemanticIndexHealth(mockSettings);
        expect(result.status).toBe('warn');
        expect(result.message).toMatch(/different embedding model/i);
        expect(result.message).not.toMatch(/keyword search ranking/i);
      });
    });
  });

  describe('checkEmbeddingServiceReady', () => {
    it('emits on transition ready -> unready', () => {
      // Baseline: ready
      checkEmbeddingServiceReady();
      expect(appendDiagnosticEvent).not.toHaveBeenCalled();

      // Flip to unready
      vi.mocked(isEmbeddingServiceReady).mockReturnValue(false);
      checkEmbeddingServiceReady();

      expect(appendDiagnosticEvent).toHaveBeenCalledTimes(1);
      expect(appendDiagnosticEvent).toHaveBeenCalledWith({
        kind: 'embedding_index_health',
        data: {
          component: 'embedding_service',
          transition: 'ready_to_unready',
        },
      });
    });

    it('does not flap on steady state polling', () => {
      // Baseline: ready
      checkEmbeddingServiceReady();
      
      for (let i = 0; i < 100; i++) {
        checkEmbeddingServiceReady();
      }

      expect(appendDiagnosticEvent).not.toHaveBeenCalled();
    });
  });
});
