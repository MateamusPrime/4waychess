/**
 * Deep differential sweep — the Phase 0 correctness gate.
 *
 * Runs the fast and naive generators against each other over a large number of positions
 * reached by random play, across both modes and with random eliminations. Because there is
 * no published perft reference for four-way chess, this agreement IS our correctness argument
 * (RISKS.md R4).
 *
 *   node src/tools/differential-cli.ts [positions] [seed]
 */

import { startingPosition, serializeFen4 } from '../fen4.ts';
import { generateLegal } from '../movegen.ts';
import { isInCheck } from '../attacks.ts';
import { naiveGenerateLegal, naiveIsInCheck, moveKey } from '../naive.ts';
import { ARMIES } from '../geometry.ts';
import { FFA_RULES, TEAMS_RULES } from '../position.ts';
import type { Ruleset } from '../types.ts';

const TARGET = Number(process.argv[2] ?? 1_000_000);
const SEED = Number(process.argv[3] ?? 0xc0ffee);

function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

const rnd = makeRng(SEED);
let checked = 0;
let games = 0;
let plies = 0;
let mismatches = 0;
const started = process.hrtime.bigint();
let lastReport = started;

function elapsed(): number {
  return Number(process.hrtime.bigint() - started) / 1e9;
}

outer: while (checked < TARGET) {
  // Alternate modes and elimination behaviour so every code path gets exercised.
  const teams = games % 3 === 2;
  const rules: Ruleset = teams ? TEAMS_RULES : FFA_RULES;
  const killChance = games % 2 === 1 ? 0.03 : 0;

  const pos = startingPosition(rules);
  games++;

  for (let ply = 0; ply < 240; ply++) {
    for (const a of ARMIES) {
      const fast = generateLegal(pos, a).map(moveKey).sort();
      const slow = naiveGenerateLegal(pos, a).map(moveKey).sort();
      const same = fast.length === slow.length && fast.every((v, i) => v === slow[i]);
      const checkSame = isInCheck(pos, a) === naiveIsInCheck(pos, a);

      if (!same || !checkSame) {
        mismatches++;
        console.error(`\nMISMATCH  army=${a}  game=${games}  ply=${ply}  seed=${SEED}`);
        console.error(`FEN4: ${serializeFen4(pos)}`);
        if (!same) {
          console.error(`  only fast : ${fast.filter((m) => !slow.includes(m)).join(' ') || '(none)'}`);
          console.error(`  only naive: ${slow.filter((m) => !fast.includes(m)).join(' ') || '(none)'}`);
        }
        if (!checkSame) console.error('  check detection disagrees');
        if (mismatches >= 5) break outer;
      }
      checked++;
    }

    const now = process.hrtime.bigint();
    if (Number(now - lastReport) / 1e9 > 15) {
      lastReport = now;
      const rate = Math.round(checked / elapsed());
      const pct = ((checked / TARGET) * 100).toFixed(1);
      console.log(
        `  ${checked.toLocaleString()} / ${TARGET.toLocaleString()} (${pct}%)  ` +
        `${rate.toLocaleString()}/s  games=${games}  mismatches=${mismatches}`,
      );
    }
    if (checked >= TARGET) break;

    if (killChance > 0 && rnd() < killChance) {
      const alive = pos.activeArmies();
      if (alive.length > 2) pos.status[alive[Math.floor(rnd() * alive.length)]] = 'checkmated';
    }

    const moves = generateLegal(pos, pos.turn);
    if (moves.length === 0) break;
    pos.makeMove(moves[Math.floor(rnd() * moves.length)]);
    plies++;
    if (pos.activeArmies().length < 2) break;
  }
}

const secs = elapsed();
console.log('');
console.log(`positions checked : ${checked.toLocaleString()}`);
console.log(`games played      : ${games.toLocaleString()}`);
console.log(`plies played      : ${plies.toLocaleString()}`);
console.log(`elapsed           : ${secs.toFixed(1)}s  (${Math.round(checked / secs).toLocaleString()}/s)`);
console.log(`mismatches        : ${mismatches}`);
console.log(mismatches === 0 ? '\nRESULT: PASS — generators agree everywhere.' : '\nRESULT: FAIL');
process.exit(mismatches === 0 ? 0 : 1);
