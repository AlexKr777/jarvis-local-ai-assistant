import test from 'node:test';
import assert from 'node:assert/strict';

import { assessPublicTextRhythm, formatSquareEditorialPost, normalizePublicText } from '../src/crypto/content/public-text-format.js';

test('public post normalization preserves intentional blank paragraphs without invisible separators', () => {
  const result = normalizePublicText('First thought.\r\n\r\n\r\nSecond thought.  \r\n\r\nThird thought.');
  assert.equal(result.text, 'First thought.\n\nSecond thought.\n\nThird thought.');
  assert.equal(result.usedInvisibleSeparator, false);
  assert.equal(result.paragraphCount, 3);
});

test('rhythm assessment rejects repeated same-size microparagraph rectangles', () => {
  const result = assessPublicTextRhythm('I care about the first test here.\n\nI care about the next test too.\n\nI care about the final test now.\n\nI care about the last line still.');
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('SYMMETRIC_PARAGRAPH_SHAPE'));
});

test('rhythm assessment accepts deliberately uneven readable thought progression', () => {
  const result = assessPublicTextRhythm('The percentage is not the part I trust yet.\n\nI need the first pullback to stop at the level that created the move, because another green candle would tell me much less.\n\nThat is the proof.\n\nIf it cannot hold there, the larger idea has already changed.');
  assert.equal(result.ok, true);
  assert.ok(result.paragraphLengths.some((length) => length <= 4));
  assert.ok(result.paragraphLengths.some((length) => length >= 18));
});

test('Square editorial shell starts with one canonical cashtag and ends with two deterministic topical hashtags', () => {
  const text = formatSquareEditorialPost({
    text: 'I only trust $ALPHA if 8.80 absorbs the first pullback.\n\n#OldTag 10.00 is the next place I need buyers to prove the idea.',
    candidate: { cashtag: '$ALPHA' },
    storyKind: 'retest_continuation',
  });

  assert.equal(text, '$ALPHA I only trust if 8.80 absorbs the first pullback.\n\n10.00 is the next place I need buyers to prove the idea.\n\n#Crypto #Retest');
  assert.deepEqual(text.match(/\$[A-Z][A-Z0-9]{1,11}\b/g), ['$ALPHA']);
  assert.deepEqual(text.match(/#[A-Za-z][A-Za-z0-9_]*\b/g), ['#Crypto', '#Retest']);
});
