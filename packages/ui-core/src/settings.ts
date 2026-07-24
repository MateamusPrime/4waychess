/**
 * User settings.
 *
 * Persisted through an injected port rather than touching localStorage directly, so ui-core
 * stays platform-free: the web app supplies localStorage, mobile supplies AsyncStorage, and
 * Phase 3 swaps in a server-backed store without changing anything here.
 *
 * Loading is deliberately forgiving. A corrupt or partial value must never break the app —
 * a bad theme string just means the player gets Midnight (ARCHITECTURE.md D11).
 */

import type { ThemeId } from './themes.ts';
import { DEFAULT_THEME_ID, isThemeId } from './themes.ts';

/** Minimal storage port. Synchronous by design; async stores wrap it with a cache. */
export interface SettingsStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface UserSettings {
  themeId: ThemeId;
  /** Use the colour-blind-safe army palette (RISKS.md R11). */
  colorblind: boolean;
  showCoords: boolean;
  /** Board rotates to the player on move during local hand-off (ARCHITECTURE.md D12). */
  rotateOnHandoff: boolean;
  sound: boolean;
  /** Honour a reduced-motion preference by skipping non-essential animation. */
  reducedMotion: boolean;
}

export const SETTINGS_KEY = '4wc.settings.v1';

export const DEFAULT_SETTINGS: UserSettings = {
  themeId: DEFAULT_THEME_ID,
  colorblind: false,
  showCoords: true,
  rotateOnHandoff: true,
  sound: true,
  reducedMotion: false,
};

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Coerce arbitrary parsed JSON into valid settings, field by field. */
export function normalizeSettings(raw: unknown): UserSettings {
  if (raw === null || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };
  const o = raw as Record<string, unknown>;
  return {
    themeId: isThemeId(o.themeId) ? o.themeId : DEFAULT_SETTINGS.themeId,
    colorblind: asBool(o.colorblind, DEFAULT_SETTINGS.colorblind),
    showCoords: asBool(o.showCoords, DEFAULT_SETTINGS.showCoords),
    rotateOnHandoff: asBool(o.rotateOnHandoff, DEFAULT_SETTINGS.rotateOnHandoff),
    sound: asBool(o.sound, DEFAULT_SETTINGS.sound),
    reducedMotion: asBool(o.reducedMotion, DEFAULT_SETTINGS.reducedMotion),
  };
}

export function loadSettings(store: SettingsStore | null): UserSettings {
  if (store === null) return { ...DEFAULT_SETTINGS };
  let raw: string | null;
  try {
    raw = store.get(SETTINGS_KEY);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (raw === null) return { ...DEFAULT_SETTINGS };
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    // Unparseable stored settings are replaced, not surfaced as an error to the player.
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(store: SettingsStore | null, settings: UserSettings): void {
  if (store === null) return;
  try {
    store.set(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // A full or blocked storage quota must not break gameplay.
  }
}

export function withSetting<K extends keyof UserSettings>(
  settings: UserSettings,
  key: K,
  value: UserSettings[K],
): UserSettings {
  return { ...settings, [key]: value };
}

/** In-memory store, for tests and for private-mode browsers that block persistence. */
export function memoryStore(initial: Record<string, string> = {}): SettingsStore {
  const map = new Map(Object.entries(initial));
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => { map.set(k, v); },
  };
}
