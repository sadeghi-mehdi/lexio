import assert from 'node:assert/strict';
import test from 'node:test';
import { findNearestVisiblePage } from '../src/utils/page-visibility.ts';

test('page tracking chooses the page occupying most of the viewport', () => {
  const page = findNearestVisiblePage(0, 900, [
    { page: 1, top: 24, bottom: 224 },
    { page: 2, top: 240, bottom: 440 },
    { page: 3, top: 456, bottom: 656 },
    { page: 4, top: 672, bottom: 872 },
  ]);
  assert.equal(page, 1);
});

test('page tracking follows the nearest visible page after user scrolling', () => {
  const page = findNearestVisiblePage(100, 1000, [
    { page: 8, top: -700, bottom: 80 },
    { page: 9, top: 96, bottom: 876 },
    { page: 10, top: 892, bottom: 1672 },
  ]);
  assert.equal(page, 9);
});

test('page tracking does not advance to a mostly hidden next page', () => {
  const page = findNearestVisiblePage(100, 900, [
    { page: 4, top: -500, bottom: 720 },
    { page: 5, top: 736, bottom: 1956 },
  ]);
  assert.equal(page, 4);
});
