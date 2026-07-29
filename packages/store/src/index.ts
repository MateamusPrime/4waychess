/**
 * @4wc/store — persistence ports and the local (guest) adapter.
 *
 * The app depends on the ports; adapters are swap points. The cloud adapter (Phase 3, D4/D5)
 * implements the same Persistence bundle, and the guest profile is claimed by the account —
 * never discarded — so pre-signup history survives signup.
 */

export type {
  GameRecord, GameSummary, GameStore, Persistence, Profile, ProfileStore, SeatRecord,
  SettingsSync,
} from './ports.ts';

export type { KV, LocalOptions, StorageLike } from './local.ts';
export { localPersistence, memoryKV, storageKV } from './local.ts';
