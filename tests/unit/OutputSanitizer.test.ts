import { describe, it, expect } from 'vitest';
import { stripThinkingBlocks } from '../../src/lib/OutputSanitizer.js';

describe('stripThinkingBlocks', () => {
  it('returns an empty string unchanged', () => {
    expect(stripThinkingBlocks('')).toBe('');
  });

  it('leaves plain content untouched', () => {
    expect(stripThinkingBlocks('hello world')).toBe('hello world');
  });

  it('strips a plain <thinking>...</thinking> block', () => {
    const input = '<thinking>internal</thinking>result';
    expect(stripThinkingBlocks(input)).toBe('result');
  });

  it('strips an <thinking>...</thinking> block', () => {
    const input = '<thinking>internal</thinking>result';
    expect(stripThinkingBlocks(input)).toBe('result');
  });

  it('strips a block that spans multiple lines', () => {
    const input = '<thinking>\n  multi\n  line\n</thinking>\nactual';
    expect(stripThinkingBlocks(input)).toBe('actual');
  });

  it('strips multiple blocks in sequence', () => {
    const input = '<thinking>a</thinking><thinking>b</thinking>keep';
    expect(stripThinkingBlocks(input)).toBe('keep');
  });

  it('strips a mix of plain and antml blocks', () => {
    const input = '<thinking>a</thinking>middle<thinking>b</thinking>end';
    expect(stripThinkingBlocks(input)).toBe('middleend');
  });

  it('trims leading and trailing whitespace after stripping', () => {
    const input = '  <thinking>x</thinking>  content  ';
    expect(stripThinkingBlocks(input)).toBe('content');
  });

  it('lazily matches to the first closing tag (does not over-consume)', () => {
    const input = '<thinking>first</thinking>keep<thinking>second</thinking>tail';
    expect(stripThinkingBlocks(input)).toBe('keeptail');
  });

  it('leaves a block with no closing tag intact (conservative)', () => {
    const input = '<thinking>no close here';
    expect(stripThinkingBlocks(input)).toBe('<thinking>no close here');
  });

  it('does not strip tag-like content that is not a thinking tag', () => {
    const input = '<think>not thinking</think>body';
    expect(stripThinkingBlocks(input)).toBe('<think>not thinking</think>body');
  });

  it('does not strip a tag whose name only starts with "thinking"', () => {
    const input = '<thinkings>fake</thinkings>body';
    expect(stripThinkingBlocks(input)).toBe('<thinkings>fake</thinkings>body');
  });

  it('handles attributes on the opening tag', () => {
    const input = '<thinking lang="en">reasoning</thinking>done';
    expect(stripThinkingBlocks(input)).toBe('done');
  });

  it('preserves JSON after stripping (the production shape)', () => {
    const input = '<thinking>plan reasoning</thinking>\n{"tasks":[]}';
    expect(stripThinkingBlocks(input)).toBe('{"tasks":[]}');
  });
});
