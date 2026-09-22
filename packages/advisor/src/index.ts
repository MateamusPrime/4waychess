/**
 * @4wc/advisor — a training advisor for standard chess, built on Stockfish.
 *
 * Not a bot for the four-way game: this package is ordinary 8×8 chess. It exists to make a
 * strong engine useful to a human who wants to improve, which raw UCI output is not. Use it to
 * spar against a strength-limited Stockfish with hints, or to review finished games.
 *
 * Never use it during a game against another person: every online platform treats engine
 * assistance as cheating, in rated and casual games alike.
 */

export type { Score, InfoLine, GoLimits, SearchLine, SearchOutcome, UciOption, EngineIdentity } from './uci.ts';
export { UciEngine, parseInfo, parseOption } from './uci.ts';

export type { EngineSpec, EngineCommand, WasmFlavor } from './engine.ts';
export { openEngine, resolveEngineCommand, wasmEngineFile } from './engine.ts';

export type { Classification, Color } from './score.ts';
export {
  classify, cpLoss, formatScore, moveAccuracy, negate, terminalScore, toWhite, winPct,
  winningChances,
} from './score.ts';

export type {
  AdvisorOptions, Analysis, Candidate, MoveReport, SideSummary, Summary, Trap,
} from './advisor.ts';
export { Advisor, formatCandidate, fromUci, toUci } from './advisor.ts';

export type { Review, ReviewOptions } from './review.ts';
export { formatReport, formatReview, formatSummary, reviewPgn, splitPgn } from './review.ts';

export type { FetchOptions } from './fetch.ts';
export { fetchChesscomGames, fetchLichessGames } from './fetch.ts';
