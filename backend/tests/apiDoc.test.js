// The API reference (docs/api/openapi.yaml) must list exactly the routes the server has. A route
// added or removed without the doc fails here, so the reference can't quietly go stale.
import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const norm = (p) => p.replace(/:(\w+)/g, '{}').replace(/\{\w+\}/g, '{}');

function codeRoutes() {
  const files = readdirSync(join(root, 'src/routes')).map((f) => join(root, 'src/routes', f)).concat(join(root, 'src/index.js'));
  const out = new Set();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:Router|app)\.(get|post|delete|put|patch)\(\s*'([^']+)'/g)) {
      const path = m[2].startsWith('/api') ? m[2] : `/api${m[2]}`;
      out.add(`${m[1].toUpperCase()} ${norm(path)}`);
    }
  }
  return out;
}

function docRoutes() {
  const spec = YAML.parse(readFileSync(join(root, '..', 'docs/api/openapi.yaml'), 'utf8'));
  const out = new Set();
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const method of Object.keys(ops)) out.add(`${method.toUpperCase()} ${norm(path)}`);
  }
  return out;
}

describe('API reference', () => {
  test('documents every route the server has, and no route it lacks', () => {
    const code = codeRoutes();
    const doc = docRoutes();
    expect([...code].filter((r) => !doc.has(r)).sort()).toEqual([]);
    expect([...doc].filter((r) => !code.has(r)).sort()).toEqual([]);
    expect(code.size).toBeGreaterThan(50);
  });
});
