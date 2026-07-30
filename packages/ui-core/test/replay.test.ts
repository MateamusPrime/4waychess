import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARMIES, FFA_RULES, Game, TEAMS_RULES, parseFen4, serializeFen4, writePgn4,
} from '@4wc/engine';
import type { Ruleset } from '@4wc/engine';
import {
  atEnd, atStart, loadReplay, roundOf, seek, step, toEnd, toStart,
} from '../src/replay.ts';

function playGame(plies: number, rules: Ruleset = FFA_RULES, seed = 4242): Game {
  let s = seed;
  const rnd = (n: number): number => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s % n;
  };
  const g = Game.create(rules);
  g.startingFen = serializeFen4(g.pos);
  for (let i = 0; i < plies && !g.result().over; i++) {
    const ms = g.legalMoves();
    if (ms.length === 0) break;
    g.play(ms[rnd(ms.length)]);
  }
  return g;
}

describe('replay reconstructs a finished game', () => {
  test('seeking to the end reproduces the original position and points exactly', () => {
    const played = playGame(60);
    const r = toEnd(loadReplay(writePgn4(played)));
    assert.equal(r.ply, played.moves.length);
    assert.equal(serializeFen4(r.position), serializeFen4(played.pos));
    for (const a of ARMIES) assert.equal(r.points[a], played.pos.points[a], `${a} points`);
  });

  test('it starts at ply 0 with the untouched start position and zero points', () => {
    const played = playGame(40);
    const r = loadReplay(writePgn4(played));
    assert.equal(r.ply, 0);
    assert.equal(atStart(r), true);
    assert.equal(r.lastMove, null);
    assert.equal(serializeFen4(r.position), played.startingFen);
    for (const a of ARMIES) assert.equal(r.points[a], 0);
  });

  test('points accrue as the replay advances, matching the real game at every ply', () => {
    // Replaying a scoring game must show the score CHANGING, not the final total from ply 0.
    const played = playGame(80);
    const r = loadReplay(writePgn4(played));
    const check = new Game(parseFen4(played.startingFen, played.rules), played.startingFen);

    let cursor = r;
    let sawScoring = false;
    for (let i = 0; i < played.moves.length; i++) {
      check.play(played.moves[i]);
      cursor = step(cursor, 1);
      for (const a of ARMIES) {
        assert.equal(cursor.points[a], check.pos.points[a], `ply ${i + 1} ${a}`);
      }
      if (ARMIES.some((a) => cursor.points[a] > 0)) sawScoring = true;
    }
    assert.ok(sawScoring, 'the fixture must actually score, or this proves nothing');
  });

  test('seeking is absolute and clamped at both ends', () => {
    const played = playGame(30);
    const r = loadReplay(writePgn4(played));
    assert.equal(seek(r, -50).ply, 0);
    assert.equal(seek(r, 9999).ply, played.moves.length);
    assert.equal(seek(r, 7).ply, 7);
    assert.equal(seek(seek(r, 7), 3).ply, 3, 'seeking backwards works, not just forwards');
  });

  test('stepping forwards then back returns the identical position', () => {
    // The reason replay rebuilds from the start rather than unwinding: Game is forward-only,
    // so "step back" means "replay fewer moves", and this proves the round trip is exact.
    const played = playGame(40);
    const at12 = seek(loadReplay(writePgn4(played)), 12);
    const wandered = step(step(at12, 5), -5);
    assert.equal(wandered.ply, 12);
    assert.equal(serializeFen4(wandered.position), serializeFen4(at12.position));
    assert.deepEqual(wandered.points, at12.points);
    assert.equal(wandered.lastMove?.to, at12.lastMove?.to);
  });

  test('lastMove tracks the move that produced the current position', () => {
    const played = playGame(20);
    const r = loadReplay(writePgn4(played));
    assert.equal(r.lastMove, null);
    const one = step(r, 1);
    assert.equal(one.lastMove?.from, played.moves[0].from);
    assert.equal(one.lastMove?.to, played.moves[0].to);
    const five = seek(r, 5);
    assert.equal(five.lastMove?.to, played.moves[4].to);
  });

  test('atStart and atEnd bracket the range', () => {
    const r = loadReplay(writePgn4(playGame(16)));
    assert.equal(atStart(r), true);
    assert.equal(atEnd(r), false);
    assert.equal(atEnd(toEnd(r)), true);
    assert.equal(atStart(toStart(toEnd(r))), true);
  });

  test('notation and movers line up with the move list', () => {
    const played = playGame(24);
    const r = loadReplay(writePgn4(played));
    assert.equal(r.notation.length, played.moves.length);
    assert.equal(r.movers.length, played.moves.length);
    assert.deepEqual(r.movers.slice(0, 4), ['red', 'blue', 'yellow', 'green']);
    assert.ok(r.notation[0].length > 0);
  });

  test('Teams games replay under their own ruleset', () => {
    const played = playGame(60, TEAMS_RULES, 777);
    const r = toEnd(loadReplay(writePgn4(played)));
    assert.equal(r.rules.promotionRank, 11, 'the ruleset travels with the replay');
    assert.equal(serializeFen4(r.position), serializeFen4(played.pos));
  });

  test('a game with no moves is a valid, inert replay', () => {
    const empty = Game.create(FFA_RULES);
    empty.startingFen = serializeFen4(empty.pos);
    const r = loadReplay(writePgn4(empty));
    assert.equal(r.moves.length, 0);
    assert.equal(atStart(r), true);
    assert.equal(atEnd(r), true, 'start and end coincide');
    assert.equal(step(r, 1).ply, 0);
  });
});

describe('round mapping for the move list', () => {
  test('four plies per round, seats in turn order', () => {
    assert.deepEqual(roundOf(0), { round: 1, seat: 0 });
    assert.deepEqual(roundOf(3), { round: 1, seat: 3 });
    assert.deepEqual(roundOf(4), { round: 2, seat: 0 });
    assert.deepEqual(roundOf(7), { round: 2, seat: 3 });
  });
});
