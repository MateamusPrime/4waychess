/**
 * Bot worker — search off the UI thread.
 *
 * Deep thinking takes up to a few seconds per move; on the main thread that is dropped frames
 * and a frozen board mid-animation. Positions travel as FEN4 (which carries en passant rights
 * precisely so this transfer loses nothing), and replies are bare from/to/promotion that the
 * main thread re-validates against its own legal moves — the worker is a compute servant,
 * never an authority.
 *
 * The app runs two instances: one for bot moves, one for hints and game review, so a review
 * of a long game never delays the next bot move. Reviews are processed one move per task, so
 * a newer request (or a cancel) can pre-empt a review between moves.
 */

import { computeHint, computeMove, reviewItem } from './analysis.ts';
import type { AnalysisReply, AnalysisRequest } from './analysis.ts';

const post = (m: AnalysisReply): void =>
  (self as unknown as { postMessage(m: AnalysisReply): void }).postMessage(m);

/** The review in progress, if any. Replaced — never queued — by the next review or cancel. */
let review: Extract<AnalysisRequest, { type: 'review' }> | null = null;
let cursor = 0;
/** Exactly one step is ever scheduled, however requests and cancels interleave. */
let scheduled = false;

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(reviewStep, 0);
}

function reviewStep(): void {
  scheduled = false;
  const r = review;
  if (r === null) return;
  if (cursor >= r.items.length) {
    post({ type: 'review-done', id: r.id });
    review = null;
    return;
  }
  const item = r.items[cursor++];
  post({ type: 'review-item', id: r.id, ply: item.ply, verdict: reviewItem(r.mode, item) });
  schedule();
}

self.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  const req = e.data;
  switch (req.type) {
    case 'move':
      post(computeMove(req));
      break;
    case 'hint':
      post(computeHint(req));
      break;
    case 'review':
      review = req;
      cursor = 0;
      schedule();
      break;
    case 'cancel':
      review = null;
      break;
  }
};
