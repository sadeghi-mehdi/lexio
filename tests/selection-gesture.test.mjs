import assert from 'node:assert/strict';
import test from 'node:test';
import { hasExceededDragThreshold } from '../src/utils/selection-gesture.ts';

test('an ordinary click does not cross the text-selection drag threshold', () => {
  assert.equal(hasExceededDragThreshold(100, 100, 102, 103), false);
});

test('a deliberate drag crosses the text-selection threshold', () => {
  assert.equal(hasExceededDragThreshold(100, 100, 106, 100), true);
});
