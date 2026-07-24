/**
 * Frozen test positions.
 *
 * The opening position is a poor regression target on its own: the four armies are too far
 * apart to interact, so perft from the start produces ZERO captures, en passant, castles or
 * promotions even at depth 4. Shallow opening perft therefore proves almost nothing about the
 * parts of move generation most likely to be wrong.
 *
 * TACTICAL is a real position reached by random play (seed 987654321, 64 plies) in which all
 * four armies are engaged. At depth 3 it exercises 11,646 captures and 32 en passant captures.
 */

export const TACTICAL =
  'R-0,0,0,0-0,0,0,1-0,0,0,0-0,0,0,0-0-' +
  '4,yR,yB,1,yK,yB,1,yR,3/6,yP,yP,1,yP,gN,3/4,yP,yP,8/' +
  'bR,bP,1,yP,4,yP,1,gP,2,gR/bN,bP,9,gP,2/bB,bP,yQ,8,gB,gP,1/' +
  '1,bP,10,gP,gK/bQ,bK,bP,7,gP,3/1,bP,4,bN,1,bB,1,gP,gN,1,gB/' +
  '1,bP,10,gP,gR/2,bR,1,bP,1,rP,2,rP,rP,gP,2/4,rP,2,rB,6/' +
  '3,rP,10/3,rR,rN,2,rK,rB,rN,rR,3';
