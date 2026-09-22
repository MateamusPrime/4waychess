/**
 * Locating and configuring a Stockfish process.
 *
 * Two sources, same UCI client:
 *  - a native binary (`{ path }`) — much faster and the strongest option; install Stockfish
 *    from https://stockfishchess.org and point at it;
 *  - the WASM build bundled in the `stockfish` npm package, run under Node. Zero setup.
 *    `lite-single` is the default: it loads in well under a second and is still far beyond
 *    any human. The multi-threaded flavours need SharedArrayBuffer and are slower to start.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { UciEngine } from './uci.ts';

export type WasmFlavor = 'lite-single' | 'lite' | 'single' | 'full';

export interface EngineSpec {
  /** Path to a native Stockfish binary. Takes precedence over `flavor`. */
  path?: string;
  /** WASM flavour from the `stockfish` package when no native path is given. */
  flavor?: WasmFlavor;
  threads?: number;
  /** Hash table size in MiB. */
  hashMb?: number;
  /** Path to Syzygy endgame tablebases, if you have them. */
  syzygyPath?: string;
}

export interface EngineCommand {
  command: string;
  args: string[];
  label: string;
}

export function wasmEngineFile(flavor: WasmFlavor = 'lite-single'): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('stockfish/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { buildVersion: string };
  const suffix = flavor === 'full' ? '' : `-${flavor}`;
  const file = join(dirname(pkgPath), 'bin', `stockfish-${pkg.buildVersion}${suffix}.js`);
  if (!existsSync(file)) throw new Error(`stockfish WASM flavour "${flavor}" not found at ${file}`);
  return file;
}

export function resolveEngineCommand(spec: EngineSpec = {}): EngineCommand {
  if (spec.path) {
    if (!existsSync(spec.path)) throw new Error(`no engine binary at ${spec.path}`);
    return { command: spec.path, args: [], label: spec.path };
  }
  const flavor = spec.flavor ?? 'lite-single';
  const file = wasmEngineFile(flavor);
  return { command: process.execPath, args: [file], label: `stockfish npm (${flavor})` };
}

/** Spawn, handshake, and apply the options in `spec`. MultiPV is left to the caller. */
export async function openEngine(spec: EngineSpec = {}): Promise<UciEngine> {
  const { command, args } = resolveEngineCommand(spec);
  const engine = await UciEngine.spawn(command, args);
  const opt = engine.identity.options;
  if (spec.threads !== undefined && opt.has('Threads')) {
    const max = opt.get('Threads')!.max ?? 1;
    await engine.setOption('Threads', Math.max(1, Math.min(spec.threads, max)));
  }
  if (spec.hashMb !== undefined && opt.has('Hash')) await engine.setOption('Hash', spec.hashMb);
  if (spec.syzygyPath && opt.has('SyzygyPath')) await engine.setOption('SyzygyPath', spec.syzygyPath);
  if (opt.has('UCI_ShowWDL')) await engine.setOption('UCI_ShowWDL', true);
  return engine;
}
