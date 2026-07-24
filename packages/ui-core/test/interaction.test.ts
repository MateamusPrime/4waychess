import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FFA_RULES, Position, TEAMS_RULES, generateLegal, parseSquare, squareName, startingPosition,
} from '@4wc/engine';
import type { Army, PieceType, Ruleset } from '@4wc/engine';
import {
  INITIAL_INTERACTION, cancel, choosePromotion, observeMove, selectedSquare, tapSquare, targetsOf,
} from '../src/interaction.ts';
import type { InteractionContext } from '../src/interaction.ts';

function build(pieces: Record<string, string>, rules: Ruleset = FFA_RULES): Position {
  const p = new Position(rules);
  const LET: Record<string, Army> = { r: 'red', b: 'blue', y: 'yellow', g: 'green' };
  for (const [sq, tok] of Object.entries(pieces)) {
    p.put(parseSquare(sq), LET[tok[0]], tok[1].toLowerCase() as PieceType);
  }
  p.castling = {
    red: { short: false, long: false }, blue: { short: false, long: false },
    yellow: { short: false, long: false }, green: { short: false, long: false },
  };
  return p;
}

const FAR_KINGS = { d3: 'rK', a4: 'bK', k12: 'yK', n11: 'gK' } as const;

const ctxFor = (pos: Position, controllable: Army[] = ['red', 'blue', 'yellow', 'green']):
InteractionContext => ({ position: pos, seat: 'red', controllable });

const sq = (name: string) => parseSquare(name);

describe('tap to select', () => {
  test('tapping your own piece selects it and exposes its legal moves', () => {
    const ctx = ctxFor(startingPosition());
    const step = tapSquare(ctx, INITIAL_INTERACTION, sq('g2'));
    assert.equal(step.intent.kind, 'none');
    assert.equal(step.state.selection.kind, 'piece');
    assert.equal(selectedSquare(step.state), sq('g2'));
    const { quiet, captures } = targetsOf(ctx, step.state);
    assert.deepEqual(quiet.map(squareName).sort(), ['g3', 'g4']);
    assert.deepEqual(captures, []);
  });

  test('tapping an empty square selects nothing but still moves the cursor', () => {
    const ctx = ctxFor(startingPosition());
    const step = tapSquare(ctx, INITIAL_INTERACTION, sq('g6'));
    assert.equal(step.state.selection.kind, 'none');
    assert.equal(step.state.cursor, sq('g6'));
  });

  test('tapping an opponent piece does not select it', () => {
    const ctx = ctxFor(startingPosition());
    const step = tapSquare(ctx, INITIAL_INTERACTION, sq('b7'));
    assert.equal(step.state.selection.kind, 'none');
  });

  test('a piece with no legal moves deselects cleanly rather than appearing stuck', () => {
    const ctx = ctxFor(startingPosition());
    const step = tapSquare(ctx, INITIAL_INTERACTION, sq('d1')); // rook, hemmed in
    assert.equal(generateLegal(ctx.position, 'red').filter((m) => m.from === sq('d1')).length, 0);
    assert.equal(step.state.selection.kind, 'none');
  });

  test('tapping the selected square again deselects', () => {
    const ctx = ctxFor(startingPosition());
    const a = tapSquare(ctx, INITIAL_INTERACTION, sq('g2'));
    const b = tapSquare(ctx, a.state, sq('g2'));
    assert.equal(b.state.selection.kind, 'none');
    assert.equal(b.intent.kind, 'none');
  });

  test('tapping another of your own pieces reselects instead of deselecting', () => {
    const ctx = ctxFor(startingPosition());
    const a = tapSquare(ctx, INITIAL_INTERACTION, sq('g2'));
    const b = tapSquare(ctx, a.state, sq('e1'));
    assert.equal(b.state.selection.kind, 'piece');
    assert.equal(selectedSquare(b.state), sq('e1'));
    assert.equal(b.intent.kind, 'none');
  });

  test('tapping a non-target empty square deselects', () => {
    const ctx = ctxFor(startingPosition());
    const a = tapSquare(ctx, INITIAL_INTERACTION, sq('g2'));
    const b = tapSquare(ctx, a.state, sq('h9'));
    assert.equal(b.state.selection.kind, 'none');
    assert.equal(b.intent.kind, 'none');
  });

  test('taps on non-squares are ignored entirely', () => {
    const ctx = ctxFor(startingPosition());
    const step = tapSquare(ctx, INITIAL_INTERACTION, -1);
    assert.deepEqual(step.state, INITIAL_INTERACTION);
  });
});

describe('tap to move', () => {
  test('tapping a legal target produces a play intent and clears the selection', () => {
    const ctx = ctxFor(startingPosition());
    const a = tapSquare(ctx, INITIAL_INTERACTION, sq('g2'));
    const b = tapSquare(ctx, a.state, sq('g4'));
    assert.equal(b.intent.kind, 'play');
    if (b.intent.kind !== 'play') throw new Error('unreachable');
    assert.equal(squareName(b.intent.move.from), 'g2');
    assert.equal(squareName(b.intent.move.to), 'g4');
    assert.equal(b.state.selection.kind, 'none');
    assert.equal(b.state.lastMove, b.intent.move, 'the move is recorded for highlighting');
  });

  test('captures are reported separately from quiet moves', () => {
    const pos = build({ ...FAR_KINGS, h5: 'rR', h8: 'yQ' });
    const ctx = ctxFor(pos);
    const a = tapSquare(ctx, INITIAL_INTERACTION, sq('h5'));
    const { quiet, captures } = targetsOf(ctx, a.state);
    assert.deepEqual(captures.map(squareName), ['h8']);
    assert.ok(quiet.length > 0);
    assert.equal(quiet.includes(sq('h8')), false);
  });
});

describe('promotion', () => {
  test('a single promotion option plays immediately in FFA', () => {
    const ctx = ctxFor(build({ ...FAR_KINGS, g7: 'rP' }));
    const a = tapSquare(ctx, INITIAL_INTERACTION, sq('g7'));
    const b = tapSquare(ctx, a.state, sq('g8'));
    assert.equal(b.intent.kind, 'play');
    if (b.intent.kind !== 'play') throw new Error('unreachable');
    assert.equal(b.intent.move.promotion, 'q');
  });

  test('Teams underpromotion opens a picker rather than guessing', () => {
    const ctx = ctxFor(build({ ...FAR_KINGS, g10: 'rP' }, TEAMS_RULES));
    const a = tapSquare(ctx, INITIAL_INTERACTION, sq('g10'));
    const b = tapSquare(ctx, a.state, sq('g11'));
    assert.equal(b.intent.kind, 'need-promotion');
    assert.equal(b.state.selection.kind, 'promotion');
    if (b.intent.kind !== 'need-promotion') throw new Error('unreachable');
    assert.deepEqual(b.intent.options.map((m) => m.promotion).sort(), ['b', 'n', 'q', 'r']);
  });

  test('board taps are ignored while the picker is open', () => {
    const ctx = ctxFor(build({ ...FAR_KINGS, g10: 'rP' }, TEAMS_RULES));
    const a = tapSquare(ctx, INITIAL_INTERACTION, sq('g10'));
    const b = tapSquare(ctx, a.state, sq('g11'));
    const c = tapSquare(ctx, b.state, sq('d3'));
    assert.deepEqual(c.state, b.state, 'a stray tap must not choose a piece type');
    assert.equal(c.intent.kind, 'none');
  });

  test('choosing a promotion plays that exact move', () => {
    const ctx = ctxFor(build({ ...FAR_KINGS, g10: 'rP' }, TEAMS_RULES));
    const a = tapSquare(ctx, INITIAL_INTERACTION, sq('g10'));
    const b = tapSquare(ctx, a.state, sq('g11'));
    const c = choosePromotion(b.state, 'n');
    assert.equal(c.intent.kind, 'play');
    if (c.intent.kind !== 'play') throw new Error('unreachable');
    assert.equal(c.intent.move.promotion, 'n');
    assert.equal(c.state.selection.kind, 'none');
  });

  test('an unknown promotion choice is refused, leaving the picker open', () => {
    const ctx = ctxFor(build({ ...FAR_KINGS, g10: 'rP' }, TEAMS_RULES));
    const a = tapSquare(ctx, INITIAL_INTERACTION, sq('g10'));
    const b = tapSquare(ctx, a.state, sq('g11'));
    const c = choosePromotion(b.state, 'k');
    assert.equal(c.intent.kind, 'none');
    assert.equal(c.state.selection.kind, 'promotion');
  });

  test('choosePromotion on a non-promotion state is a no-op', () => {
    assert.equal(choosePromotion(INITIAL_INTERACTION, 'q').intent.kind, 'none');
  });
});

describe('control and view-only mode', () => {
  test('a spectator can move the cursor but never select a piece', () => {
    const ctx = ctxFor(startingPosition(), []);
    const step = tapSquare(ctx, INITIAL_INTERACTION, sq('g2'));
    assert.equal(step.state.selection.kind, 'none');
    assert.equal(step.state.cursor, sq('g2'), 'the board stays navigable and readable');
  });

  test('you cannot move for a seat you do not control', () => {
    const pos = startingPosition();
    const ctx: InteractionContext = { position: pos, seat: 'red', controllable: ['blue'] };
    const step = tapSquare(ctx, INITIAL_INTERACTION, sq('g2'));
    assert.equal(step.state.selection.kind, 'none', 'Red is on move but Blue is controlled');
  });

  test('hotseat controls every seat in turn', () => {
    const pos = startingPosition();
    const ctx = ctxFor(pos);
    const a = tapSquare(ctx, INITIAL_INTERACTION, sq('g2'));
    const b = tapSquare(ctx, a.state, sq('g4'));
    if (b.intent.kind !== 'play') throw new Error('unreachable');
    pos.makeMove(b.intent.move);
    assert.equal(pos.turn, 'blue');
    const c = tapSquare(ctx, b.state, sq('b7'));
    assert.equal(c.state.selection.kind, 'piece', 'Blue can now be selected');
  });
});

describe('cancel and observation', () => {
  test('cancel clears a selection', () => {
    const ctx = ctxFor(startingPosition());
    const a = tapSquare(ctx, INITIAL_INTERACTION, sq('g2'));
    assert.equal(cancel(a.state).state.selection.kind, 'none');
  });

  test('cancel closes an open promotion picker', () => {
    const ctx = ctxFor(build({ ...FAR_KINGS, g10: 'rP' }, TEAMS_RULES));
    const a = tapSquare(ctx, INITIAL_INTERACTION, sq('g10'));
    const b = tapSquare(ctx, a.state, sq('g11'));
    assert.equal(cancel(b.state).state.selection.kind, 'none');
  });

  test('cancel on an empty selection returns the identical object', () => {
    assert.equal(cancel(INITIAL_INTERACTION).state, INITIAL_INTERACTION);
  });

  test('observeMove records an opponent move and clears any local selection', () => {
    const pos = startingPosition();
    const ctx = ctxFor(pos);
    const a = tapSquare(ctx, INITIAL_INTERACTION, sq('g2'));
    const move = generateLegal(pos, 'red')[0];
    const s = observeMove(a.state, move);
    assert.equal(s.selection.kind, 'none');
    assert.equal(s.lastMove, move);
  });
});

describe('a full hotseat round drives cleanly', () => {
  test('four seats each select and move in turn order', () => {
    const pos = startingPosition();
    const ctx = ctxFor(pos);
    let state = INITIAL_INTERACTION;
    const played: string[] = [];

    for (const [from, to] of [
      ['g2', 'g4'], ['b7', 'd7'], ['h13', 'h11'], ['m8', 'k8'],
    ] as [string, string][]) {
      const pick = tapSquare(ctx, state, sq(from));
      assert.equal(pick.state.selection.kind, 'piece', `select ${from}`);
      const play = tapSquare(ctx, pick.state, sq(to));
      assert.equal(play.intent.kind, 'play', `${from}-${to}`);
      if (play.intent.kind !== 'play') throw new Error('unreachable');
      pos.makeMove(play.intent.move);
      state = observeMove(play.state, play.intent.move);
      played.push(`${from}-${to}`);
    }

    assert.deepEqual(played, ['g2-g4', 'b7-d7', 'h13-h11', 'm8-k8']);
    assert.equal(pos.turn, 'red', 'back round to Red after one full round');
    assert.equal(pos.ply, 4);
  });
});
