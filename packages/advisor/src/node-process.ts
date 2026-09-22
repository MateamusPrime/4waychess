/**
 * Node transport: a UCI engine as a child process. Works for a native Stockfish binary and for
 * the WASM build run under Node (`node stockfish-19-lite-single.js`), which speaks the same
 * stdin/stdout protocol.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { UciEngine } from './uci.ts';
import type { UciTransport } from './uci.ts';

export function processTransport(command: string, args: string[] = []): UciTransport {
  const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const rl = createInterface({ input: proc.stdout });
  let exited = false;
  const exitedPromise = new Promise<void>((resolve) => proc.once('exit', () => { exited = true; resolve(); }));
  return {
    send: (line) => { proc.stdin.write(line + '\n'); },
    onLine: (cb) => { rl.on('line', cb); },
    onExit: (cb) => {
      proc.on('exit', (code, signal) => cb(new Error(`engine exited (code ${code}, signal ${signal})`)));
      proc.on('error', (err) => cb(err));
    },
    close: async () => {
      if (exited) return;
      const timer = setTimeout(() => proc.kill(), 2000);
      await exitedPromise;
      clearTimeout(timer);
    },
  };
}

export function spawnEngine(command: string, args: string[] = []): Promise<UciEngine> {
  return UciEngine.connect(processTransport(command, args));
}
