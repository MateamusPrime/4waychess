import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Purity invariants for the rating package.
 *
 * These are not hygiene: purity is the FEATURE. A rating system's real risk is not getting the
 * maths wrong once, it is being unable to fix it later (RISKS.md R3). Because every rating is a
 * pure function of the ordered game history, a bad model, a bad constant or a discovered
 * exploit can be corrected and the whole ladder rebuilt from stored games. One `Date.now()` or
 * one `Math.random()` anywhere in here silently destroys that guarantee.
 */

const SRC = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PKG = new URL('../package.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(SRC);
const read = (f: string): string => readFileSync(f, 'utf8');
const code = (f: string): string =>
  read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const importsOf = (src: string): string[] =>
  [...src.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

describe('rating purity — the guarantee that the ladder stays fixable', () => {
  test('the only dependency is the engine, for its types', () => {
    const pkg = JSON.parse(read(PKG));
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['@4wc/engine']);
    assert.equal(pkg.devDependencies, undefined);
  });

  test('no clock and no randomness — ratings must be reproducible from history alone', () => {
    for (const f of FILES) {
      const src = code(f);
      assert.equal(/\bDate\.now\b|new Date\(|performance\.now/.test(src), false,
        `${relative(SRC, f)} reads a clock, so the ladder could never be recomputed`);
      assert.equal(/\bMath\.random\b/.test(src), false,
        `${relative(SRC, f)} uses Math.random, so two recomputations would disagree`);
    }
  });

  test('no I/O, no storage, no platform globals', () => {
    for (const f of FILES) {
      const src = code(f);
      assert.equal(/\bnode:fs\b|\bfetch\(|\bconsole\.|\bprocess\./.test(src), false,
        `${relative(SRC, f)} performs I/O`);
      assert.equal(/\bwindow\b|\bdocument\b|\blocalStorage\b|\bBuffer\b/.test(src), false,
        `${relative(SRC, f)} touches a platform global`);
    }
  });

  test('rating does not depend on store — history flows IN, never the reverse', () => {
    // The persistence layer may read ratings; this package must never reach into storage, or
    // "recompute from history" would become "recompute from whatever storage currently says".
    for (const f of FILES) {
      for (const spec of importsOf(read(f))) {
        assert.equal(spec.includes('@4wc/store'), false, `${relative(SRC, f)} imports the store`);
        const ok = spec.startsWith('./') || spec.startsWith('../') || spec === '@4wc/engine';
        assert.ok(ok, `${relative(SRC, f)} imports "${spec}"`);
      }
    }
  });

  test('erasable syntax only, with explicit .ts extensions', () => {
    for (const f of FILES) {
      const src = read(f);
      assert.equal(/^\s*(export\s+)?(const\s+)?enum\s/m.test(src), false, `${relative(SRC, f)} enum`);
      assert.equal(/^\s*(export\s+)?namespace\s/m.test(src), false, `${relative(SRC, f)} namespace`);
      assert.equal(
        /constructor\s*\([^)]*\b(private|public|protected|readonly)\s/.test(src), false,
        `${relative(SRC, f)} parameter property`,
      );
      for (const spec of importsOf(src)) {
        if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
        assert.ok(spec.endsWith('.ts'), `${relative(SRC, f)} imports "${spec}"`);
      }
    }
  });

  test('every module is re-exported from index.ts', () => {
    const index = read(join(SRC, 'index.ts'));
    for (const f of FILES) {
      const name = relative(SRC, f).replace(/\\/g, '/');
      if (name === 'index.ts') continue;
      assert.ok(index.includes(`./${name}`), `${name} is not re-exported`);
    }
  });
});
