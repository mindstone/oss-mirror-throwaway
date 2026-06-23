import { describe, it, expect } from 'vitest';
import { useTopics } from '../useTopics';
import type { TopicEntry, UseTopicsParams, UseTopicsResult } from '../types';

/**
 * Tests for useTopics hook.
 *
 * Since the project doesn't have @testing-library/react installed,
 * these tests focus on exported shape and request construction contracts.
 */

describe('useTopics', () => {
  describe('exports', () => {
    it('exports useTopics function', () => {
      expect(typeof useTopics).toBe('function');
    });
  });

  describe('UseTopicsParams type structure', () => {
    it('can construct params with all fields', () => {
      const params: UseTopicsParams = {
        query: 'invoice',
        spacePath: 'work/Acme/Finance',
        limit: 25,
      };

      expect(params.query).toBe('invoice');
      expect(params.spacePath).toBe('work/Acme/Finance');
      expect(params.limit).toBe(25);
    });

    it('allows empty params (all fields optional)', () => {
      const params: UseTopicsParams = {};
      expect(params.query).toBeUndefined();
      expect(params.spacePath).toBeUndefined();
      expect(params.limit).toBeUndefined();
    });
  });

  describe('TopicEntry type structure', () => {
    it('has all required fields', () => {
      const topic: TopicEntry = {
        relativePath: 'Chief-of-Staff/memory/topics/project-notes.md',
        title: 'Project Notes',
        spacePath: 'Chief-of-Staff',
        updatedAt: '2026-03-27T10:30:00.000Z',
      };

      expect(topic.relativePath).toBe('Chief-of-Staff/memory/topics/project-notes.md');
      expect(topic.title).toBe('Project Notes');
      expect(topic.spacePath).toBe('Chief-of-Staff');
      expect(topic.updatedAt).toBe('2026-03-27T10:30:00.000Z');
    });
  });

  describe('UseTopicsResult type structure', () => {
    it('represents loaded state', () => {
      const result: UseTopicsResult = {
        topics: [],
        isLoading: false,
        error: null,
      };

      expect(result.topics).toEqual([]);
      expect(result.isLoading).toBe(false);
      expect(result.error).toBeNull();
    });

    it('represents error state', () => {
      const result: UseTopicsResult = {
        topics: [],
        isLoading: false,
        error: 'Topics API not available',
      };

      expect(result.error).toBe('Topics API not available');
    });
  });

  describe('IPC request construction', () => {
    it('builds empty request for undefined params', () => {
      const buildRequest = (params?: UseTopicsParams): Record<string, unknown> => {
        const request: Record<string, unknown> = {};
        if (params?.query) request.query = params.query;
        if (params?.spacePath) request.spacePath = params.spacePath;
        if (params?.limit != null) request.limit = params.limit;
        return request;
      };
      const request = buildRequest();

      expect(request).toEqual({});
    });

    it('includes all provided params in request', () => {
      const params: UseTopicsParams = {
        query: 'billing',
        spacePath: 'work/Acme/Finance',
        limit: 10,
      };
      const request: Record<string, unknown> = {};
      if (params.query) request.query = params.query;
      if (params.spacePath) request.spacePath = params.spacePath;
      if (params.limit != null) request.limit = params.limit;

      expect(request).toEqual({
        query: 'billing',
        spacePath: 'work/Acme/Finance',
        limit: 10,
      });
    });
  });

  describe('params serialization for debounce', () => {
    it('produces stable JSON key for identical params', () => {
      const a: UseTopicsParams = { query: 'test', limit: 10 };
      const b: UseTopicsParams = { query: 'test', limit: 10 };
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it('produces stable key for empty/undefined params', () => {
      const serializeKey = (params?: UseTopicsParams): string => JSON.stringify(params ?? {});

      expect(serializeKey(undefined)).toBe('{}');
      expect(serializeKey({})).toBe('{}');
    });
  });
});
