import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Architectural invariants for ui-core, enforced in CI rather than by convention.
 *
 * The premise of this package is "what to draw, not how". It is what makes one board renderer
 * serve both web and mobile, and it only holds if the package stays free of any renderer,
 * framework, DOM or clock. A rule nobody checks is a rule that erodes.
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
/** Source with comments stripped, so prose never trips the banned-identifier scan. */
const code = (f: string): string =>
  read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const importsOf = (src: string): string[] =>
  [...src.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

describe('ui-core purity', () => {
  test('there are source files to check', () => {
    assert.ok(FILES.length >= 7, `expected sources, found ${FILES.length}`);
  });

  test('the ONLY external dependency is @4wc/engine', () => {
    const pkg = JSON.parse(read(PKG));
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['@4wc/engine']);
    assert.equal(pkg.devDependencies, undefined, 'tests run on Node alone');
  });

  test('no source file imports anything but relative paths, node: builtins, or the engine', () => {
    for (const f of FILES) {
      for (const spec of importsOf(read(f))) {
        const ok = spec.startsWith('./') || spec.startsWith('../')
          || spec.startsWith('node:') || spec === '@4wc/engine';
        assert.ok(ok, `${relative(SRC, f)} imports "${spec}"`);
      }
    }
  });

  test('no renderer, framework or DOM anywhere', () => {
    // If any of these appear, the package has stopped being portable and the shared board
    // renderer premise is broken.
    const banned: [RegExp, string][] = [
      [/\breact\b|\buseState\b|\buseEffect\b|\bjsx\b/i, 'React'],
      [/\bskia\b|CanvasKit|getContext\(/i, 'a renderer'],
      [/\bdocument\b|\bwindow\b|\blocalStorage\b|\bnavigator\b|HTMLElement/, 'a DOM global'],
      [/\bAsyncStorage\b/, 'a React Native API'],
      [/requestAnimationFrame|setTimeout|setInterval/, 'a frame loop or timer'],
    ];
    for (const f of FILES) {
      const src = code(f);
      for (const [re, what] of banned) {
        assert.equal(re.test(src), false, `${relative(SRC, f)} references ${what}`);
      }
    }
  });

  test('no clock and no randomness — animation is a pure function of time', () => {
    // `now` is always passed in. This is what makes every animation deterministic and
    // unit-testable, and lets the same code drive rAF on web and frame callbacks on mobile.
    for (const f of FILES) {
      const src = code(f);
      assert.equal(/\bDate\.now\b|new Date\(|performance\.now/.test(src), false,
        `${relative(SRC, f)} reads a clock`);
      assert.equal(/\bMath\.random\b/.test(src), false,
        `${relative(SRC, f)} uses Math.random`);
    }
  });

  test('no I/O and no console', () => {
    for (const f of FILES) {
      const src = code(f);
      assert.equal(/\bnode:fs\b|\bnode:path\b|\bfetch\(|\bconsole\./.test(src), false,
        `${relative(SRC, f)} performs I/O or logging`);
    }
  });

  test('persistence goes through an injected port, never a global', () => {
    // settings.ts must define a store interface rather than reaching for localStorage, so the
    // same code serves web, mobile, and the server-backed store in Phase 3.
    const settings = read(join(SRC, 'settings.ts'));
    assert.match(settings, /interface SettingsStore/);
    assert.equal(/localStorage|AsyncStorage/.test(code(join(SRC, 'settings.ts'))), false);
  });

  test('the scene layer does not import the interaction reducers backwards', () => {
    // interaction.ts must not depend on scene.ts: input handling has to work headlessly,
    // for bots, tests and replay, with no scene ever built.
    for (const spec of importsOf(read(join(SRC, 'interaction.ts')))) {
      assert.equal(spec.includes('scene'), false, `interaction.ts imports "${spec}"`);
    }
  });

  test('every relative import carries an explicit .ts extension', () => {
    for (const f of FILES) {
      for (const spec of importsOf(read(f))) {
        if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
        assert.ok(spec.endsWith('.ts'), `${relative(SRC, f)} imports "${spec}"`);
      }
    }
  });

  test('erasable syntax only — no enums, namespaces or parameter properties', () => {
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

  test('the public surface is re-exported from index.ts', () => {
    const index = read(join(SRC, 'index.ts'));
    for (const f of FILES) {
      const name = relative(SRC, f).replace(/\\/g, '/');
      if (name === 'index.ts' || name === 'num.ts') continue;
      assert.ok(index.includes(`./${name}`), `${name} is not re-exported from index.ts`);
    }
  });
});
