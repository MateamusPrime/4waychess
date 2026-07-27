/**
 * Bot worker — search off the UI thread.
 *
 * The deep engine thinks for 60-300ms per move; on the main thread that is dropped frames and
 * a frozen board mid-animation. Positions travel as FEN4 (which now carries en passant rights
 * precisely so this transfer loses nothing), and the reply is a bare from/to/promotion that
 * the main thread re-validates against its own legal move list — the worker is a compute
 * servant, never an authority.
 */

import { FFA_RULES, TEAMS_RULES, parseFen4 } from '@4wc/engine';
import type { Army } from '@4wc/engine';
import { makeBot } from '@4wc/bots';
import type { Difficulty, PersonalityId } from '@4wc/bots';

interface BotRequest {
  id: number;
  fen: string;
  mode: 'ffa' | 'teams';
  army: Army;
  kind: PersonalityId;
  difficulty: Difficulty;
  seed: number;
}

interface BotReply {
  id: number;
  army: Army;
  move: { from: number; to: number; promotion: string | null } | null;
}

self.onmessage = (e: MessageEvent<BotRequest>) => {
  const req = e.data;
  const pos = parseFen4(req.fen, req.mode === 'teams' ? TEAMS_RULES : FFA_RULES);
  const bot = makeBot(req.kind, req.difficulty, req.seed);
  const move = bot.pick(pos, req.army);
  const reply: BotReply = {
    id: req.id,
    army: req.army,
    move: move === null ? null : { from: move.from, to: move.to, promotion: move.promotion },
  };
  (self as unknown as { postMessage(m: BotReply): void }).postMessage(reply);
};
