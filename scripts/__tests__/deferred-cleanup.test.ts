import { describe, it, expect } from 'vitest';

import {
  DEFAULT_LEDGER_PATH,
  CleanupRecordSchema,
  parseLedger,
  serializeRecord,
  loadLedger,
  applyAdd,
  applyDefer,
  applyDone,
  applyNote,
  bucketize,
  type CleanupRecord,
  type AddInput,
} from '../deferred-cleanup';

const baseAdd: AddInput = {
  id: 'sample-item',
  title: 'Sample deferred cleanup',
  owner: 'someone',
  deadline: '2026-07-01',
  plan: 'docs/plans/260601_sample.md',
  ease: 'easy',
  value: 'high',
  today: '2026-06-06',
};

describe('deferred-cleanup ledger', () => {
  describe('committed ledger integrity (the always-on guard)', () => {
    it('the real ledger file parses with zero schema errors', () => {
      const { errors } = loadLedger(DEFAULT_LEDGER_PATH);
      expect(errors).toEqual([]);
    });

    it('the real ledger has no duplicate ids and every record has a plan provenance', () => {
      const { records } = loadLedger(DEFAULT_LEDGER_PATH);
      const ids = records.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const r of records) expect(r.provenance.plan.length).toBeGreaterThan(0);
    });
  });

  describe('parse / serialize round-trip', () => {
    it('serializes with canonical key order and re-parses identically', () => {
      const records = applyAdd([], baseAdd);
      const text = records.map(serializeRecord).join('\n');
      expect(text.indexOf('"id"')).toBeLessThan(text.indexOf('"history"'));
      const { records: reparsed, errors } = parseLedger(text);
      expect(errors).toEqual([]);
      expect(reparsed).toEqual(records);
    });

    it('flags invalid JSON, schema violations, and duplicate ids by line', () => {
      const good = serializeRecord(applyAdd([], baseAdd)[0]);
      const text = ['not json', '{"id":"x"}', good, good].join('\n');
      const { records, errors } = parseLedger(text);
      expect(records).toHaveLength(1);
      expect(errors[0]).toMatch(/line 1: invalid JSON/);
      expect(errors[1]).toMatch(/line 2:/);
      expect(errors[2]).toMatch(/line 4: duplicate id/);
    });

    it('rejects a non-kebab id and a missing provenance.plan', () => {
      expect(CleanupRecordSchema.safeParse({ ...applyAdd([], baseAdd)[0], id: 'Bad_Id' }).success).toBe(false);
      const noPlan = applyAdd([], baseAdd)[0] as CleanupRecord;
      expect(CleanupRecordSchema.safeParse({ ...noPlan, provenance: {} }).success).toBe(false);
    });
  });

  describe('mutations', () => {
    it('add seeds a created history entry and open status', () => {
      const [rec] = applyAdd([], baseAdd);
      expect(rec.status).toBe('open');
      expect(rec.created).toBe('2026-06-06');
      expect(rec.history).toEqual([
        { ts: '2026-06-06', action: 'created', deadline: '2026-07-01' },
      ]);
    });

    it('add captures repeatable links/tags and optional provenance fields', () => {
      const [rec] = applyAdd([], {
        ...baseAdd,
        branch: 'dev',
        commit: 'abc1234',
        pr: '#42',
        links: ['docs/plans/a.md', 'docs/plans/b.md'],
        tags: ['settings', 'lint'],
        note: 'deferred during stage 5',
      });
      expect(rec.provenance).toMatchObject({ branch: 'dev', commit: 'abc1234', pr: '#42' });
      expect(rec.provenance.links).toEqual(['docs/plans/a.md', 'docs/plans/b.md']);
      expect(rec.tags).toEqual(['settings', 'lint']);
      expect(rec.provenance.notes).toBe('deferred during stage 5');
    });

    it('add rejects a duplicate id', () => {
      const records = applyAdd([], baseAdd);
      expect(() => applyAdd(records, baseAdd)).toThrow(/already exists/);
    });

    it('defer updates the deadline and appends a deferred history entry', () => {
      const records = applyAdd([], baseAdd);
      const next = applyDefer(records, 'sample-item', '2026-08-01', 'soak not elapsed', '2026-06-30');
      expect(next[0].deadline).toBe('2026-08-01');
      expect(next[0].history.at(-1)).toEqual({
        ts: '2026-06-30',
        action: 'deferred',
        deadline: '2026-08-01',
        reason: 'soak not elapsed',
      });
    });

    it('done flips status and appends a done entry', () => {
      const records = applyAdd([], baseAdd);
      const next = applyDone(records, 'sample-item', '2026-06-20', 'cut over');
      expect(next[0].status).toBe('done');
      expect(next[0].history.at(-1)).toEqual({ ts: '2026-06-20', action: 'done', reason: 'cut over' });
    });

    it('note appends without changing status or deadline', () => {
      const records = applyAdd([], baseAdd);
      const next = applyNote(records, 'sample-item', 'audit still dirty', '2026-06-15');
      expect(next[0].status).toBe('open');
      expect(next[0].deadline).toBe('2026-07-01');
      expect(next[0].history.at(-1)).toEqual({ ts: '2026-06-15', action: 'note', reason: 'audit still dirty' });
    });

    it('mutating an unknown id throws', () => {
      expect(() => applyDone([], 'nope', '2026-06-06')).toThrow(/unknown id/);
    });
  });

  describe('bucketize (the periodic review surface)', () => {
    const records = [
      applyAdd([], { ...baseAdd, id: 'overdue-low', deadline: '2026-06-01', value: 'low', ease: 'hard' })[0],
      applyAdd([], { ...baseAdd, id: 'overdue-high', deadline: '2026-06-05', value: 'high', ease: 'trivial' })[0],
      applyAdd([], { ...baseAdd, id: 'soon', deadline: '2026-06-10' })[0],
      applyAdd([], { ...baseAdd, id: 'later', deadline: '2026-09-01' })[0],
      { ...applyAdd([], { ...baseAdd, id: 'finished' })[0], status: 'done' as const },
    ];

    it('splits open items into overdue/soon/later and surfaces done separately', () => {
      const b = bucketize(records, '2026-06-06', 7);
      expect(b.overdue.map((r) => r.id)).toEqual(['overdue-high', 'overdue-low']); // priority-sorted
      expect(b.soon.map((r) => r.id)).toEqual(['soon']);
      expect(b.later.map((r) => r.id)).toEqual(['later']);
      expect(b.done.map((r) => r.id)).toEqual(['finished']);
    });

    it('treats due-today as overdue (<= 0 days)', () => {
      const b = bucketize([applyAdd([], { ...baseAdd, deadline: '2026-06-06' })[0]], '2026-06-06', 7);
      expect(b.overdue).toHaveLength(1);
    });
  });
});
