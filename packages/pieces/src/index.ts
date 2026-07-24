/**
 * @4wc/pieces — the piece family as pure SVG path data.
 *
 * One GEOMETRY, three TREATMENTS (RISKS.md R10): every theme renders these same paths and
 * differs only in fill, stroke, shadow and glow — which is what keeps three themes from
 * tripling the art budget. If a theme ever needs different silhouettes, that is an explicit
 * scope decision, not drift.
 *
 * All paths live in a 100x100 viewBox, y-down, centred on x=50, standing on y≈95. They are
 * plain path strings so the same data feeds Canvas2D (via Path2D), CanvasKit and
 * react-native-skia without conversion.
 *
 * Design constraints, in priority order:
 *  1. Read at 24px — the real square size on a phone (RISKS.md R8). Silhouette first.
 *  2. Distinct at a glance from every other piece, in any of the four army colours.
 *  3. Carry a shared plinth so the family reads as one set.
 */

import type { PieceType } from '@4wc/engine';

/** Shared plinth: every piece stands on the same base so the family reads as one set. */
const PLINTH =
  'M31 85 L69 85 C72 85 74 87 74 90 L74 91 C74 93.5 72 95 69 95 ' +
  'L31 95 C28 95 26 93.5 26 91 L26 90 C26 87 28 85 31 85 Z';

const PAWN =
  'M50 16 C57.5 16 63 21.5 63 28.5 C63 33.5 60.5 37.5 56.5 39.5 ' +
  'C61 42.5 64 47.5 64 53 C64 57 62 60.5 59 62.5 ' +
  'L65 74 C67 78 64.5 82 60.5 82 L39.5 82 C35.5 82 33 78 35 74 ' +
  'L41 62.5 C38 60.5 36 57 36 53 C36 47.5 39 42.5 43.5 39.5 ' +
  'C39.5 37.5 37 33.5 37 28.5 C37 21.5 42.5 16 50 16 Z ' + PLINTH;

const ROOK =
  'M32 16 L42 16 L42 24 L47 24 L47 16 L53 16 L53 24 L58 24 L58 16 L68 16 ' +
  'L68 30 L62 36 L62 66 L68 74 L68 82 L32 82 L32 74 L38 66 L38 36 L32 30 Z ' + PLINTH;

/**
 * Horse head in profile, facing the viewer's left. The two features that make a knight read
 * as a horse at any size are the protruding muzzle and the ears — the first cut of this piece
 * lacked both and was memorably described as "a lamp on a table". Anatomy, in path order:
 * chest → throat → jaw → chin → rounded nose → nose bridge → brow → front ear → notch →
 * back ear → skull → arched neck crest → back → base.
 */
const KNIGHT =
  'M41 82 C39 74 37 69 38 63 C38.5 58 42 55.5 46 54.5 ' +
  'C41 57 34 58 29 55 C24 52 20.5 47.5 22 44 C23 41.5 25.5 41.5 27.5 41 ' +
  'C29.5 40.5 30.5 38.5 32 36 C34 32.5 38 29.5 44 27.5 ' +
  'C45 21.5 47 16.5 50.5 13.5 C52.5 16 53 19.5 53 22 ' +
  'C55.5 20 59.5 18.5 62.5 13.5 C65.5 16 66.5 21 66.5 25 ' +
  'C71 30.5 73.5 36.5 74 44 C74.5 52 73 58 71.5 62 ' +
  'C71 69 71 76 71.5 82 Z ' + PLINTH;

const BISHOP =
  'M50 12 C53.3 12 56 14.7 56 18 C56 21.3 53.3 24 50 24 C46.7 24 44 21.3 44 18 ' +
  'C44 14.7 46.7 12 50 12 Z ' +
  'M50 27 C58.5 33 64.5 43 64.5 52.5 C64.5 60.5 58.5 66.5 50 66.5 ' +
  'C41.5 66.5 35.5 60.5 35.5 52.5 C35.5 43 41.5 33 50 27 Z ' +
  'M50 35 L54 45 L50 55 L46 45 Z ' +
  'M41 69 L59 69 L63.5 82 L36.5 82 Z ' + PLINTH;

const QUEEN =
  'M50 10 C52.2 10 54 11.8 54 14 C54 16.2 52.2 18 50 18 C47.8 18 46 16.2 46 14 C46 11.8 47.8 10 50 10 Z ' +
  'M31 22 C33.2 22 35 23.8 35 26 C35 28.2 33.2 30 31 30 C28.8 30 27 28.2 27 26 C27 23.8 28.8 22 31 22 Z ' +
  'M69 22 C71.2 22 73 23.8 73 26 C73 28.2 71.2 30 69 30 C66.8 30 65 28.2 65 26 C65 23.8 66.8 22 69 22 Z ' +
  'M29 34 L38 40 L50 22 L62 40 L71 34 L66 48 L64 62 L70 74 L70 82 L30 82 L30 74 L36 62 L34 48 Z ' + PLINTH;

const KING =
  'M46.5 8 L53.5 8 L53.5 14 L59.5 14 L59.5 21 L53.5 21 L53.5 27 L46.5 27 L46.5 21 L40.5 21 L40.5 14 L46.5 14 Z ' +
  'M37 31 L63 31 L67.5 44 L63.5 60 L69.5 74 L69.5 82 L30.5 82 L30.5 74 L36.5 60 L32.5 44 Z ' + PLINTH;

export const PIECE_PATHS: Readonly<Record<PieceType, string>> = {
  p: PAWN,
  r: ROOK,
  n: KNIGHT,
  b: BISHOP,
  q: QUEEN,
  k: KING,
};

/** The coordinate space every path is authored in. */
export const PIECE_VIEWBOX = 100;

/**
 * Fill rule per piece. The bishop's mitre slit is a genuine hole and needs evenodd; everything
 * else is additive subpaths where nonzero is correct and cheaper.
 */
export const PIECE_FILL_RULE: Readonly<Record<PieceType, 'nonzero' | 'evenodd'>> = {
  p: 'nonzero',
  r: 'nonzero',
  n: 'nonzero',
  b: 'evenodd',
  q: 'nonzero',
  k: 'nonzero',
};

/**
 * A small badge ring drawn on a promoted (1-point) queen so it is visually distinct from a
 * full queen — the two differ by 8 points when captured, which is far too much to hide.
 */
export const PROMOTED_BADGE = { cx: 50, cy: 52, r: 7 };
