/**
 * Core value types for the 4-way chess engine.
 *
 * Constraint: this package is compiled by Node's native type stripping, which requires
 * "erasable syntax only" — no enums, no parameter properties, no namespaces. Use const
 * objects plus union types instead of enums, and always import with explicit .ts extensions.
 */

/** The four armies, in turn order. */
export type Army = 'red' | 'blue' | 'yellow' | 'green';

/** Piece kinds. Lowercase throughout; army carries the colour. */
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

/** Game mode. Mode is configuration over one engine, never a fork. */
export type Mode = 'ffa' | 'teams';

/**
 * Why an army is no longer playing. `active` armies take turns; every other status means
 * the army's pieces are dead terrain: they never move, never give check, always block,
 * and award zero points when captured. (RULES.md §9)
 */
export type ArmyStatus =
  | 'active'
  | 'checkmated'
  | 'stalemated'
  | 'resigned'
  | 'timeout';

/** A square index, 0..195, laid out as `rank * 14 + file`. */
export type Square = number;

/**
 * A move. `capturedSq` differs from `to` only for en passant, which is exactly why it is
 * stored separately rather than inferred.
 */
export interface Move {
  from: Square;
  to: Square;
  piece: PieceType;
  /** Piece type captured, if any. */
  captured: PieceType | null;
  /** Square the captured piece occupied. Equals `to` except for en passant. */
  capturedSq: Square | null;
  /** Army that owned the captured piece. */
  capturedArmy: Army | null;
  /** True if the captured piece was a promoted (1-point) queen. */
  capturedPromoted: boolean;
  /** Piece type promoted to, if this move promotes. */
  promotion: PieceType | null;
  castle: 'short' | 'long' | null;
  /** True if this was a two-square pawn advance (creates an en passant right). */
  doubleStep: boolean;
}

/**
 * An outstanding en passant right.
 *
 * Note this is a LIST on the position, not a single value. In four-way chess up to three
 * armies can have double-stepped since your last turn, so multiple en passant rights can
 * be live simultaneously — a case that does not exist in two-player chess and that is easy
 * to get wrong. (RULES.md §6)
 */
export interface EnPassantRight {
  /** The square the pawn stepped over — where a capturing pawn lands. */
  passed: Square;
  /** The square the double-stepped pawn now occupies — where the captured pawn is removed from. */
  victim: Square;
  /** The army that made the double step. The right expires when this army's next turn begins. */
  army: Army;
}

/** Castling availability, tracked in each army's own frame. */
export interface CastlingRights {
  short: boolean;
  long: boolean;
}

/** Ruleset constants. Values live in config so they can be tuned without touching logic. */
export interface Ruleset {
  id: string;
  mode: Mode;
  /** Own-rank a pawn must reach to promote. FFA 8, Teams 11. (RULES.md §6) */
  promotionRank: number;
  /** FFA promotes automatically to a 1-point queen; Teams allows underpromotion. */
  allowUnderpromotion: boolean;
  /** FFA marks promoted queens as worth only 1 point. */
  promotedQueenIsOnePoint: boolean;
  /** Repetitions of a position that end the game. (RULES.md §13) */
  repetitionLimit: number;
  /** Full rounds without a capture or pawn move that end the game. (RULES.md §13) */
  moveRuleRounds: number;
}
