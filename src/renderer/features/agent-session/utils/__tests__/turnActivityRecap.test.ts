import { describe, expect, it } from 'vitest';
import { deriveTurnActivityRecap } from '../turnActivityRecap';

describe('deriveTurnActivityRecap', () => {
  describe('lead term + composition', () => {
    it('leads with files when filesTouched > 0 (files · tools · duration)', () => {
      const { label } = deriveTurnActivityRecap({
        filesTouched: 3,
        toolCount: 12,
        durationMs: 80_000, // 1m 20s
        errors: 0,
      });
      expect(label).toBe('3 files · 12 tools · 1m 20s');
    });

    it('leads with tools when no files (tools · duration)', () => {
      const { label } = deriveTurnActivityRecap({
        filesTouched: 0,
        toolCount: 12,
        durationMs: 80_000,
        errors: 0,
      });
      expect(label).toBe('12 tools · 1m 20s');
    });

    it('duration-only turn is framed as "Took Ns"', () => {
      const { label } = deriveTurnActivityRecap({
        filesTouched: 0,
        toolCount: 0,
        durationMs: 18_000,
        errors: 0,
      });
      expect(label).toBe('Took 18s');
    });

    it('files + tools with no duration (duration term dropped)', () => {
      const { label } = deriveTurnActivityRecap({
        filesTouched: 2,
        toolCount: 5,
        errors: 0,
      });
      expect(label).toBe('2 files · 5 tools');
    });

    it('files-only turn (no tools, no duration)', () => {
      const { label } = deriveTurnActivityRecap({
        filesTouched: 4,
        toolCount: 0,
        errors: 0,
      });
      expect(label).toBe('4 files');
    });
  });

  describe('all-zero / empty input', () => {
    it('returns an empty label and a generic aria label', () => {
      const recap = deriveTurnActivityRecap({
        filesTouched: 0,
        toolCount: 0,
        errors: 0,
      });
      expect(recap.label).toBe('');
      expect(recap.ariaLabel).toBe('Show how Rebel worked.');
    });

    it('treats durationMs of 0 as no duration', () => {
      const { label } = deriveTurnActivityRecap({
        filesTouched: 0,
        toolCount: 0,
        durationMs: 0,
        errors: 0,
      });
      expect(label).toBe('');
    });
  });

  describe('singular / plural', () => {
    it('uses singular file and tool', () => {
      const { label } = deriveTurnActivityRecap({
        filesTouched: 1,
        toolCount: 1,
        durationMs: 5_000,
        errors: 0,
      });
      expect(label).toBe('1 file · 1 tool · 5s');
    });

    it('uses plural files and tools', () => {
      const { label } = deriveTurnActivityRecap({
        filesTouched: 3,
        toolCount: 2,
        durationMs: 5_000,
        errors: 0,
      });
      expect(label).toBe('3 files · 2 tools · 5s');
    });
  });

  describe('errors as a muted "hiccup" term', () => {
    it('omits the errors term entirely when errors = 0', () => {
      const { label } = deriveTurnActivityRecap({
        filesTouched: 2,
        toolCount: 4,
        durationMs: 10_000,
        errors: 0,
      });
      expect(label).not.toContain('hiccup');
    });

    it('shows "1 hiccup" as the LAST term', () => {
      const { label } = deriveTurnActivityRecap({
        filesTouched: 3,
        toolCount: 12,
        durationMs: 80_000,
        errors: 1,
      });
      expect(label).toBe('3 files · 12 tools · 1m 20s · 1 hiccup');
    });

    it('pluralises to "N hiccups"', () => {
      const { label } = deriveTurnActivityRecap({
        filesTouched: 0,
        toolCount: 12,
        durationMs: 80_000,
        errors: 3,
      });
      expect(label).toBe('12 tools · 1m 20s · 3 hiccups');
    });

    it('shows a hiccup even when there is no other work', () => {
      const { label } = deriveTurnActivityRecap({
        filesTouched: 0,
        toolCount: 0,
        errors: 2,
      });
      expect(label).toBe('2 hiccups');
    });
  });

  describe('term cap and zero-dropping', () => {
    it('caps the work terms at three (files · tools · duration), errors appended', () => {
      const { label } = deriveTurnActivityRecap({
        filesTouched: 5,
        toolCount: 9,
        durationMs: 3_600_000, // 1h
        errors: 1,
      });
      // files, tools, duration = 3 work terms, then the hiccup term last.
      expect(label.split(' · ')).toEqual(['5 files', '9 tools', '1h', '1 hiccup']);
    });

    it('drops the zero file term but keeps tools + duration', () => {
      const { label } = deriveTurnActivityRecap({
        filesTouched: 0,
        toolCount: 7,
        durationMs: 45_000,
        errors: 0,
      });
      expect(label).toBe('7 tools · 45s');
    });
  });

  describe('aria label', () => {
    it('reads naturally with commas and spelled-out duration units', () => {
      const { ariaLabel } = deriveTurnActivityRecap({
        filesTouched: 3,
        toolCount: 12,
        durationMs: 80_000,
        errors: 0,
      });
      expect(ariaLabel).toBe('Show how Rebel worked: 3 files, 12 tools, 1 minute 20 seconds.');
    });

    it('spells out singular units and a trailing hiccup', () => {
      const { ariaLabel } = deriveTurnActivityRecap({
        filesTouched: 1,
        toolCount: 1,
        durationMs: 60_000,
        errors: 1,
      });
      expect(ariaLabel).toBe('Show how Rebel worked: 1 file, 1 tool, 1 minute, 1 hiccup.');
    });

    it('uses the "Took ..." framing for a duration-only turn', () => {
      const { ariaLabel } = deriveTurnActivityRecap({
        filesTouched: 0,
        toolCount: 0,
        durationMs: 18_000,
        errors: 0,
      });
      expect(ariaLabel).toBe('Show how Rebel worked: Took 18 seconds.');
    });
  });

  describe('input hygiene', () => {
    it('clamps negative / fractional inputs', () => {
      const { label } = deriveTurnActivityRecap({
        filesTouched: -2,
        toolCount: 3.9,
        durationMs: 5_000,
        errors: -1,
      });
      expect(label).toBe('3 tools · 5s');
    });
  });
});
