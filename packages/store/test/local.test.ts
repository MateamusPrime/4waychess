import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '@4wc/ui-core';
import { localPersistence, memoryKV, storageKV } from '../src/local.ts';
import type { KV, StorageLike } from '../src/local.ts';
import type { GameRecord } from '../src/ports.ts';

function fixture(over: Partial<{ now: number; kv: KV; maxGames: number }> = {}) {
  let t = over.now ?? 1_000_000;
  let r = 0.123;
  const kv = over.kv ?? memoryKV();
  const p = localPersistence(kv, {
    now: () => t++,
    // Deterministic pseudo-random walk, no Math.random.
    random: () => { r = (r * 9301 + 49297) % 233280 / 233280; return r; },
    maxGames: over.maxGames,
  });
  return { p, kv };
}

function record(id: string, endedAtMs: number): GameRecord {
  return {
    id,
    mode: 'ffa',
    seats: [
      { army: 'red', profileId: 'guest-1', bot: null },
      { army: 'blue', profileId: null, bot: 'aggressive' },
      { army: 'yellow', profileId: null, bot: 'opportunist' },
      { army: 'green', profileId: null, bot: 'turtle' },
    ],
    pgn4: '[Pgn4Version "1"]\n\n1. g2-g4 .. b7-d7 .. h13-h11 .. m8-k8\n',
    points: { red: 12, blue: 3, yellow: 8, green: 0 },
    winners: ['red'],
    endReason: 'elimination',
    startedAtMs: endedAtMs - 600_000,
    endedAtMs,
  };
}

describe('guest profile', () => {
  test('ensureGuest creates once and is idempotent', async () => {
    const { p } = fixture();
    assert.equal(await p.profiles.current(), null, 'no profile before first launch');
    const a = await p.profiles.ensureGuest();
    const b = await p.profiles.ensureGuest();
    assert.deepEqual(a, b, 'second call must return the same profile');
    assert.equal(a.guest, true);
    assert.match(a.id, /^guest-/);
    assert.ok(a.name.length > 0, 'guests get a readable name, not User4711');
  });

  test('rename keeps the id — identity is the id, the name is decoration', async () => {
    const { p } = fixture();
    const before = await p.profiles.ensureGuest();
    const after = await p.profiles.rename('  Kasparov of the North  ');
    assert.equal(after.id, before.id);
    assert.equal(after.name, 'Kasparov of the North');
    assert.equal((await p.profiles.current())?.name, 'Kasparov of the North');
  });

  test('a blank rename is refused, not stored', async () => {
    const { p } = fixture();
    const before = await p.profiles.ensureGuest();
    const after = await p.profiles.rename('   ');
    assert.equal(after.name, before.name);
  });
});

describe('settings sync', () => {
  test('round-trips and normalises on load', async () => {
    const { p } = fixture();
    assert.equal(await p.settings.load(), null, 'nothing stored yet');
    await p.settings.save({ ...DEFAULT_SETTINGS, themeId: 'storybook', sound: false });
    const back = await p.settings.load();
    assert.equal(back?.themeId, 'storybook');
    assert.equal(back?.sound, false);
  });

  test('corrupt stored settings degrade to defaults, never crash', async () => {
    const kv = memoryKV({ '4wc.settings.v1': '{not json' });
    const { p } = fixture({ kv });
    assert.equal(await p.settings.load(), null);
    const kv2 = memoryKV({ '4wc.settings.v1': JSON.stringify({ themeId: 'nonsense' }) });
    const { p: p2 } = fixture({ kv: kv2 });
    assert.equal((await p2.settings.load())?.themeId, 'midnight');
  });
});

describe('storage adapter survives hostile browsers', () => {
  test('round-trips through a working Storage', async () => {
    const map = new Map<string, string>();
    const storage: StorageLike = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => { map.set(k, v); },
      removeItem: (k) => { map.delete(k); },
    };
    const { p } = fixture({ kv: storageKV(storage) });
    const guest = await p.profiles.ensureGuest();
    assert.equal((await p.profiles.current())?.id, guest.id);
    assert.ok(map.size > 0, 'it really wrote to the backing store');
  });

  test('a Storage that throws on every call degrades to "not stored", never to a crash', async () => {
    // Private browsing, exhausted quota and enterprise lockdown all present this way. Losing
    // a saved game is regrettable; losing the running game to an exception is not.
    const hostile: StorageLike = {
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('QuotaExceededError'); },
      removeItem() { throw new Error('SecurityError'); },
    };
    const { p } = fixture({ kv: storageKV(hostile) });
    await assert.doesNotReject(async () => {
      const guest = await p.profiles.ensureGuest();
      assert.ok(guest.id.length > 0, 'still gets a usable in-session identity');
      await p.games.save(record('g1', 100));
      assert.deepEqual(await p.games.list(), []);
      assert.equal(await p.settings.load(), null);
    });
  });
});

describe('game history', () => {
  test('save, get and list round-trip with newest first', async () => {
    const { p } = fixture();
    await p.games.save(record('g1', 100));
    await p.games.save(record('g2', 200));
    await p.games.save(record('g3', 300));

    assert.equal(await p.games.count(), 3);
    const list = await p.games.list();
    assert.deepEqual(list.map((g) => g.id), ['g3', 'g2', 'g1']);

    const back = await p.games.get('g2');
    assert.ok(back !== null);
    assert.equal(back.pgn4, record('g2', 200).pgn4);
    assert.deepEqual(back.points, { red: 12, blue: 3, yellow: 8, green: 0 });
  });

  test('saving the same id twice does not duplicate the index', async () => {
    const { p } = fixture();
    await p.games.save(record('g1', 100));
    await p.games.save(record('g1', 100));
    assert.equal(await p.games.count(), 1);
  });

  test('eviction keeps the newest games and deletes evicted records', async () => {
    const { p, kv } = fixture({ maxGames: 3 });
    for (let i = 1; i <= 5; i++) await p.games.save(record(`g${i}`, i * 100));
    assert.equal(await p.games.count(), 3);
    assert.deepEqual((await p.games.list()).map((g) => g.id), ['g5', 'g4', 'g3']);
    assert.equal(await p.games.get('g1'), null, 'evicted record is gone');
    assert.equal(await kv.get('4wc.game.v1.g1'), null, 'and its key is deleted, not orphaned');
  });

  test('a dangling index entry is skipped in listings, not a crash', async () => {
    const { p, kv } = fixture();
    await p.games.save(record('g1', 100));
    await p.games.save(record('g2', 200));
    await kv.del('4wc.game.v1.g1'); // simulate a partial write / external clear
    const list = await p.games.list();
    assert.deepEqual(list.map((g) => g.id), ['g2']);
  });

  test('list honours its limit', async () => {
    const { p } = fixture();
    for (let i = 1; i <= 10; i++) await p.games.save(record(`g${i}`, i * 100));
    assert.equal((await p.games.list(4)).length, 4);
  });
});
