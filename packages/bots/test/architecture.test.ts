import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Purity invariants for the bots package, enforced in CI.
 *
 * Bots must be deterministic under a seed: reproducible tests today, server-side verification
 * of bot moves later (bots are matchmaking infrastructure — RISKS.md R1, R16). Determinism
 * dies the moment a clock or Math.random sneaks in, so both are banned mechanically.
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

describe('bots purity', () => {
  test('the only dependency is the engine', () => {
    const pkg = JSON.parse(read(PKG));
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['@4wc/engine']);
    assert.equal(pkg.devDependencies, undefined);
  });

  test('no source imports anything but relative paths and the engine', () => {
    for (const f of FILES) {
      for (const spec of importsOf(read(f))) {
        const ok = spec.startsWith('./') || spec.startsWith('../') || spec === '@4wc/engine';
        assert.ok(ok, `${relative(SRC, f)} imports "${spec}"`);
      }
    }
  });

  test('no clock, no Math.random, no I/O, no globals', () => {
    const banned: [RegExp, string][] = [
      [/\bMath\.random\b/, 'Math.random — bots must be seeded'],
      [/\bDate\.now\b|new Date\(|performance\.now/, 'a clock — budgets are node counts'],
      [/\bnode:fs\b|\bfetch\(|\bconsole\./, 'I/O or logging'],
      [/\bwindow\b|\bdocument\b|\blocalStorage\b|\bBuffer\b|\bprocess\./, 'a platform global'],
      [/setTimeout|setInterval|requestAnimationFrame/, 'a timer'],
    ];
    for (const f of FILES) {
      const src = code(f);
      for (const [re, what] of banned) {
        assert.equal(re.test(src), false, `${relative(SRC, f)} references ${what}`);
      }
    }
  });

  test('erasable syntax only', () => {
    for (const f of FILES) {
      const src = read(f);
      assert.equal(/^\s*(export\s+)?(const\s+)?enum\s/m.test(src), false, `${relative(SRC, f)} enum`);
      assert.equal(/^\s*(export\s+)?namespace\s/m.test(src), false, `${relative(SRC, f)} namespace`);
      assert.equal(
        /constructor\s*\([^)]*\b(private|public|protected|readonly)\s/.test(src), false,
        `${relative(SRC, f)} parameter property`,
      );
    }
  });

  test('every relative import carries a .ts extension', () => {
    for (const f of FILES) {
      for (const spec of importsOf(read(f))) {
        if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
        assert.ok(spec.endsWith('.ts'), `${relative(SRC, f)} imports "${spec}"`);
      }
    }
  });
});
