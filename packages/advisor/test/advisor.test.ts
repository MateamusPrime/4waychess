/**
 * Integration tests against the bundled WASM Stockfish (lite, single-threaded) at low depth.
 * Each search is a few milliseconds; the whole file runs in a couple of seconds.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openEngine } from '../src/engine.ts';
import type { UciEngine } from '../src/uci.ts';
import { Advisor } from '../src/advisor.ts';
import { reviewPgn, splitPgn } from '../src/review.ts';

let engine: UciEngine;
before(async () => { engine = await openEngine({ flavor: 'lite-single', hashMb: 16 }); });
after(async () => { await engine.quit(); });

describe('engine', () => {
  test('handshake exposes identity and MultiPV', () => {
    assert.match(engine.identity.name, /Stockfish/);
    assert.ok(engine.hasOption('MultiPV'));
  });

  test('a search returns one line per MultiPV slot at a common depth', async () => {
    await engine.setOption('MultiPV', 3);
    engine.position('startpos', []);
    const r = await engine.go({ depth: 8 });
    assert.equal(r.lines.length, 3);
    assert.deepEqual(r.lines.map((l) => l.multipv), [1, 2, 3]);
    assert.ok(r.lines.every((l) => l.depth === r.depth));
    assert.equal(r.lines[0].pv[0], r.bestmove);
  });

  test('a mated position reports no best move', async () => {
    await engine.setOption('MultiPV', 1);
    engine.position('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3', []);
    const r = await engine.go({ depth: 4 });
    assert.equal(r.bestmove, null);
  });
});

describe('advisor', () => {
  test('analysis lists ranked candidates with SAN and win probabilities', async () => {
    const adv = new Advisor({ engine, multipv: 3, limits: { depth: 8 } });
    const a = await adv.analyse();
    assert.equal(a.turn, 'w');
    assert.equal(a.candidates.length, 3);
    assert.equal(a.candidates[0].rank, 1);
    assert.equal(a.candidates[0].lossVsBest, 0);
    assert.ok(a.candidates[1].lossVsBest >= 0);
    assert.match(a.candidates[0].san, /^[a-hNBRQK]/);
    assert.ok(a.winPct > 40 && a.winPct < 70);
    assert.equal(a.best, a.candidates[0]);
    // Cached: same object back.
    assert.equal(await adv.analyse(), a);
  });

  test('candidates are capped by the number of legal moves', async () => {
    // King in the corner with a single legal move.
    const adv = new Advisor({ engine, multipv: 5, limits: { depth: 6 }, fen: 'k7/8/1K6/8/8/8/8/7R b - - 0 1' });
    const a = await adv.analyse();
    assert.equal(a.candidates.length, 1);
    assert.equal(a.candidates[0].san, 'Kb8');
  });

  test('hanging the queen is graded a blunder; the best move is graded best', async () => {
    const adv = new Advisor({ engine, multipv: 3, limits: { depth: 8 } });
    await adv.play('e4');
    await adv.play('e5');
    const good = await adv.play('Nf3');
    assert.equal(good.color, 'w');
    assert.ok(['best', 'good'].includes(good.classification), good.classification);
    await adv.play('Nc6');
    await adv.play('d4');
    await adv.play('exd4');
    // Qh5 lets the knight come with tempo... but hang it outright instead.
    const blunder = await adv.play('Qxd4');
    assert.equal(blunder.san, 'Qxd4');
    assert.ok(blunder.loss > 0);
    const worse = await adv.play('Nxd4');
    assert.equal(worse.color, 'b');
    // Now White just lost a queen for a knight: previous move was the real blunder.
    assert.equal(adv.reports.at(-2)?.classification, 'blunder');
    assert.equal(worse.classification, 'best');
    assert.equal(adv.reports.length, 8);
    const s = adv.summary();
    assert.equal(s.w.moves, 4);
    assert.equal(s.b.moves, 4);
    assert.equal(s.w.counts.blunder, 1);
    assert.ok(s.b.accuracy > s.w.accuracy);
  });

  test('reset to a FEN analyses that position, not the original start', async () => {
    const adv = new Advisor({ engine, multipv: 2, limits: { depth: 6 } });
    await adv.play('e4');
    adv.reset('k7/8/1K6/8/8/8/8/7R b - - 0 1');
    assert.equal(adv.ply(), 0);
    assert.equal(adv.reports.length, 0);
    const a = await adv.analyse();
    assert.equal(a.turn, 'b');
    assert.deepEqual(a.candidates.map((c) => c.san), ['Kb8']);
    await adv.play('Kb8');
    const mate = await adv.play('Rh8#');
    assert.equal(mate.winPctAfter, 100);
    adv.reset();
    assert.equal(adv.fen(), 'k7/8/1K6/8/8/8/8/7R b - - 0 1');
  });

  test('abort cuts a running analysis short and leaves the game consistent', async () => {
    const adv = new Advisor({ engine, multipv: 3, limits: { movetime: 3000 }, trapDepth: 3 });
    const first = adv.analyse();
    adv.abort();
    await assert.rejects(first, (e: Error) => e.name === 'AnalysisAborted');
    // A play whose grading is aborted is rolled back.
    const p = adv.play('e4');
    await new Promise((r) => setTimeout(r, 30));
    adv.abort();
    await assert.rejects(p, (e: Error) => e.name === 'AnalysisAborted');
    assert.equal(adv.ply(), 0);
    assert.equal(adv.reports.length, 0);
    // Subsequent calls work normally.
    adv.limits = { depth: 6 };
    const a = await adv.analyse();
    assert.equal(a.candidates.length, 3);
  });

  test('rejects illegal moves without changing state', async () => {
    const adv = new Advisor({ engine, multipv: 1, limits: { depth: 4 } });
    await assert.rejects(() => adv.play('Ke2'), /illegal move/);
    assert.equal(adv.ply(), 0);
    assert.equal(adv.reports.length, 0);
  });

  test('undo removes the move and its report', async () => {
    const adv = new Advisor({ engine, multipv: 1, limits: { depth: 4 } });
    await adv.play('e4');
    assert.equal(adv.reports.length, 1);
    adv.undo();
    assert.equal(adv.ply(), 0);
    assert.equal(adv.reports.length, 0);
  });

  test('checkmate produces a terminal analysis and a mate score for the mover', async () => {
    const adv = new Advisor({ engine, multipv: 2, limits: { depth: 6 } });
    for (const m of ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6']) await adv.play(m);
    const mate = await adv.play('Qxf7#');
    assert.deepEqual(mate.scoreAfter, { type: 'mate', value: 0 });
    assert.equal(mate.winPctAfter, 100);
    assert.equal(mate.classification, 'best');
    const a = await adv.analyse();
    assert.equal(a.gameOver, true);
    assert.equal(a.candidates.length, 0);
  });

  test('trap detection flags a capture that loses at depth', async () => {
    // Légal-style bait: after 1.e4 e5 2.Nf3 d6 3.Bc4 Bg4 4.Nc3 g6 5.Nxe5 Bxd1?? 6.Bxf7+ Ke7 7.Nd5#.
    // Black to move after 5.Nxe5: taking the queen looks winning shallowly and loses to mate.
    const fen = 'rn1qkbnr/ppp2p1p/3p2p1/4N3/2B1P1b1/2N5/PPPP1PPP/R1BQK2R b KQkq - 0 5';
    const adv = new Advisor({ engine, multipv: 2, limits: { depth: 12 }, trapDepth: 1, trapThreshold: 10, fen });
    const a = await adv.analyse();
    const trap = a.traps.find((t) => t.san === 'Bxd1');
    assert.ok(trap, `expected Bxd1 to be a trap, got ${JSON.stringify(a.traps)}`);
    assert.ok(trap.drop >= 10);
    assert.equal(trap.deepScore.type, 'mate');
    const r = await adv.play('Bxd1');
    assert.equal(r.fellForTrap, true);
    assert.equal(r.classification, 'blunder');
  });
});

describe('review', () => {
  test('splits multi-game PGN text', () => {
    const text = '[Event "A"]\n[Result "1-0"]\n\n1. e4 e5 1-0\n\n[Event "B"]\n\n1. d4 *\n';
    const games = splitPgn(text);
    assert.equal(games.length, 2);
    assert.match(games[0], /Event "A"/);
    assert.match(games[1], /Event "B"/);
  });

  test('reviews a whole game and finds the losing move', async () => {
    const pgn = '[Event "Test"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n' +
      '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0';
    const seen: number[] = [];
    const r = await reviewPgn(pgn, { engine, multipv: 2, limits: { depth: 8 }, onMove: (_m, i) => seen.push(i) });
    assert.equal(r.headers.White, 'A');
    assert.equal(r.reports.length, 7);
    assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6]);
    const nf6 = r.reports[5];
    assert.equal(nf6.san, 'Nf6');
    assert.equal(nf6.classification, 'blunder');
    assert.equal(r.reports[6].classification, 'best');
    assert.ok(r.summary.b.counts.blunder >= 1);
  });

  test('a PGN with a FEN header reviews from that position', async () => {
    const pgn = '[FEN "k7/8/1K6/8/8/8/8/7R b - - 0 1"]\n[SetUp "1"]\n\n1... Kb8 2. Rh8# *';
    const r = await reviewPgn(pgn, { engine, multipv: 1, limits: { depth: 6 } });
    assert.equal(r.reports.length, 2);
    assert.equal(r.reports[1].san, 'Rh8#');
    assert.deepEqual(r.reports[1].scoreAfter, { type: 'mate', value: 0 });
  });
});
