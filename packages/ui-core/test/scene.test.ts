import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARMIES, FFA_RULES, Position, SQUARES, generateLegal, parseSquare, squareName, startingPosition,
} from '@4wc/engine';
import type { Army, PieceType, Ruleset } from '@4wc/engine';
import { THEMES, THEME_IDS, COLORBLIND_ARMIES } from '../src/themes.ts';
import { computeLayout, rectCenter, squareRect } from '../src/layout.ts';
import { INITIAL_INTERACTION, tapSquare, observeMove } from '../src/interaction.ts';
import { rotationSteps } from '../src/view.ts';
import { DURATION, NO_ANIMS, add, moveAnimFor } from '../src/animation.ts';
import { buildScene, commandsWithRole, roleOrder, withAlpha } from '../src/scene.ts';
import type { Role, Scene, SceneInput } from '../src/scene.ts';

const VP = { width: 900, height: 900 };

function build(pieces: Record<string, string>, rules: Ruleset = FFA_RULES): Position {
  const p = new Position(rules);
  const LET: Record<string, Army> = { r: 'red', b: 'blue', y: 'yellow', g: 'green' };
  for (const [sq, tok] of Object.entries(pieces)) {
    p.put(parseSquare(sq), LET[tok[0]], tok[1].toLowerCase() as PieceType);
  }
  return p;
}

function input(over: Partial<SceneInput> = {}): SceneInput {
  const position = over.ctx?.position ?? startingPosition();
  const theme = over.theme ?? THEMES.midnight;
  return {
    ctx: over.ctx ?? { position, seat: 'red', controllable: ['red'] },
    layout: over.layout ?? computeLayout(VP, theme),
    theme,
    interaction: over.interaction ?? INITIAL_INTERACTION,
    anims: over.anims ?? NO_ANIMS,
    now: over.now ?? 0,
    colorblind: over.colorblind ?? false,
    showCoords: over.showCoords ?? true,
    checked: over.checked ?? [],
  };
}

const roles = (s: Scene): Set<Role> => new Set(s.commands.map((c) => c.role));

describe('scene structure', () => {
  test('draws exactly 160 squares and 64 pieces at the opening', () => {
    const s = buildScene(input());
    const squares = commandsWithRole(s, 'square-light').length + commandsWithRole(s, 'square-dark').length;
    assert.equal(squares, 160);
    assert.equal(commandsWithRole(s, 'piece').length, 64);
  });

  test('light and dark squares alternate in the expected proportion', () => {
    const s = buildScene(input());
    const dark = commandsWithRole(s, 'square-dark').length;
    const light = commandsWithRole(s, 'square-light').length;
    assert.equal(dark + light, 160);
    assert.ok(Math.abs(dark - light) <= 2, `${dark} dark vs ${light} light`);
  });

  test('layering puts the frame first, then squares, then pieces, then indicators', () => {
    const pos = startingPosition();
    const ctx = { position: pos, seat: 'red' as Army, controllable: ['red'] as Army[] };
    const sel = tapSquare(ctx, INITIAL_INTERACTION, parseSquare('g2'));
    const s = buildScene(input({ ctx, interaction: sel.state }));
    const order = roleOrder(s);

    const firstIndex = (r: Role) => order.indexOf(r);
    assert.equal(order[0], 'board-frame');
    assert.ok(firstIndex('square-dark') < firstIndex('piece'), 'squares beneath pieces');
    assert.ok(firstIndex('highlight-selected') < firstIndex('piece'), 'highlights beneath pieces');
    // Move dots must sit ABOVE pieces so a capture target is unambiguous.
    assert.ok(firstIndex('legal-dot') > firstIndex('piece'), 'dots above pieces');
    assert.ok(firstIndex('coord-file') > firstIndex('piece'), 'coordinates above pieces');
  });

  test('every command lands inside the board box', () => {
    const s = buildScene(input());
    const l = computeLayout(VP, THEMES.midnight);
    const pad = 2;
    for (const c of s.commands) {
      if (c.kind === 'rect' || c.kind === 'outline' || c.kind === 'piece') {
        assert.ok(c.rect.x >= l.board.x - pad && c.rect.y >= l.board.y - pad, c.role);
        assert.ok(c.rect.x + c.rect.w <= l.board.x + l.board.w + pad, c.role);
        assert.ok(c.rect.y + c.rect.h <= l.board.y + l.board.h + pad, c.role);
      }
    }
  });

  test('no command carries a NaN coordinate', () => {
    for (const id of THEME_IDS) {
      const s = buildScene(input({ theme: THEMES[id] }));
      for (const c of s.commands) {
        for (const v of Object.values(c)) {
          if (typeof v === 'number') assert.ok(Number.isFinite(v), `${id} ${c.role}`);
          if (typeof v === 'object' && v !== null) {
            for (const n of Object.values(v)) {
              if (typeof n === 'number') assert.ok(Number.isFinite(n), `${id} ${c.role}`);
            }
          }
        }
      }
    }
  });

  test('pieces are drawn where hit-testing says they are', () => {
    const s = buildScene(input());
    const l = computeLayout(VP, THEMES.midnight);
    const pos = startingPosition();
    const kingSq = pos.kingSquare('red');
    const expected = rectCenter(squareRect(l, 'red', kingSq));
    const kings = commandsWithRole(s, 'piece').filter(
      (c) => c.kind === 'piece' && c.piece === 'k' && c.army === 'red',
    );
    assert.equal(kings.length, 1);
    if (kings[0].kind !== 'piece') throw new Error('unreachable');
    const drawn = rectCenter(kings[0].rect);
    assert.ok(Math.abs(drawn.x - expected.x) < 0.001, 'x');
    assert.ok(Math.abs(drawn.y - expected.y) < 0.001, 'y');
  });
});

describe('themes drive appearance', () => {
  test('each theme paints its own square colours', () => {
    for (const id of THEME_IDS) {
      const theme = THEMES[id];
      const s = buildScene(input({ theme }));
      const dark = commandsWithRole(s, 'square-dark')[0];
      const light = commandsWithRole(s, 'square-light')[0];
      if (dark.kind !== 'rect' || light.kind !== 'rect') throw new Error('unreachable');
      assert.equal(dark.fill, theme.squareDark, `${id} dark`);
      assert.equal(light.fill, theme.squareLight, `${id} light`);
      assert.equal(s.background, theme.page, `${id} page`);
    }
  });

  test('Storybook rounds its squares, Midnight does not', () => {
    const story = buildScene(input({
      theme: THEMES.storybook, layout: computeLayout(VP, THEMES.storybook),
    }));
    const mid = buildScene(input({ theme: THEMES.midnight }));
    const r = (s: Scene) => {
      const c = commandsWithRole(s, 'square-dark')[0];
      return c.kind === 'rect' ? c.radius : -1;
    };
    assert.ok(r(story) > 0, 'Storybook squares should be rounded');
    assert.equal(r(mid), 0, 'Midnight squares should be square');
  });

  test('army colours come from the theme, and swap for colour-blind mode', () => {
    const normal = buildScene(input());
    const cb = buildScene(input({ colorblind: true }));
    const redOf = (s: Scene) => {
      const c = commandsWithRole(s, 'piece').find((x) => x.kind === 'piece' && x.army === 'red');
      return c !== undefined && c.kind === 'piece' ? c.fill : '';
    };
    assert.equal(redOf(normal), THEMES.midnight.armies.red);
    assert.equal(redOf(cb), COLORBLIND_ARMIES.red);
  });

  test('the colour-blind palette gives all four armies distinct colours', () => {
    const values = ARMIES.map((a) => COLORBLIND_ARMIES[a]);
    assert.equal(new Set(values).size, 4);
  });

  test('coordinates can be turned off', () => {
    assert.ok(roles(buildScene(input({ showCoords: true }))).has('coord-file'));
    assert.equal(roles(buildScene(input({ showCoords: false }))).has('coord-file'), false);
  });

  test('one file label per column and one rank label per row', () => {
    const s = buildScene(input());
    assert.equal(commandsWithRole(s, 'coord-file').length, 14);
    assert.equal(commandsWithRole(s, 'coord-rank').length, 14);
  });
});

describe('interaction feedback', () => {
  test('selecting a piece draws a highlight, an outline and its move dots', () => {
    const pos = startingPosition();
    const ctx = { position: pos, seat: 'red' as Army, controllable: ['red'] as Army[] };
    const sel = tapSquare(ctx, INITIAL_INTERACTION, parseSquare('g2'));
    const s = buildScene(input({ ctx, interaction: sel.state }));
    assert.equal(commandsWithRole(s, 'highlight-selected').length, 2, 'fill plus outline');
    assert.equal(commandsWithRole(s, 'legal-dot').length, 2, 'g3 and g4');
    assert.equal(commandsWithRole(s, 'capture-ring').length, 0);
  });

  test('capture targets get a ring, not a dot', () => {
    const pos = build({ d3: 'rK', a4: 'bK', k12: 'yK', n11: 'gK', h5: 'rR', h8: 'yQ' });
    const ctx = { position: pos, seat: 'red' as Army, controllable: ['red'] as Army[] };
    const sel = tapSquare(ctx, INITIAL_INTERACTION, parseSquare('h5'));
    const s = buildScene(input({ ctx, interaction: sel.state }));
    assert.equal(commandsWithRole(s, 'capture-ring').length, 1);
    const ring = commandsWithRole(s, 'capture-ring')[0];
    if (ring.kind !== 'ring') throw new Error('unreachable');
    const c = rectCenter(squareRect(computeLayout(VP, THEMES.midnight), 'red', parseSquare('h8')));
    assert.ok(Math.abs(ring.cx - c.x) < 0.001 && Math.abs(ring.cy - c.y) < 0.001);
  });

  test('the last move highlights both of its squares', () => {
    const pos = startingPosition();
    const move = generateLegal(pos, 'red').find((m) => squareName(m.to) === 'g4')!;
    const s = buildScene(input({ interaction: observeMove(INITIAL_INTERACTION, move) }));
    assert.equal(commandsWithRole(s, 'highlight-last').length, 2);
  });

  test('the keyboard cursor draws its own outline', () => {
    const s = buildScene(input({
      interaction: { ...INITIAL_INTERACTION, cursor: parseSquare('h7') },
    }));
    assert.equal(commandsWithRole(s, 'highlight-cursor').length, 1);
    assert.equal(commandsWithRole(buildScene(input()), 'highlight-cursor').length, 0);
  });

  test('a king in check gets a pulse overlay', () => {
    const s = buildScene(input({ checked: ['red'] }));
    assert.equal(commandsWithRole(s, 'highlight-check').length, 1);
    assert.equal(commandsWithRole(buildScene(input()), 'highlight-check').length, 0);
  });

  test('two kings in check both pulse', () => {
    const s = buildScene(input({ checked: ['red', 'blue'] }));
    assert.equal(commandsWithRole(s, 'highlight-check').length, 2);
  });
});

describe('animation is reflected in the scene', () => {
  test('a sliding piece is drawn between its two squares, not on either', () => {
    const pos = startingPosition();
    const move = generateLegal(pos, 'red').find((m) => squareName(m.to) === 'g4')!;
    pos.makeMove(move);
    const anims = add(NO_ANIMS, moveAnimFor(move, 'red', 0));
    const l = computeLayout(VP, THEMES.midnight);

    const half = buildScene(input({
      ctx: { position: pos, seat: 'red', controllable: ['red'] },
      anims, now: DURATION.move / 2,
    }));

    // Build the set of every legitimate square centre, then find pieces that sit on none of
    // them. Exactly one piece — the one in flight — should be off-grid.
    const key = (x: number, y: number) => `${x.toFixed(3)},${y.toFixed(3)}`;
    const grid = new Set(SQUARES.map((s) => {
      const c = rectCenter(squareRect(l, 'red', s));
      return key(c.x, c.y);
    }));
    const flying = commandsWithRole(half, 'piece').filter((c) => {
      if (c.kind !== 'piece') return false;
      const ctr = rectCenter(c.rect);
      return !grid.has(key(ctr.x, ctr.y));
    });
    assert.equal(flying.length, 1, 'exactly one piece mid-flight');

    // And it must lie strictly between the two squares along the direction of travel.
    if (flying[0].kind !== 'piece') throw new Error('unreachable');
    const y = rectCenter(flying[0].rect).y;
    const fromY = rectCenter(squareRect(l, 'red', move.from)).y;
    const toY = rectCenter(squareRect(l, 'red', move.to)).y;
    assert.ok(y < fromY && y > toY, `expected ${toY} < ${y} < ${fromY}`);
  });

  test('the sliding piece lands exactly on its destination when the animation ends', () => {
    const pos = startingPosition();
    const move = generateLegal(pos, 'red').find((m) => squareName(m.to) === 'g4')!;
    pos.makeMove(move);
    const anims = add(NO_ANIMS, moveAnimFor(move, 'red', 0));
    const s = buildScene(input({
      ctx: { position: pos, seat: 'red', controllable: ['red'] },
      anims, now: DURATION.move,
    }));
    // With the animation finished, all 64 pieces are back on their squares.
    assert.equal(commandsWithRole(s, 'piece').length, 64);
  });

  test('a captured piece fades rather than vanishing', () => {
    const pos = build({ d3: 'rK', a4: 'bK', k12: 'yK', n11: 'gK', h5: 'rR', h8: 'yQ' });
    const move = generateLegal(pos, 'red').find((m) => squareName(m.to) === 'h8')!;
    const anim = moveAnimFor(move, 'red', 0);
    pos.makeMove(move);
    const s = buildScene(input({
      ctx: { position: pos, seat: 'red', controllable: ['red'] },
      anims: add(NO_ANIMS, anim), now: 0,
    }));
    // At t=0 the victim is still fully visible even though the board no longer holds it.
    const opacities = commandsWithRole(s, 'piece').map((c) => (c.kind === 'piece' ? c.opacity : 1));
    assert.ok(opacities.some((o) => o > 0 && o < 1.0001));
  });

  test('a dead army is drawn faded — pieces become terrain', () => {
    const pos = startingPosition();
    pos.status.blue = 'checkmated';
    const s = buildScene(input({ ctx: { position: pos, seat: 'red', controllable: ['red'] } }));
    const blues = commandsWithRole(s, 'piece').filter((c) => c.kind === 'piece' && c.army === 'blue');
    const reds = commandsWithRole(s, 'piece').filter((c) => c.kind === 'piece' && c.army === 'red');
    assert.equal(blues.length, 16);
    for (const b of blues) if (b.kind === 'piece') assert.ok(b.opacity < 0.5, 'blue should be faded');
    for (const r of reds) if (r.kind === 'piece') assert.equal(r.opacity, 1, 'red unaffected');
  });

  test('the board carries a rotation only while a seat hand-off is running', () => {
    // Red -> Blue is an ANTICLOCKWISE quarter-turn of the image (rotationSteps = -1).
    const anims = add(NO_ANIMS, {
      kind: 'seat', fromSeat: 'red', toSeat: 'blue', steps: -1,
      startMs: 0, durationMs: DURATION.seatRotate,
    });
    assert.equal(buildScene(input()).rotation, 0, 'at rest');
    const mid = buildScene(input({ anims, now: DURATION.seatRotate / 2 })).rotation;
    assert.ok(mid < 0 && mid > -90, `mid-spin should be part-way anticlockwise, got ${mid}`);
    // Once complete the rotation resets, because the commands are now projected from the
    // incoming seat. A lingering -90 would double the rotation.
    assert.equal(buildScene(input({ anims, now: DURATION.seatRotate })).rotation, 0);
  });

  test('the spin lands exactly on the incoming view — no flash at the end (regression)', () => {
    // The shipped bug: the board spun +90 clockwise, then the projection switched to what is
    // actually the -90 view — a 180-degree jump on every hand-off. This test rotates the
    // final animated frame's red-king position by the scene rotation and demands it coincide
    // with the settled Blue-view position, so the discontinuity can never come back.
    const pos = startingPosition();
    const l = computeLayout(VP, THEMES.midnight);
    const anims = add(NO_ANIMS, {
      kind: 'seat', fromSeat: 'red', toSeat: 'blue', steps: rotationSteps('red', 'blue'),
      startMs: 0, durationMs: DURATION.seatRotate,
    });
    const ctx = { position: pos, seat: 'blue' as Army, controllable: ['blue'] as Army[] };

    const kingCenter = (scene: Scene): { x: number; y: number } => {
      const k = commandsWithRole(scene, 'piece').find(
        (c) => c.kind === 'piece' && c.piece === 'k' && c.army === 'red',
      );
      if (k === undefined || k.kind !== 'piece') throw new Error('unreachable');
      return rectCenter(k.rect);
    };

    // A whisker before the end: rotation is ~-90 and commands are still in Red's projection.
    const nearEnd = buildScene(input({ ctx, anims, now: DURATION.seatRotate - 0.001 }));
    const p = kingCenter(nearEnd);
    const c = nearEnd.rotationCenter;
    const theta = (nearEnd.rotation * Math.PI) / 180;
    const rotated = {
      x: c.x + (p.x - c.x) * Math.cos(theta) - (p.y - c.y) * Math.sin(theta),
      y: c.y + (p.x - c.x) * Math.sin(theta) + (p.y - c.y) * Math.cos(theta),
    };

    // Settled: rotation 0, commands in Blue's projection.
    const settled = buildScene(input({ ctx, anims, now: DURATION.seatRotate }));
    const target = kingCenter(settled);

    assert.ok(
      Math.hypot(rotated.x - target.x, rotated.y - target.y) < l.square * 0.02,
      `end of spin (${rotated.x.toFixed(1)},${rotated.y.toFixed(1)}) must coincide with ` +
      `settled view (${target.x.toFixed(1)},${target.y.toFixed(1)})`,
    );
  });

  test('a hand-off projects from the OUTGOING seat while spinning, and the incoming seat after', () => {
    // The host sets ctx.seat to the new seat as soon as it starts the spin; the scene keeps
    // drawing the old orientation until the rotation has carried the board there. Without this
    // the board would flash the wrong way round for a frame.
    const pos = startingPosition();
    const anims = add(NO_ANIMS, {
      kind: 'seat', fromSeat: 'red', toSeat: 'blue', steps: -1,
      startMs: 0, durationMs: DURATION.seatRotate,
    });
    const ctx = { position: pos, seat: 'blue' as Army, controllable: ['blue'] as Army[] };
    const l = computeLayout(VP, THEMES.midnight);
    const bottomRowY = l.grid.y + 13 * (l.square + l.gap);

    const kingY = (scene: Scene, army: Army): number => {
      const k = commandsWithRole(scene, 'piece').find(
        (c) => c.kind === 'piece' && c.piece === 'k' && c.army === army,
      );
      if (k === undefined || k.kind !== 'piece') throw new Error('unreachable');
      return k.rect.y;
    };

    const spinning = buildScene(input({ ctx, anims, now: 10 }));
    assert.ok(Math.abs(kingY(spinning, 'red') - bottomRowY) < l.square,
      'while spinning, Red is still at the bottom');

    const settled = buildScene(input({ ctx, anims, now: DURATION.seatRotate }));
    assert.ok(Math.abs(kingY(settled, 'blue') - bottomRowY) < l.square,
      'once settled, Blue is at the bottom');
  });
});

describe('seat rotation redraws the whole board', () => {
  test('every seat produces a complete, well-formed scene', () => {
    for (const seat of ARMIES) {
      const pos = startingPosition();
      const s = buildScene(input({ ctx: { position: pos, seat, controllable: [seat] } }));
      assert.equal(commandsWithRole(s, 'piece').length, 64, seat);
      assert.equal(
        commandsWithRole(s, 'square-light').length + commandsWithRole(s, 'square-dark').length,
        160, seat,
      );
    }
  });

  test('each seat sees its own king on the bottom row of the screen', () => {
    const l = computeLayout(VP, THEMES.midnight);
    for (const seat of ARMIES) {
      const pos = startingPosition();
      const s = buildScene(input({ ctx: { position: pos, seat, controllable: [seat] } }));
      const king = commandsWithRole(s, 'piece').find(
        (c) => c.kind === 'piece' && c.piece === 'k' && c.army === seat,
      );
      if (king === undefined || king.kind !== 'piece') throw new Error('unreachable');
      const bottomRow = l.grid.y + 13 * (l.square + l.gap);
      assert.ok(Math.abs(king.rect.y - bottomRow) < l.square, `${seat} king should be at the bottom`);
    }
  });
});

describe('withAlpha', () => {
  test('handles hex colours', () => {
    assert.equal(withAlpha('#ff0000', 0.5), 'rgba(255, 0, 0, 0.5)');
    assert.equal(withAlpha('#3d9bff', 1), 'rgba(61, 155, 255, 1)');
  });

  test('multiplies an existing rgba alpha rather than replacing it', () => {
    assert.equal(withAlpha('rgba(255,0,0,0.4)', 0.5), 'rgba(255, 0, 0, 0.2)');
    assert.equal(withAlpha('rgb(1,2,3)', 0.25), 'rgba(1, 2, 3, 0.25)');
  });

  test('clamps out-of-range alpha and passes unknown formats through', () => {
    assert.equal(withAlpha('#ff0000', 5), 'rgba(255, 0, 0, 1)');
    assert.equal(withAlpha('#ff0000', -1), 'rgba(255, 0, 0, 0)');
    assert.equal(withAlpha('papayawhip', 0.5), 'papayawhip');
  });
});
