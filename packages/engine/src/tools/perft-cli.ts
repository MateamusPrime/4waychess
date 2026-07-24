/**
 * Perft driver.
 *
 *   node src/tools/perft-cli.ts [maxDepth] [--divide N] [--teams]
 *
 * Baselines produced here are frozen into the test suite. They are not externally verified —
 * no reference data exists for four-way chess — but any change to move generation that moves
 * them is caught immediately and has to be justified.
 */

import { startingPosition } from '../fen4.ts';
import { perft, perftDetailed, perftDivide, plyOrder } from '../perft.ts';
import { FFA_RULES, TEAMS_RULES } from '../position.ts';
import { squareName } from '../geometry.ts';

const args = process.argv.slice(2);
const teams = args.includes('--teams');
const divideAt = args.includes('--divide') ? Number(args[args.indexOf('--divide') + 1]) : 0;
const maxDepth = Number(args.find((a) => /^\d+$/.test(a)) ?? 4);

const rules = teams ? TEAMS_RULES : FFA_RULES;
console.log(`ruleset: ${rules.id}`);
console.log(`ply order from the start: ${plyOrder(startingPosition(rules), maxDepth).join(' -> ')}\n`);

console.log('depth      nodes   captures   ep  castles  promos      time');
console.log('----- ---------- ---------- ---- -------- ------- ---------');
for (let d = 1; d <= maxDepth; d++) {
  const pos = startingPosition(rules);
  const t0 = process.hrtime.bigint();
  const detail = perftDetailed(pos, d);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(
    String(d).padStart(5) +
    String(detail.nodes).padStart(11) +
    String(detail.captures).padStart(11) +
    String(detail.enPassant).padStart(5) +
    String(detail.castles).padStart(9) +
    String(detail.promotions).padStart(8) +
    `${ms.toFixed(0)}ms`.padStart(10),
  );
}

if (divideAt > 0) {
  console.log(`\ndivide at depth ${divideAt}:`);
  const pos = startingPosition(rules);
  const div = perftDivide(pos, divideAt);
  const rows = [...div.entries()].sort((a, b) => b[1] - a[1]);
  for (const [key, n] of rows) {
    const [from, rest] = key.split('-');
    const to = rest.replace(/[a-z]$/, '');
    console.log(`  ${squareName(Number(from))}-${squareName(Number(to))}  ${n}`);
  }
  console.log(`  total ${[...div.values()].reduce((a, b) => a + b, 0)}`);
}

void perft;
