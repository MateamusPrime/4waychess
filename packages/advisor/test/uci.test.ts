import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseInfo, parseOption, selectLines } from '../src/uci.ts';
import type { SearchLine } from '../src/uci.ts';

describe('uci parsing', () => {
  test('parses a full info line', () => {
    const info = parseInfo('info depth 14 seldepth 22 multipv 2 score cp -35 wdl 120 700 180 nodes 123456 nps 987654 hashfull 12 time 125 pv e7e5 g1f3 b8c6');
    assert.deepEqual(info, {
      depth: 14, seldepth: 22, multipv: 2, score: { type: 'cp', value: -35 }, wdl: [120, 700, 180],
      nodes: 123456, nps: 987654, hashfull: 12, time: 125, pv: ['e7e5', 'g1f3', 'b8c6'],
    });
  });

  test('parses mate scores and bounds', () => {
    assert.deepEqual(parseInfo('info depth 5 score mate -2 pv a1a2')?.score, { type: 'mate', value: -2 });
    const lb = parseInfo('info depth 9 multipv 1 score cp 40 lowerbound nodes 10 pv e2e4');
    assert.equal(lb?.bound, 'lower');
    assert.equal(lb?.nodes, 10);
  });

  test('info string lines and non-info lines', () => {
    assert.deepEqual(parseInfo('info string NNUE evaluation using nn.nnue'), { string: 'NNUE evaluation using nn.nnue' });
    assert.equal(parseInfo('bestmove e2e4 ponder e7e5'), null);
    assert.equal(parseInfo('readyok'), null);
  });

  test('parses option lines', () => {
    assert.deepEqual(parseOption('option name MultiPV type spin default 1 min 1 max 256'), {
      name: 'MultiPV', type: 'spin', default: '1', min: 1, max: 256,
    });
    assert.deepEqual(parseOption('option name UCI_ShowWDL type check default false'), {
      name: 'UCI_ShowWDL', type: 'check', default: 'false',
    });
    assert.deepEqual(parseOption('option name SyzygyPath type string default <empty>'), {
      name: 'SyzygyPath', type: 'string', default: '<empty>',
    });
    assert.equal(parseOption('uciok'), null);
  });
});

const line = (depth: number, multipv: number, move: string, cp: number): SearchLine =>
  ({ depth, multipv, score: { type: 'cp', value: cp }, pv: [move] });

describe('selectLines', () => {
  test('reports the last batch in slot order with the shallowest depth', () => {
    const r = selectLines([line(11, 1, 'e2e4', 32), line(10, 2, 'd2d4', 25), line(10, 3, 'g1f3', 20)], 'e2e4');
    assert.equal(r.depth, 10);
    assert.deepEqual(r.lines.map((l) => l.pv[0]), ['e2e4', 'd2d4', 'g1f3']);
    assert.deepEqual(r.lines.map((l) => l.multipv), [1, 2, 3]);
  });

  test('a move that landed in two slots is reported once, at its better rank', () => {
    // Slot 1 finished depth 15 with e1g1; slots 2-3 were reprinted at depth 14 in the new
    // order, and c2c3 (the old slot 1) is now also slot 2.
    const r = selectLines([line(14, 1, 'c2c3', 13), line(14, 2, 'c2c3', 13), line(14, 3, 'd2d3', 11)], 'c2c3');
    assert.deepEqual(r.lines.map((l) => l.pv[0]), ['c2c3', 'd2d3']);
    assert.deepEqual(r.lines.map((l) => l.multipv), [1, 2]);
  });

  test('bestmove is put first if the batch disagrees', () => {
    const r = selectLines([line(10, 1, 'b2b3', 30), line(10, 2, 'c2c3', 25), line(10, 3, 'd2d3', 20)], 'c2c3');
    assert.deepEqual(r.lines.map((l) => l.pv[0]), ['c2c3', 'b2b3', 'd2d3']);
    assert.equal(r.lines[0].score.value, 25);
  });

  test('empty and none cases', () => {
    assert.deepEqual(selectLines([], null), { lines: [], depth: 0 });
    assert.deepEqual(selectLines([line(5, 1, 'a1a2', 0)], null).lines.map((l) => l.pv[0]), ['a1a2']);
  });
});
