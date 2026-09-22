import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseInfo, parseOption } from '../src/uci.ts';

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
