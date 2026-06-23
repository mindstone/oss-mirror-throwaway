import { describe, expect, it } from 'vitest';
import { stripThinkingBlocks } from '../stripThinkingBlocks';

describe('stripThinkingBlocks', () => {
  it('returns text as-is if no thinking blocks', () => {
    expect(stripThinkingBlocks('Hello world')).toBe('Hello world');
  });

  it('strips closed thinking blocks', () => {
    const text = '<think>\nThis is a thought process.\n</think>\nHello world';
    expect(stripThinkingBlocks(text)).toBe('Hello world');
  });

  it('strips multiple thinking blocks', () => {
    const text = '<think>first</think>Part 1<think>second</think>Part 2';
    expect(stripThinkingBlocks(text)).toBe('Part 1Part 2');
  });

  it('strips trailing unclosed thinking block', () => {
    const text = 'Hello world\n<think>\nThis thought is cut off...';
    expect(stripThinkingBlocks(text)).toBe('Hello world');
  });

  it('strips a think block at the start of the response', () => {
    const text = '<think>I should answer briefly.</think>\nFinal answer.';
    expect(stripThinkingBlocks(text)).toBe('Final answer.');
  });

  it('returns an empty string when the think block is the entire response', () => {
    expect(stripThinkingBlocks('<think>Only hidden reasoning.</think>')).toBe('');
  });

  it('preserves content before and after a think block', () => {
    const text = 'Before <think>hidden reasoning</think> after';
    expect(stripThinkingBlocks(text)).toBe('Before  after');
  });

  it('strips think blocks containing newlines', () => {
    const text = 'Answer:\n<think>\nline one\nline two\n</think>\nVisible.';
    expect(stripThinkingBlocks(text)).toBe('Answer:\n\nVisible.');
  });
});
