import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('README change catalog contains the current package version', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  assert.match(readme, new RegExp(`^### v${packageJson.version.replaceAll('.', '\\.')}(?:\\s|$)`, 'm'));
  assert.match(readme, /every future version change must update this catalog/i);
});
