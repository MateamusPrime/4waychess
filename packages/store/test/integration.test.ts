import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARMIES, FFA_RULES, Game, TEAMS_RULES, readPgn4, serializeFen4, writePgn4,
} from '@4wc/engine';
import {
  DEFAULT_SETTINGS, SETTINGS_KEY as UI_SETTINGS_KEY, loadSettings, saveSettings,
} from '@4wc/ui-core';
import { localPersistence, memoryKV } from '../src/local.ts';
import type { GameRecord } from '../src/ports.ts';

/**
 * End-to-end: play → store → read back → REPLAY.
 *
 * This is the test that gives the whole persistence layer its point. A stored game is only
 * worth storing if it can be replayed exactly, because everything Phase 6 promises — analysis,
 * retroactive ratings, achievements, puzzle mining — is replay over history (RISKS.md R3/R18).
 * A record that merely round-trips as JSON proves nothing; this replays the movetext through
 * the engine and demands the identical final position.
 */

function playGame(plies: number, rules = FFA_RULES, seed = 90210): Game {
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

function toRecord(g: Game, id: string): GameRecord {
  return {
    id,
    mode: g.rules.mode,
    seats: ARMIES.map((a) => ({
      army: a,
      profileId: a === 'red' ? 'guest-1' : null,
      bot: a === 'red' ? null : 'opportunist',
      status: g.pos.status[a],
    })),
    pgn4: writePgn4(g, { Event: 'Integration' }),
    points: { ...g.pos.points },
    winners: [...g.result().winners],
    endReason: g.result().reason,
    startedAtMs: 1_000,
    endedAtMs: 2_000,
  };
}

describe('a stored game is a replayable game', () => {
  test('FFA: the record replays to the identical final position and points', async () => {
    const p = localPersistence(memoryKV(), { now: () => 1, random: () => 0.5 });
    const played = playGame(120);
    await p.games.save(toRecord(played, 'g1'));

    const stored = await p.games.get('g1');
    assert.ok(stored !== null);

    const { game: replayed } = readPgn4(stored.pgn4);
    assert.equal(replayed.moves.length, played.moves.length, 'same number of moves');
    assert.equal(serializeFen4(replayed.pos), serializeFen4(played.pos), 'same final position');
    for (const a of ARMIES) {
      assert.equal(replayed.pos.points[a], played.pos.points[a], `${a} points`);
      assert.equal(replayed.pos.status[a], played.pos.status[a], `${a} status`);
    }
    assert.deepEqual(stored.points, played.pos.points, 'the denormalised points agree too');
  });

  test('Teams games replay with their own promotion rules intact', async () => {
    const p = localPersistence(memoryKV(), { now: () => 1, random: () => 0.5 });
    const played = playGame(120, TEAMS_RULES, 4711);
    await p.games.save(toRecord(played, 'g2'));

    const stored = await p.games.get('g2');
    const { game: replayed, tags } = readPgn4(stored!.pgn4);
    assert.equal(tags.Mode, 'teams');
    assert.equal(replayed.rules.promotionRank, 11, 'the ruleset travels with the game');
    assert.equal(serializeFen4(replayed.pos), serializeFen4(played.pos));
  });

  test('the record identifies who sat where, humans and bots alike', async () => {
    const p = localPersistence(memoryKV(), { now: () => 1, random: () => 0.5 });
    await p.games.save(toRecord(playGame(20), 'g3'));
    const stored = await p.games.get('g3');
    const red = stored!.seats.find((s) => s.army === 'red');
    const blue = stored!.seats.find((s) => s.army === 'blue');
    assert.equal(red?.profileId, 'guest-1');
    assert.equal(red?.bot, null);
    assert.equal(blue?.profileId, null);
    assert.equal(blue?.bot, 'opportunist');
  });

  test('the settings port reads exactly what ui-core wrote — one key, two packages', async () => {
    // ui-core owns the SYNCHRONOUS settings path (the first paint needs settings before any
    // promise resolves); this package owns the ASYNC port that the cloud adapter will use.
    // They deliberately share one key and one payload format, so the cloud adapter can upload
    // settings the app already wrote without a migration. That agreement is invisible in both
    // codebases and would break silently, so it is pinned here.
    const backing = new Map<string, string>();
    const syncStore = {
      get: (k: string) => backing.get(k) ?? null,
      set: (k: string, v: string) => { backing.set(k, v); },
    };
    saveSettings(syncStore, { ...DEFAULT_SETTINGS, themeId: 'atelier', colorblind: true });

    const p = localPersistence(
      {
        get: async (k) => backing.get(k) ?? null,
        set: async (k, v) => { backing.set(k, v); },
        del: async (k) => { backing.delete(k); },
      },
      { now: () => 1, random: () => 0.5 },
    );

    const viaPort = await p.settings.load();
    assert.equal(viaPort?.themeId, 'atelier', 'the async port sees the sync writer\'s data');
    assert.equal(viaPort?.colorblind, true);

    // ...and the reverse: what the port writes, ui-core reads.
    await p.settings.save({ ...DEFAULT_SETTINGS, themeId: 'storybook' });
    assert.equal(loadSettings(syncStore).themeId, 'storybook');
    assert.equal(backing.size, 1, `both packages must use the single key ${UI_SETTINGS_KEY}`);
  });

  test('history survives a "restart": a fresh Persistence over the same KV sees everything', async () => {
    // The real crash test for guest play — the app is closed and reopened, and the store is
    // rebuilt from scratch over the same underlying storage.
    const kv = memoryKV();
    const first = localPersistence(kv, { now: () => 1, random: () => 0.5 });
    const guest = await first.profiles.ensureGuest();
    await first.games.save(toRecord(playGame(40), 'g4'));

    const second = localPersistence(kv, { now: () => 999, random: () => 0.1 });
    assert.equal((await second.profiles.current())?.id, guest.id, 'same identity after restart');
    assert.equal((await second.profiles.ensureGuest()).id, guest.id, 'and no duplicate created');
    assert.equal(await second.games.count(), 1);
    const back = await second.games.get('g4');
    assert.ok(back !== null && readPgn4(back.pgn4).game.moves.length > 0, 'still replayable');
  });
});
