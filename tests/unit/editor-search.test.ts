import { describe, expect, it } from 'vitest';
import { acceptEditorReviewSchema } from '../../src/shared/editor';
import { findEditorMatches } from '../../src/shared/editor-search';

describe('literal editor search', () => {
  it('keeps UTF-16 selection positions correct for Unicode and treats regex syntax literally', () => {
    expect(findEditorMatches('😀 [.*] 日本語 [.*]', '[.*]')).toEqual([3, 12]);
    expect(findEditorMatches('Hello hello', 'hello')).toEqual([6]);
    expect(findEditorMatches('aaaa', 'aa')).toEqual([0, 2]);
    expect(findEditorMatches('text', '')).toEqual([]);
  });
  it('bounds repeated results and refuses malformed comparison acceptance payloads', () => {
    expect(findEditorMatches('a'.repeat(1024 * 1024), 'a')).toHaveLength(1000);
    expect(
      acceptEditorReviewSchema.safeParse({ token: 'old', reviewToken: 'old', keepDraft: true })
        .success,
    ).toBe(false);
  });
});
