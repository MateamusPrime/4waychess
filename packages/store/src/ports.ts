/**
 * Persistence ports (Phase 3).
 *
 * The app depends on THESE interfaces, never on a vendor SDK. The same pattern that let the
 * settings store swap localStorage for AsyncStorage lets the whole persistence layer swap
 * in-memory (tests) → browser (guest play) → Supabase/Neon (accounts) without touching a
 * single consumer. The backend decision (ARCHITECTURE.md D4/D5) stays reversible until the
 * adapter is written — which is the point.
 *
 * Everything is async even where today's adapter is synchronous, because the next adapter is
 * a network. Every read that can miss returns null rather than throwing: absence is a normal
 * state, not an error.
 */

import type { Army, Mode } from '@4wc/engine';
import type { UserSettings } from '@4wc/ui-core';

/** Who is playing. Guests get a real id — signup later CLAIMS it, never discards it. */
export interface Profile {
  id: string;
  /** Display name. Guests get a generated one; accounts choose theirs. */
  name: string;
  /** Guests play first, sign up later (decided: never gate the first game behind a form). */
  guest: boolean;
  createdAtMs: number;
}

/** One seat in a stored game. */
export interface SeatRecord {
  army: Army;
  /** Profile id for humans, null for bots. */
  profileId: string | null;
  /** Bot personality id, null for humans. */
  bot: string | null;
}

/**
 * A finished (or abandoned) game, stored fully replayable.
 *
 * The PGN4 text carries ruleset id and engine version internally (RULES.md §15), which is
 * what makes retroactive recomputation — ratings, achievements, puzzles — possible over the
 * entire history. This record adds the queryable envelope around it.
 */
export interface GameRecord {
  id: string;
  mode: Mode;
  seats: SeatRecord[];
  pgn4: string;
  /** Final points per army, denormalised for listing without parsing PGN. */
  points: Record<Army, number>;
  winners: Army[];
  endReason: string;
  startedAtMs: number;
  endedAtMs: number;
}

export interface GameSummary {
  id: string;
  mode: Mode;
  seats: SeatRecord[];
  points: Record<Army, number>;
  winners: Army[];
  endedAtMs: number;
}

export interface ProfileStore {
  /** The active local profile, or null before first launch. */
  current(): Promise<Profile | null>;
  /** Create-or-return the local guest profile. Idempotent. */
  ensureGuest(): Promise<Profile>;
  rename(name: string): Promise<Profile>;
}

export interface SettingsSync {
  load(): Promise<UserSettings | null>;
  save(settings: UserSettings): Promise<void>;
}

export interface GameStore {
  save(record: GameRecord): Promise<void>;
  get(id: string): Promise<GameRecord | null>;
  /** Newest first. */
  list(limit?: number): Promise<GameSummary[]>;
  count(): Promise<number>;
}

/** The bundle the app receives. One object, one swap point. */
export interface Persistence {
  profiles: ProfileStore;
  settings: SettingsSync;
  games: GameStore;
}
