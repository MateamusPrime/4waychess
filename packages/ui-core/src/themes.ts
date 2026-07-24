/**
 * Theme tokens.
 *
 * All three art directions ship as a user setting, with Midnight the default for new players
 * and for anyone with no stored preference (ARCHITECTURE.md D11). Themes are pure data so the
 * same tokens drive the web renderer, the mobile renderer, and the scene tests.
 *
 * Values were validated visually in mockups/board-directions.html before being written here.
 */

import type { Army } from '@4wc/engine';

export type ThemeId = 'midnight' | 'atelier' | 'storybook';

export interface ArmyPalette {
  red: string;
  blue: string;
  yellow: string;
  green: string;
}

export interface Theme {
  id: ThemeId;
  name: string;
  /** Human-readable one-liner, shown in the settings picker. */
  blurb: string;
  dark: boolean;

  page: string;
  boardFrame: string;
  squareLight: string;
  squareDark: string;
  /** Pixel gap between squares, scaled by square size. 0 for a continuous board. */
  gapRatio: number;
  /** Square corner radius as a fraction of square size. */
  radiusRatio: number;
  /** Board outer padding as a fraction of square size. */
  padRatio: number;

  armies: ArmyPalette;
  pieceStrokeRatio: number;
  pieceStroke: string;
  /** 0 disables the glow pass entirely. */
  pieceGlow: number;
  pieceScale: number;

  highlightLast: string;
  highlightSelected: string;
  selectedOutline: string;
  legalDot: string;
  captureRing: string;
  checkGlow: string;
  coord: string;
  panel: string;
  panelBorder: string;
  text: string;
  textMuted: string;
  accent: string;
}

const MIDNIGHT: Theme = {
  id: 'midnight',
  name: 'Midnight',
  blurb: 'Deep charcoal and saturated accents that glow on check and capture.',
  dark: true,
  page: '#0a0e14',
  boardFrame: 'rgba(255,255,255,0.07)',
  squareLight: '#26313f',
  squareDark: '#1a2330',
  gapRatio: 0,
  radiusRatio: 0,
  padRatio: 0.06,
  armies: { red: '#ff4d5e', blue: '#3d9bff', yellow: '#ffc93d', green: '#34d399' },
  pieceStrokeRatio: 0.028,
  pieceStroke: 'rgba(4,8,14,0.75)',
  pieceGlow: 0.55,
  pieceScale: 0.78,
  highlightLast: 'rgba(255,201,61,0.16)',
  highlightSelected: 'rgba(255,201,61,0.22)',
  selectedOutline: '#ffc93d',
  legalDot: 'rgba(255,255,255,0.30)',
  captureRing: 'rgba(255,255,255,0.42)',
  checkGlow: 'rgba(255,77,94,0.55)',
  coord: 'rgba(255,255,255,0.28)',
  panel: 'rgba(255,255,255,0.035)',
  panelBorder: 'rgba(255,255,255,0.08)',
  text: '#e6edf5',
  textMuted: '#7d8b9e',
  accent: '#ffc93d',
};

const ATELIER: Theme = {
  id: 'atelier',
  name: 'Atelier',
  blurb: 'Tournament-table realism — wood grain, brass, and soft real shadows.',
  dark: true,
  page: '#241c16',
  boardFrame: '#5a3f27',
  squareLight: '#e5cfa6',
  squareDark: '#a97a4e',
  gapRatio: 0,
  radiusRatio: 0,
  padRatio: 0.16,
  armies: { red: '#b23a30', blue: '#2f5d86', yellow: '#c2912b', green: '#4c7a4a' },
  pieceStrokeRatio: 0.018,
  pieceStroke: 'rgba(30,16,6,0.55)',
  pieceGlow: 0,
  pieceScale: 0.80,
  highlightLast: 'rgba(194,145,43,0.26)',
  highlightSelected: 'rgba(178,58,48,0.20)',
  selectedOutline: '#d9ab54',
  legalDot: 'rgba(52,30,12,0.42)',
  captureRing: 'rgba(52,30,12,0.55)',
  checkGlow: 'rgba(178,58,48,0.45)',
  coord: 'rgba(60,38,20,0.5)',
  panel: 'rgba(255,246,230,0.045)',
  panelBorder: 'rgba(214,182,133,0.20)',
  text: '#f2e6d2',
  textMuted: '#a08e75',
  accent: '#d9ab54',
};

const STORYBOOK: Theme = {
  id: 'storybook',
  name: 'Storybook',
  blurb: 'Rounded, illustrated and friendly, on a light grey grid.',
  dark: false,
  page: '#fff6e8',
  boardFrame: '#d3cfd9',
  squareLight: '#fffaf0',
  squareDark: '#f6ddc0',
  gapRatio: 0.035,
  radiusRatio: 0.12,
  padRatio: 0.04,
  armies: { red: '#f4635e', blue: '#5c8dee', yellow: '#f6c445', green: '#4cc481' },
  pieceStrokeRatio: 0.058,
  pieceStroke: '#3a3350',
  pieceGlow: 0,
  pieceScale: 0.74,
  highlightLast: 'rgba(92,141,238,0.22)',
  highlightSelected: 'rgba(246,196,69,0.40)',
  selectedOutline: '#f4635e',
  legalDot: 'rgba(58,51,80,0.30)',
  captureRing: 'rgba(58,51,80,0.45)',
  checkGlow: 'rgba(244,99,94,0.45)',
  coord: 'rgba(58,51,80,0.42)',
  panel: 'rgba(255,255,255,0.72)',
  panelBorder: 'rgba(58,51,80,0.14)',
  text: '#3a3350',
  textMuted: '#8b83a6',
  accent: '#f4635e',
};

export const THEMES: Readonly<Record<ThemeId, Theme>> = {
  midnight: MIDNIGHT,
  atelier: ATELIER,
  storybook: STORYBOOK,
};

export const THEME_IDS: readonly ThemeId[] = ['midnight', 'atelier', 'storybook'];
export const DEFAULT_THEME_ID: ThemeId = 'midnight';

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v);
}

/**
 * Colour-blind-safe army palette (RISKS.md R11).
 *
 * The canonical four-way palette leans on red/green, the most common deficiency. This is an
 * Okabe–Ito-derived set chosen so all four armies stay distinguishable under deuteranopia and
 * protanopia. Shipping it as a setting is necessary but NOT sufficient — pieces also carry a
 * per-army marker glyph so the armies are separable without relying on hue at all.
 */
export const COLORBLIND_ARMIES: ArmyPalette = {
  red: '#d55e00',    // vermillion
  blue: '#0072b2',   // blue
  yellow: '#f0e442', // yellow
  green: '#009e73',  // bluish green
};

/** Short marker used alongside colour so armies never depend on hue alone. */
export const ARMY_MARKER: Readonly<Record<Army, string>> = {
  red: '●', blue: '■', yellow: '▲', green: '◆',
};

export function armyColor(theme: Theme, army: Army, colorblind: boolean): string {
  return colorblind ? COLORBLIND_ARMIES[army] : theme.armies[army];
}
