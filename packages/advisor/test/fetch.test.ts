import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchChesscomGames, fetchLichessGames } from '../src/fetch.ts';

const fake = (status: number, body: string, json?: unknown): typeof fetch =>
  (async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    text: async () => body,
    json: async () => json,
  })) as unknown as typeof fetch;

describe('fetching online games', () => {
  test('lichess PGN export is split per game', async () => {
    const pgn = '[Event "a"]\n\n1. e4 *\n\n\n[Event "b"]\n\n1. d4 *\n\n\n';
    const games = await fetchLichessGames('someone', { max: 2, fetchImpl: fake(200, pgn) });
    assert.equal(games.length, 2);
    assert.match(games[1], /d4/);
  });

  test('chess.com monthly archive returns newest games first', async () => {
    const games = await fetchChesscomGames('Someone', {
      max: 2, year: 2026, month: 9,
      fetchImpl: fake(200, '', { games: [{ pgn: 'old' }, { pgn: 'mid' }, { pgn: 'new' }] }),
    });
    assert.deepEqual(games, ['new', 'mid']);
  });

  test('http errors surface as exceptions', async () => {
    await assert.rejects(() => fetchLichessGames('nobody', { fetchImpl: fake(404, '') }), /404/);
  });
});
