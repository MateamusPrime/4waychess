// Copy the single-threaded lite Stockfish WASM build next to the page so the browser can load
// it as a Web Worker. Single-threaded means no cross-origin isolation headers are needed, so
// it works from any static host.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const pkgPath = require.resolve('stockfish/package.json');
const { buildVersion } = JSON.parse(readFileSync(pkgPath, 'utf8'));
const bin = join(dirname(pkgPath), 'bin');
const out = new URL('../vendor/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
for (const ext of ['js', 'wasm']) {
  copyFileSync(join(bin, `stockfish-${buildVersion}-lite-single.${ext}`), join(out, `stockfish.${ext}`));
}
console.log(`vendored stockfish ${buildVersion} lite-single`);
