import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Architectural invariants, enforced in CI rather than by convention.
 *
 * ARCHITECTURE.md §1 states that the engine is a pure, dependency-free package with no I/O and
 * no knowledge of transport or rendering, and that this is what keeps every other decision in
 * the project reversible. A rule nobody checks is a rule that erodes, so it is checked here.
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

/** Source with comments removed, so prose never trips the banned-identifier scan. */
const code = (f: string): string =>
  read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const importsOf = (src: string): string[] =>
  [...src.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

describe('engine purity (ARCHITECTURE.md §1)', () => {
  test('there are source files to check', () => {
    assert.ok(FILES.length >= 8, `expected engine sources, found ${FILES.length}`);
  });

  test('package.json declares no dependencies of any kind', () => {
    const pkg = JSON.parse(read(PKG));
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      assert.equal(pkg[field], undefined, `engine must not declare ${field}`);
    }
  });

  test('no source file imports anything outside the package', () => {
    for (const f of FILES) {
      for (const spec of importsOf(read(f))) {
        const local = spec.startsWith('./') || spec.startsWith('../');
        const nodeBuiltin = spec.startsWith('node:');
        assert.ok(
          local || nodeBuiltin,
          `${relative(SRC, f)} imports "${spec}" — the engine must have no external dependencies`,
        );
        assert.ok(
          !spec.includes('apps/'),
          `${relative(SRC, f)} imports from apps/ — the engine must not depend on any application`,
        );
      }
    }
  });

  test('core engine files touch no I/O, no globals, no clock, no randomness', () => {
    // Tools are exempt: they are CLIs by definition. Everything else must be pure so it can
    // run identically in a browser, in React Native, inside a server, and inside a bot search.
    const core = FILES.filter((f) => !f.includes('tools'));
    const banned: [RegExp, string][] = [
      [/\bnode:fs\b|\bnode:path\b|\bnode:http\b/, 'Node I/O module'],
      [/\bprocess\./, 'process'],
      [/\bMath\.random\b/, 'Math.random — the engine must be deterministic'],
      [/\bDate\.now\b|new Date\(/, 'wall-clock time'],
      [/\bwindow\b|\bdocument\b|\blocalStorage\b|\bnavigator\b/, 'browser global'],
      // Buffer is Node-only. It works in tests and on a server and then fails in the browser
      // and in React Native — the exact class of bug this whole rule exists to prevent.
      [/\bBuffer\b/, 'Buffer — a Node-only global, unavailable in browsers and React Native'],
      [/\b__dirname\b|\b__filename\b|\brequire\(/, 'CommonJS/Node global'],
      [/\bfetch\(/, 'network access'],
      [/\bconsole\./, 'console output'],
    ];
    for (const f of core) {
      const src = code(f);
      for (const [re, what] of banned) {
        assert.equal(re.test(src), false, `${relative(SRC, f)} references ${what}`);
      }
    }
  });

  test('the naive generator shares no logic with the fast one', () => {
    // The differential test is only meaningful if the two implementations are genuinely
    // independent. If naive.ts ever imports movegen.ts or attacks.ts, agreement between them
    // proves nothing at all and the whole correctness argument silently collapses.
    const naive = read(join(SRC, 'naive.ts'));
    for (const spec of importsOf(naive)) {
      assert.ok(
        !spec.includes('movegen') && !spec.includes('attacks') && !spec.includes('perft'),
        `naive.ts imports "${spec}" — it must remain an independent implementation`,
      );
    }
  });

  test('every source file uses explicit .ts import extensions', () => {
    // Required by Node's native type stripping, which is how this package stays dependency-free.
    for (const f of FILES) {
      for (const spec of importsOf(read(f))) {
        if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
        assert.ok(spec.endsWith('.ts'), `${relative(SRC, f)} imports "${spec}" without a .ts extension`);
      }
    }
  });

  test('no erasable-syntax violations (enums, namespaces, parameter properties)', () => {
    for (const f of FILES) {
      const src = read(f);
      assert.equal(/^\s*(export\s+)?(const\s+)?enum\s/m.test(src), false,
        `${relative(SRC, f)} uses an enum — not erasable syntax`);
      assert.equal(/^\s*(export\s+)?namespace\s/m.test(src), false,
        `${relative(SRC, f)} uses a namespace — not erasable syntax`);
      assert.equal(/constructor\s*\([^)]*\b(private|public|protected|readonly)\s/.test(src), false,
        `${relative(SRC, f)} uses a parameter property — not erasable syntax`);
    }
  });
});
