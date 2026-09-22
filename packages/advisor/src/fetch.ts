/**
 * Download finished games from Lichess and chess.com through their public APIs, for review.
 * Both endpoints are unauthenticated and documented:
 *   https://lichess.org/api#tag/Games/operation/apiGamesUser
 *   https://www.chess.com/news/view/published-data-api
 */

export interface FetchOptions {
  /** Newest games first; how many to return. */
  max?: number;
  fetchImpl?: typeof fetch;
}

export async function fetchLichessGames(user: string, opts: FetchOptions = {}): Promise<string[]> {
  const f = opts.fetchImpl ?? fetch;
  const max = opts.max ?? 1;
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(user)}?max=${max}&clocks=false&evals=false&opening=true`;
  const res = await f(url, { headers: { Accept: 'application/x-chess-pgn' } });
  if (!res.ok) throw new Error(`lichess: ${res.status} ${res.statusText} for ${user}`);
  const text = await res.text();
  return text.split(/\n\n\n+/).map((g) => g.trim()).filter(Boolean);
}

export async function fetchChesscomGames(user: string, opts: FetchOptions & { year?: number; month?: number } = {}): Promise<string[]> {
  const f = opts.fetchImpl ?? fetch;
  const now = new Date();
  const year = opts.year ?? now.getUTCFullYear();
  const month = opts.month ?? now.getUTCMonth() + 1;
  const mm = String(month).padStart(2, '0');
  const url = `https://api.chess.com/pub/player/${encodeURIComponent(user.toLowerCase())}/games/${year}/${mm}`;
  const res = await f(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`chess.com: ${res.status} ${res.statusText} for ${user} ${year}/${mm}`);
  const body = (await res.json()) as { games?: { pgn?: string }[] };
  const pgns = (body.games ?? []).map((g) => g.pgn).filter((p): p is string => typeof p === 'string');
  const max = opts.max ?? 1;
  return pgns.slice(-max).reverse();
}
