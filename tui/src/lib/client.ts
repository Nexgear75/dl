import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { State } from './types';

export function dataDir(): string {
  return process.env.DL_DATA_DIR || path.join(os.homedir(), '.local/share/dl');
}

export function socketPath(): string {
  return process.env.DL_SOCKET || path.join(dataDir(), 'dl.sock');
}

/** Finds the daemon binary: env override, next to this binary, then dev builds, then PATH. */
export function daemonBinary(): string {
  if (process.env.DL_DAEMON) return process.env.DL_DAEMON;
  const candidates = [
    path.join(path.dirname(process.execPath), 'dl-daemon'),
    path.resolve(import.meta.dir, '../../../daemon/target/release/dl-daemon'),
    path.resolve(import.meta.dir, '../../../daemon/target/debug/dl-daemon'),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {}
  }
  return 'dl-daemon';
}

function connectOnce(p: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(p);
    s.once('connect', () => {
      s.removeAllListeners('error');
      resolve(s);
    });
    s.once('error', reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function spawnDaemon(): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  const child = spawn(daemonBinary(), [], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

async function connectOrSpawn(): Promise<net.Socket> {
  const p = socketPath();
  try {
    return await connectOnce(p);
  } catch {}
  spawnDaemon();
  let lastErr: unknown;
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    try {
      return await connectOnce(p);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `cannot reach dl-daemon (${(lastErr as Error)?.message ?? 'unknown'}). See ${path.join(dataDir(), 'daemon.log')}`,
  );
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/**
 * JSON-lines client for dl-daemon. Emits:
 *  - 'state' (State) every ~500 ms
 *  - 'status' ('connected' | 'reconnecting')
 */
export class Client extends EventEmitter {
  private sock: net.Socket | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closing = false;

  static async connect(): Promise<Client> {
    const c = new Client();
    c.attach(await connectOrSpawn());
    return c;
  }

  private attach(sock: net.Socket) {
    this.sock = sock;
    this.buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => this.onData(chunk));
    sock.on('close', () => this.onClose());
    sock.on('error', () => {});
    this.emit('status', 'connected');
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.event === 'state') {
        this.emit('state', msg.data as State);
      } else if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error ?? 'error'));
      }
    }
  }

  private async onClose() {
    this.sock = null;
    for (const p of this.pending.values()) p.reject(new Error('daemon disconnected'));
    this.pending.clear();
    if (this.closing) return;
    this.emit('status', 'reconnecting');
    while (!this.closing) {
      try {
        this.attach(await connectOrSpawn());
        return;
      } catch {
        await sleep(1000);
      }
    }
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const sock = this.sock;
    if (!sock) return Promise.reject(new Error('daemon not connected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      sock.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  close() {
    this.closing = true;
    this.sock?.end();
  }
}

/** Connects without spawning (used by `dl --stop`). */
export async function connectExisting(): Promise<Client | null> {
  try {
    const s = await connectOnce(socketPath());
    const c = new Client();
    (c as any).attach(s);
    return c;
  } catch {
    return null;
  }
}
