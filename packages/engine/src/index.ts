/**
 * @4wc/engine — pure four-way chess rules engine.
 *
 * Zero dependencies. No I/O, no framework, no rendering, no knowledge of transport.
 * This package must never import from apps/*. Everything downstream — web client, mobile
 * client, bots, the authoritative server, analysis, replay — is a consumer of this one
 * package, and that is what keeps every other architectural decision reversible.
 */

export type {
  Army, ArmyStatus, CastlingRights, EnPassantRight, Mode, Move, PieceType, Ruleset, Square,
} from './types.ts';

export {
  ARMIES, ARMY_INDEX, BISHOP_DIRS, FILES, FORWARD, KING_DELTAS, KNIGHT_DELTAS, NSQ,
  PAWN_CAPTURES, PLAYABLE, QUEEN_DIRS, RIGHT, ROOK_DIRS, SQUARES, W,
  fileOf, fromOwn, idx, isDarkSquare, isPlayable, isPlayableXY, parseSquare, rankOf,
  squareName, step, toOwn,
} from './geometry.ts';

export {
  FFA_RULES, PARTNER, Position, TEAMS_RULES,
  codeArmy, codePromoted, codeType, encodePiece,
} from './position.ts';
export type { Piece } from './position.ts';

export {
  CHESSCOM_START, FEN4_VERSION, OUR_START,
  parseBoard, parseFen4, serializeBoard, serializeFen4, startingPosition,
} from './fen4.ts';

export {
  attackersOf, checkingArmies, isAttacked, isAttackedBy, isInCheck,
} from './attacks.ts';

export { generateLegal, generatePseudoLegal, turnOutcome } from './movegen.ts';
export type { TurnOutcome } from './movegen.ts';

export {
  CHECKMATE_BONUS, CHECK_THREE_BONUS, CHECK_TWO_BONUS, PIECE_VALUES,
  PROMOTED_QUEEN_VALUE, SELF_STALEMATE_BONUS, SPARE_KING_VALUE,
  armiesCheckedBy, captureValue, checkBonusFor, kingCount, materialValue, newChecks,
} from './scoring.ts';

export { Game } from './game.ts';
export type { EndReason, GameEvent, GameResult } from './game.ts';

export {
  ENGINE_VERSION, PGN4_VERSION, formatMove, parseMoveText, readPgn4, writePgn4,
} from './pgn4.ts';
export type { Pgn4Document, Pgn4Tags } from './pgn4.ts';

export { perft, perftDetailed, perftDivide, plyOrder } from './perft.ts';

export {
  moveKey, naiveGenerateLegal, naiveGeneratePseudoLegal, naiveIsAttacked, naiveIsInCheck,
} from './naive.ts';
