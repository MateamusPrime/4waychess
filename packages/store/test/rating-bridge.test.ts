import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Army, ArmyStatus } from '@4wc/engine';
import { isRated, leaderboard, ranksFor, ratingOf } from '@4wc/rating';
import { outcomeFromRecord, recomputeLadder } from '../src/rating-bridge.ts';
import type { GameRecord } from '../src/ports.ts';

const ARMY_ORDER: Army[] = ['red', 'blue', 'yellow', 'green'];

function record(over: {
  id?: string;
  players?: (string | null)[];
  points?: [number, number, number, number];
  statuses?: ArmyStatus[];
  winners?: Army[];
  endedAtMs?: number;
} = {}): GameRecord {
  const players = over.players ?? ['p1', 'p2', 'p3', 'p4'];
  const points = over.points ?? [40, 30, 20, 10];
  const statuses = over.statuses ?? ['active', 'active', 'active', 'active'];
  return {
    id: over.id ?? 'g1',
    mode: 'ffa',
    seats: ARMY_ORDER.map((army, i) => ({
      army,
      profileId: players[i],
      bot: players[i] === null ? 'aggressive' : null,
      status: statuses[i],
    })),
    pgn4: '[Pgn4Version "1"]\n\n1. g2-g4 .. b7-d7 .. h13-h11 .. m8-k8\n',
    points: { red: points[0], blue: points[1], yellow: points[2], green: points[3] },
    winners: over.winners ?? ['red'],
    endReason: 'elimination',
    startedAtMs: (over.endedAtMs ?? 1000) - 600_000,
    endedAtMs: over.endedAtMs ?? 1000,
  };
}

describe('a stored record contains everything the ladder needs (RISKS.md R3)', () => {
  test('conversion carries players, points and mode', () => {
    const o = outcomeFromRecord(record());
    assert.equal(o.mode, 'ffa');
    assert.deepEqual(o.seats.map((s) => s.playerId), ['p1', 'p2', 'p3', 'p4']);
    assert.deepEqual(o.seats.map((s) => s.points), [40, 30, 20, 10]);
    assert.equal(isRated(o), true);
  });

  test('a bot seat converts to a null player and de-rates the game', () => {
    const o = outcomeFromRecord(record({ players: ['p1', null, 'p3', 'p4'] }));
    assert.equal(o.seats[1].playerId, null);
    assert.equal(isRated(o), false);
  });

  test('TIMEOUT is abandonment; resignation and checkmate are not', () => {
    // The whole anti-rage-quit rule depends on this distinction surviving storage, which is
    // why status is denormalised onto the seat rather than left inside the PGN4 movetext.
    const o = outcomeFromRecord(record({
      statuses: ['timeout', 'resigned', 'checkmated', 'stalemated'],
    }));
    assert.deepEqual(o.seats.map((s) => s.abandoned), [true, false, false, false]);
  });

  test('records written before `status` existed still convert, treated as not-abandoned', () => {
    // Stored data outlives the types that wrote it. A ladder recomputation running over years
    // of history will meet records from every past schema, and must not throw on them — nor
    // invent a punishment for a player who never earned one.
    const legacy = record();
    for (const s of legacy.seats) delete (s as { status?: unknown }).status;

    const o = outcomeFromRecord(legacy);
    assert.deepEqual(o.seats.map((s) => s.abandoned), [false, false, false, false]);
    assert.equal(isRated(o), true, 'and it is still a rateable game');
  });

  test('a timed-out points leader is ranked last, straight from the stored record', () => {
    const o = outcomeFromRecord(record({
      points: [90, 30, 20, 10],
      statuses: ['timeout', 'active', 'active', 'active'],
    }));
    const ranks = ranksFor(o);
    assert.equal(ranks.get('red'), 4, 'abandoning forfeits the place even when far ahead');
    assert.equal(ranks.get('blue'), 1);
  });
});

describe('the ladder can be rebuilt from stored history', () => {
  test('recomputeLadder produces a usable table and leaderboard', () => {
    const history: GameRecord[] = [
      record({ id: 'a', points: [40, 30, 20, 10], endedAtMs: 1000 }),
      record({ id: 'b', points: [10, 40, 30, 20], endedAtMs: 2000 }),
      record({ id: 'c', points: [35, 34, 33, 5], endedAtMs: 3000 }),
    ];
    const table = recomputeLadder(history);
    assert.equal(table.size, 4);
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      assert.equal(ratingOf(table, id).games, 3, `${id} played every game`);
    }
    assert.equal(leaderboard(table).length, 4);
  });

  test('it sorts by end time, so an out-of-order history still rebuilds identically', () => {
    // Ratings are path-dependent; replaying history in the wrong order silently produces
    // different numbers, and a storage listing is newest-first by design.
    const a = record({ id: 'a', points: [40, 30, 20, 10], endedAtMs: 1000 });
    const b = record({ id: 'b', points: [10, 40, 30, 20], endedAtMs: 2000 });
    const c = record({ id: 'c', points: [35, 5, 33, 34], endedAtMs: 3000 });

    const chronological = recomputeLadder([a, b, c]);
    const shuffled = recomputeLadder([c, a, b]);
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      assert.deepEqual(ratingOf(shuffled, id), ratingOf(chronological, id), id);
    }
  });

  test('rebuilding twice from the same history gives byte-identical ratings', () => {
    const history = [record({ id: 'a', endedAtMs: 1 }), record({ id: 'b', endedAtMs: 2 })];
    assert.deepEqual([...recomputeLadder(history)], [...recomputeLadder(history)]);
  });

  test('a history of bot games leaves the ladder empty', () => {
    const history = [
      record({ id: 'a', players: ['p1', null, null, null], endedAtMs: 1 }),
      record({ id: 'b', players: ['p1', null, null, null], endedAtMs: 2 }),
    ];
    assert.equal(recomputeLadder(history).size, 0, 'practice against bots never touches rank');
  });
});
