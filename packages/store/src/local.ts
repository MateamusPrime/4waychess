/**
 * Local adapter: guest play backed by a key-value port.
 *
 * Serves three masters with one implementation: in-memory KV for tests, localStorage for the
 * web app today, AsyncStorage-wrapped for mobile later. When accounts arrive (D4), the cloud
 * adapter implements the same Persistence bundle and the local one becomes the offline cache —
 * and the guest profile is CLAIMED by the new account, never discarded, so a player's
 * pre-signup history survives signup. That migration path is designed here, before any cloud
 * exists, because it is nearly free now and a data-loss incident later.
 *
 * Storage layout (all keys versioned):
 *   4wc.profile.v1        one JSON Profile
 *   4wc.settings.v1       ui-core's own settings payload (shared key, same format)
 *   4wc.games.index.v1    JSON array of game ids, newest first
 *   4wc.game.v1.<id>      one JSON GameRecord
 */

import { normalizeSettings } from '@4wc/ui-core';
import type { UserSettings } from '@4wc/ui-core';
import type {
  GameRecord, GameSummary, Persistence, Profile,
} from './ports.ts';

/** Minimal async key-value port. localStorage and AsyncStorage both fit trivially. */
export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

export function memoryKV(initial: Record<string, string> = {}): KV {
  const map = new Map(Object.entries(initial));
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => { map.set(k, v); },
    del: async (k) => { map.delete(k); },
  };
}

/** The synchronous Storage shape, declared locally so this package needs no DOM lib. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * KV over a synchronous Storage (localStorage on web, an AsyncStorage shim on mobile).
 *
 * Every operation is wrapped: private browsing throws on write, quota can be exhausted, and
 * enterprise policy can disable storage entirely. Losing a saved game is regrettable; losing
 * the running game to an exception is not acceptable — so failures degrade to "not stored".
 */
export function storageKV(storage: StorageLike): KV {
  return {
    async get(k) {
      try {
        return storage.getItem(k);
      } catch {
        return null;
      }
    },
    async set(k, v) {
      try {
        storage.setItem(k, v);
      } catch {
        /* quota exceeded or storage disabled — the app must keep playing */
      }
    },
    async del(k) {
      try {
        storage.removeItem(k);
      } catch {
        /* same */
      }
    },
  };
}

const PROFILE_KEY = '4wc.profile.v1';
const SETTINGS_KEY = '4wc.settings.v1';
const INDEX_KEY = '4wc.games.index.v1';
const GAME_PREFIX = '4wc.game.v1.';

/** Guest names that read as characters, not as "User4711". */
const GUEST_NAMES = [
  'Wandering Pawn', 'Quiet Rook', 'Patient Bishop', 'Restless Knight',
  'Fourth Queen', 'Corner King', 'Grey Gambit', 'Late Castle',
];

export interface LocalOptions {
  /** Injected so the adapter stays deterministic in tests. */
  now(): number;
  /** Random in [0,1), injected for the same reason. */
  random(): number;
  /** Cap on retained games; oldest are evicted. Guests are not an archive. */
  maxGames?: number;
}

function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null; // corrupt data degrades to absence, never to a crash
  }
}

export function localPersistence(kv: KV, opts: LocalOptions): Persistence {
  const maxGames = opts.maxGames ?? 200;

  const makeId = (): string =>
    `${opts.now().toString(36)}-${Math.floor(opts.random() * 0xffffff).toString(36)}`;

  async function readIndex(): Promise<string[]> {
    return parseJson<string[]>(await kv.get(INDEX_KEY)) ?? [];
  }

  return {
    profiles: {
      async current(): Promise<Profile | null> {
        return parseJson<Profile>(await kv.get(PROFILE_KEY));
      },
      async ensureGuest(): Promise<Profile> {
        const existing = parseJson<Profile>(await kv.get(PROFILE_KEY));
        if (existing !== null) return existing;
        const profile: Profile = {
          id: `guest-${makeId()}`,
          name: GUEST_NAMES[Math.floor(opts.random() * GUEST_NAMES.length)],
          guest: true,
          createdAtMs: opts.now(),
        };
        await kv.set(PROFILE_KEY, JSON.stringify(profile));
        return profile;
      },
      async rename(name: string): Promise<Profile> {
        const profile = await this.ensureGuest();
        const next = { ...profile, name: name.trim().slice(0, 40) || profile.name };
        await kv.set(PROFILE_KEY, JSON.stringify(next));
        return next;
      },
    },

    settings: {
      async load(): Promise<UserSettings | null> {
        // Corrupt data reads as ABSENT, not as defaults: the caller already has a defaults
        // path for null, and the port should not invent settings it never stored.
        const parsed = parseJson<unknown>(await kv.get(SETTINGS_KEY));
        return parsed === null ? null : normalizeSettings(parsed);
      },
      async save(settings: UserSettings): Promise<void> {
        await kv.set(SETTINGS_KEY, JSON.stringify(settings));
      },
    },

    games: {
      async save(record: GameRecord): Promise<void> {
        const index = await readIndex();
        if (!index.includes(record.id)) index.unshift(record.id);
        // Evict beyond the cap — delete the record BEFORE shrinking the index, so a crash
        // between the two writes leaves an orphaned record (harmless) rather than a dangling
        // index entry (a null in every listing).
        while (index.length > maxGames) {
          const evicted = index.pop();
          if (evicted !== undefined) await kv.del(GAME_PREFIX + evicted);
        }
        await kv.set(GAME_PREFIX + record.id, JSON.stringify(record));
        await kv.set(INDEX_KEY, JSON.stringify(index));
      },
      async get(id: string): Promise<GameRecord | null> {
        return parseJson<GameRecord>(await kv.get(GAME_PREFIX + id));
      },
      async list(limit = 50): Promise<GameSummary[]> {
        const index = await readIndex();
        const out: GameSummary[] = [];
        for (const id of index.slice(0, limit)) {
          const rec = parseJson<GameRecord>(await kv.get(GAME_PREFIX + id));
          if (rec === null) continue; // orphaned index entry: skip, don't crash
          out.push({
            id: rec.id, mode: rec.mode, seats: rec.seats, points: rec.points,
            winners: rec.winners, endedAtMs: rec.endedAtMs,
          });
        }
        return out;
      },
      async count(): Promise<number> {
        return (await readIndex()).length;
      },
    },
  };
}
