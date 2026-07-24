import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, SETTINGS_KEY, loadSettings, memoryStore, normalizeSettings,
  saveSettings, withSetting,
} from '../src/settings.ts';
import { DEFAULT_THEME_ID, THEME_IDS, isThemeId } from '../src/themes.ts';
import type { SettingsStore } from '../src/settings.ts';

describe('defaults', () => {
  test('Midnight is the default theme for anyone with no preference', () => {
    assert.equal(DEFAULT_SETTINGS.themeId, 'midnight');
    assert.equal(DEFAULT_THEME_ID, 'midnight');
    assert.equal(loadSettings(memoryStore()).themeId, 'midnight');
    assert.equal(loadSettings(null).themeId, 'midnight');
  });

  test('sensible defaults for everything else', () => {
    assert.deepEqual(DEFAULT_SETTINGS, {
      themeId: 'midnight',
      colorblind: false,
      showCoords: true,
      rotateOnHandoff: true,
      sound: true,
      reducedMotion: false,
    });
  });

  test('loadSettings returns a fresh object, not the shared default', () => {
    const a = loadSettings(null);
    a.themeId = 'atelier';
    assert.equal(DEFAULT_SETTINGS.themeId, 'midnight', 'the default must not be mutable');
  });
});

describe('round-tripping', () => {
  test('a saved preference survives a reload', () => {
    const store = memoryStore();
    saveSettings(store, withSetting(DEFAULT_SETTINGS, 'themeId', 'storybook'));
    assert.equal(loadSettings(store).themeId, 'storybook');
  });

  test('every theme round-trips', () => {
    for (const id of THEME_IDS) {
      const store = memoryStore();
      saveSettings(store, withSetting(DEFAULT_SETTINGS, 'themeId', id));
      assert.equal(loadSettings(store).themeId, id);
    }
  });

  test('all flags round-trip together', () => {
    const store = memoryStore();
    const settings = {
      themeId: 'atelier' as const,
      colorblind: true,
      showCoords: false,
      rotateOnHandoff: false,
      sound: false,
      reducedMotion: true,
    };
    saveSettings(store, settings);
    assert.deepEqual(loadSettings(store), settings);
  });

  test('withSetting does not mutate the original', () => {
    const next = withSetting(DEFAULT_SETTINGS, 'colorblind', true);
    assert.equal(next.colorblind, true);
    assert.equal(DEFAULT_SETTINGS.colorblind, false);
  });

  test('it writes under a versioned key', () => {
    const store = memoryStore();
    saveSettings(store, DEFAULT_SETTINGS);
    assert.match(SETTINGS_KEY, /v1$/);
    assert.notEqual(store.get(SETTINGS_KEY), null);
  });
});

describe('corrupt and hostile input never breaks the app', () => {
  test('unparseable JSON falls back to defaults', () => {
    const store = memoryStore({ [SETTINGS_KEY]: 'not json {{{' });
    assert.deepEqual(loadSettings(store), DEFAULT_SETTINGS);
  });

  test('an unknown theme id falls back to Midnight but keeps other valid fields', () => {
    const store = memoryStore({
      [SETTINGS_KEY]: JSON.stringify({ themeId: 'neon-vaporwave', sound: false }),
    });
    const s = loadSettings(store);
    assert.equal(s.themeId, 'midnight');
    assert.equal(s.sound, false, 'a valid neighbour must survive');
  });

  test('partial settings are filled in from defaults', () => {
    const store = memoryStore({ [SETTINGS_KEY]: JSON.stringify({ themeId: 'atelier' }) });
    assert.deepEqual(loadSettings(store), { ...DEFAULT_SETTINGS, themeId: 'atelier' });
  });

  test('wrong types are rejected field by field', () => {
    const store = memoryStore({
      [SETTINGS_KEY]: JSON.stringify({ themeId: 42, colorblind: 'yes', showCoords: null }),
    });
    assert.deepEqual(loadSettings(store), DEFAULT_SETTINGS);
  });

  test('JSON that is not an object is handled', () => {
    for (const raw of ['null', '"midnight"', '[1,2,3]', '7', 'true']) {
      const store = memoryStore({ [SETTINGS_KEY]: raw });
      assert.deepEqual(loadSettings(store), DEFAULT_SETTINGS, raw);
    }
  });

  test('normalizeSettings copes with anything', () => {
    for (const raw of [null, undefined, 0, '', [], { themeId: {} }]) {
      assert.equal(normalizeSettings(raw).themeId, 'midnight', JSON.stringify(raw));
    }
  });

  test('a store that throws on read degrades to defaults instead of crashing', () => {
    const hostile: SettingsStore = {
      get() { throw new Error('SecurityError: storage disabled'); },
      set() { /* no-op */ },
    };
    assert.deepEqual(loadSettings(hostile), DEFAULT_SETTINGS);
  });

  test('a store that throws on write does not break gameplay', () => {
    // Private browsing and full quotas both throw on write. Losing a theme preference is
    // acceptable; losing the game because of it is not.
    const hostile: SettingsStore = {
      get() { return null; },
      set() { throw new Error('QuotaExceededError'); },
    };
    assert.doesNotThrow(() => saveSettings(hostile, DEFAULT_SETTINGS));
  });

  test('a null store is a valid no-op store', () => {
    assert.doesNotThrow(() => saveSettings(null, DEFAULT_SETTINGS));
    assert.deepEqual(loadSettings(null), DEFAULT_SETTINGS);
  });
});

describe('theme id guard', () => {
  test('accepts exactly the three shipped themes', () => {
    for (const id of THEME_IDS) assert.equal(isThemeId(id), true, id);
    for (const bad of ['', 'Midnight', 'dark', null, undefined, 3, {}]) {
      assert.equal(isThemeId(bad), false, JSON.stringify(bad));
    }
  });
});
