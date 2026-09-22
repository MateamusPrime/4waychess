/**
 * Post-game review: replay a PGN through the advisor and grade every move.
 *
 * This is the training loop that is legitimate everywhere: play online unaided, then bring
 * the finished game here. The report says where the game turned, which moves were traps you
 * fell into, and how accurate each side was.
 */

import { Chess } from 'chess.js';
import { Advisor } from './advisor.ts';
import type { AdvisorOptions, MoveReport, Summary } from './advisor.ts';
import { formatScore } from './score.ts';

export interface Review {
  headers: Record<string, string>;
  reports: MoveReport[];
  summary: Summary;
}

export interface ReviewOptions extends Omit<AdvisorOptions, 'fen'> {
  /** Called after each graded move, for progress output. */
  onMove?: (report: MoveReport, index: number, total: number) => void;
}

/** Split a PGN file that may hold several games into one string per game. */
export function splitPgn(text: string): string[] {
  const games: string[] = [];
  let current: string[] = [];
  let seenMoves = false;
  for (const line of text.split(/\r?\n/)) {
    const isTag = /^\s*\[\w+\s+"/.test(line);
    if (isTag && seenMoves) {
      games.push(current.join('\n').trim());
      current = [];
      seenMoves = false;
    }
    if (!isTag && line.trim() !== '') seenMoves = true;
    current.push(line);
  }
  const last = current.join('\n').trim();
  if (last) games.push(last);
  return games.filter((g) => g.length > 0);
}

export async function reviewPgn(pgn: string, opts: ReviewOptions): Promise<Review> {
  const source = new Chess();
  source.loadPgn(pgn);
  const headers = source.getHeaders();
  const setup = headers.FEN;
  const moves = source.history();

  const advisor = new Advisor({ ...opts, fen: setup });
  const reports: MoveReport[] = [];
  for (let i = 0; i < moves.length; i++) {
    const r = await advisor.play(moves[i]);
    reports.push(r);
    opts.onMove?.(r, i, moves.length);
  }
  return { headers, reports, summary: advisor.summary() };
}

const MARK: Record<MoveReport['classification'], string> = {
  best: '!', good: '', inaccuracy: '?!', mistake: '?', blunder: '??',
};

export function formatReport(r: MoveReport): string {
  const num = r.color === 'w' ? `${r.moveNumber}.` : `${r.moveNumber}...`;
  const evalStr = `${formatScore(r.before.scoreWhite)} → ${formatScore(r.color === 'w' ? r.scoreAfter : { type: r.scoreAfter.type, value: -r.scoreAfter.value })}`;
  let line = `${num.padEnd(6)} ${(r.san + MARK[r.classification]).padEnd(8)} ${evalStr.padEnd(18)} ${r.classification.padEnd(10)}`;
  if (r.classification !== 'best' && r.bestSan) line += ` best ${r.bestSan}`;
  if (r.fellForTrap) line += '  [trap]';
  if (r.before.onlyMove && r.rank === 1) line += '  [only move]';
  return line;
}

export function formatSummary(s: Summary): string {
  const side = (label: string, x: Summary['w']): string =>
    `${label.padEnd(6)} accuracy ${x.accuracy.toFixed(1).padStart(5)}%  ` +
    `acpl ${x.averageCpLoss.toFixed(0).padStart(3)}  ` +
    `best ${x.counts.best}  good ${x.counts.good}  inacc ${x.counts.inaccuracy}  ` +
    `mistakes ${x.counts.mistake}  blunders ${x.counts.blunder}`;
  return [side('White', s.w), side('Black', s.b)].join('\n');
}

export function formatReview(review: Review): string {
  const h = review.headers;
  const title = [h.White, h.Black].every(Boolean)
    ? `${h.White} vs ${h.Black}${h.Result ? `  (${h.Result})` : ''}${h.Date ? `  ${h.Date}` : ''}`
    : 'Game review';
  const lines = [title, ''];
  for (const r of review.reports) lines.push(formatReport(r));
  lines.push('', formatSummary(review.summary));

  const turning = review.reports
    .filter((r) => r.classification === 'blunder' || r.classification === 'mistake')
    .sort((a, b) => b.loss - a.loss)
    .slice(0, 3);
  if (turning.length) {
    lines.push('', 'Where it turned:');
    for (const r of turning) {
      const num = r.color === 'w' ? `${r.moveNumber}.` : `${r.moveNumber}...`;
      lines.push(`  ${num} ${r.san} lost ${r.loss.toFixed(0)} points of win probability; ${r.bestSan} kept it.`);
    }
  }
  return lines.join('\n');
}
