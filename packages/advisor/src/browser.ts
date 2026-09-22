/**
 * Browser entry: everything in the package that has no Node dependency, plus a Web Worker
 * transport for the WASM Stockfish from the `stockfish` npm package.
 *
 * The worker script is one of the `stockfish-*.js` files from that package served next to its
 * `.wasm`; the single-threaded flavours need no cross-origin isolation headers.
 */

import { UciEngine } from './uci.ts';
import type { UciTransport } from './uci.ts';

export type { Score, InfoLine, GoLimits, SearchLine, SearchOutcome, UciOption, EngineIdentity, UciTransport } from './uci.ts';
export { UciEngine, parseInfo, parseOption } from './uci.ts';
export type { Classification, Color } from './score.ts';
export {
  classify, cpLoss, formatScore, moveAccuracy, negate, terminalScore, toWhite, winPct, winningChances,
} from './score.ts';
export type { AdvisorOptions, Analysis, Candidate, MoveReport, SideSummary, Summary, Trap } from './advisor.ts';
export { Advisor, AnalysisAborted, formatCandidate, fromUci, toUci } from './advisor.ts';

export function workerTransport(worker: Worker): UciTransport {
  return {
    send: (line) => worker.postMessage(line),
    onLine: (cb) => {
      worker.addEventListener('message', (e: MessageEvent) => {
        if (typeof e.data === 'string') for (const line of e.data.split('\n')) if (line) cb(line);
      });
    },
    onExit: (cb) => {
      worker.addEventListener('error', (e) => cb(new Error(`engine worker error: ${e.message}`)));
    },
    close: async () => worker.terminate(),
  };
}

/** Start a WASM Stockfish worker from `scriptUrl` and complete the UCI handshake. */
export function openWorkerEngine(scriptUrl: string): Promise<UciEngine> {
  return UciEngine.connect(workerTransport(new Worker(scriptUrl)));
}
