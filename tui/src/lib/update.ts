/**
 * Self-update from GitHub Releases, Claude Code style: at most once an hour a
 * detached process checks the latest release, downloads the archive for this
 * Mac, verifies its checksum and renames the new binaries over the installed
 * ones. The running app is untouched; the next launch is the new version and
 * says so once. Also keeps the Homebrew dependency that breaks most often
 * up to date (once a day).
 *
 * Opt out with DL_NO_AUTOUPDATE=1. Same file in tf, only the constants differ.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import pkg from '../../package.json';
import { dataDir } from './client';

export const VERSION: string = pkg.version;

const NAME = 'dl';
const REPO = 'Nexgear75/dl';
/** files shipped in the release archive, installed side by side */
const BINS = ['dl', 'dl-daemon'];
/** Homebrew formulas upgraded in the background (sites change, old versions break) */
const BREW_DEPS = ['yt-dlp'];
/** other apps installed next to this one whose update check we trigger too */
const SIBLINGS: string[] = [];
const OPT_OUT = 'DL_NO_AUTOUPDATE';

const CHECK_EVERY = 60 * 60 * 1000;
const DEPS_EVERY = 24 * 60 * 60 * 1000;
const LOCK_STALE = 15 * 60 * 1000;

interface State {
  lastCheck?: number;
  lastDeps?: number;
  /** set by the updater, shown and cleared by the next launch */
  updated?: { from: string; to: string };
  lastError?: string;
}

const statePath = () => path.join(dataDir(), 'update.json');

function readState(): State {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(patch: Partial<State>) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const next = { ...readState(), ...patch };
    const tmp = `${statePath()}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, statePath());
  } catch {}
}

/** Folder holding the installed binaries, or null for a dev run (`bun run`) or a read-only install. */
export function installDir(): string | null {
  if (path.basename(process.execPath) !== NAME) return null;
  try {
    const dir = path.dirname(fs.realpathSync(process.execPath));
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch {
    return null;
  }
}

export function newer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** Latest release version, from the /releases/latest redirect (no API rate limit). */
export async function latestVersion(): Promise<string | null> {
  const res = await fetch(`https://github.com/${REPO}/releases/latest`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  const loc = res.headers.get('location') ?? '';
  const m = loc.match(/\/releases\/tag\/v?([^/?#]+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Installs the latest release if newer. Returns the new version, or null when already up to date. */
export async function updateNow(log: (s: string) => void = () => {}): Promise<string | null> {
  const dir = installDir();
  if (!dir) throw new Error(`not a release install (${process.execPath}): update the sources and run scripts/install.sh`);
  const latest = await latestVersion();
  if (!latest) throw new Error(`no release found on github.com/${REPO}`);
  if (!newer(latest, VERSION)) return null;

  const asset = `${NAME}-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`;
  const base = `https://github.com/${REPO}/releases/download/v${latest}`;
  log(`downloading ${NAME} ${latest}…`);
  const [archive, sums] = await Promise.all([download(`${base}/${asset}`), download(`${base}/checksums.txt`)]);
  const expected = new TextDecoder()
    .decode(sums)
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find((p) => p[1]?.replace(/^\*/, '') === asset)?.[0];
  const actual = new Bun.CryptoHasher('sha256').update(archive).digest('hex');
  if (!expected || expected.toLowerCase() !== actual) throw new Error(`checksum mismatch for ${asset}`);

  // extract next to the binaries so the final rename is atomic (same volume)
  const tmp = fs.mkdtempSync(path.join(dir, `.${NAME}-update-`));
  try {
    const tarball = path.join(tmp, asset);
    fs.writeFileSync(tarball, archive);
    const tar = spawnSync('tar', ['-xzf', tarball, '-C', tmp], { encoding: 'utf8' });
    if (tar.status !== 0) throw new Error(`cannot extract ${asset}: ${tar.stderr.trim()}`);
    for (const b of BINS) {
      const p = path.join(tmp, b);
      if (!fs.existsSync(p)) throw new Error(`${b} missing from ${asset}`);
      fs.chmodSync(p, 0o755);
    }
    for (const b of BINS) fs.renameSync(path.join(tmp, b), path.join(dir, b));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  writeState({ updated: { from: VERSION, to: latest }, lastError: undefined });
  return latest;
}

function findBrew(): string | null {
  for (const p of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) if (fs.existsSync(p)) return p;
  return null;
}

/** `brew upgrade` the dependencies that were installed with Homebrew. */
export function upgradeDeps(stdio: 'ignore' | 'inherit' = 'ignore') {
  const brew = findBrew();
  if (!brew) return;
  const env = { ...process.env, HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_ENV_HINTS: '1' };
  for (const f of BREW_DEPS) {
    const installed = spawnSync(brew, ['list', '--versions', f], { env, stdio: 'ignore' }).status === 0;
    if (installed) spawnSync(brew, ['upgrade', '--formula', f], { env, stdio, timeout: 10 * 60_000 });
  }
}

function withLock(fn: () => Promise<void>): Promise<void> {
  const lock = path.join(dataDir(), 'update.lock');
  fs.mkdirSync(dataDir(), { recursive: true });
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs < LOCK_STALE) return Promise.resolve();
      fs.writeFileSync(lock, String(process.pid));
    } catch {
      return Promise.resolve();
    }
  }
  return fn().finally(() => fs.rmSync(lock, { force: true }));
}

/** Body of the detached `__auto-update` process. */
export async function autoUpdateWorker() {
  await withLock(async () => {
    try {
      await updateNow();
    } catch (e) {
      writeState({ lastError: `${new Date().toISOString()} ${(e as Error).message}` });
    }
    const st = readState();
    if (Date.now() - (st.lastDeps ?? 0) >= DEPS_EVERY) {
      writeState({ lastDeps: Date.now() });
      upgradeDeps();
    }
  });
}

function detach(bin: string, arg: string) {
  try {
    spawn(bin, [arg], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

/** Called at launch: starts a background check when the last one is older than an hour. Never blocks. */
export function maybeAutoUpdate() {
  if (process.env[OPT_OUT] || process.env.CI) return;
  const dir = installDir();
  if (!dir) return;
  for (const s of SIBLINGS) {
    const p = path.join(dir, s);
    if (fs.existsSync(p)) detach(p, '__maybe-update');
  }
  if (Date.now() - (readState().lastCheck ?? 0) < CHECK_EVERY) return;
  writeState({ lastCheck: Date.now() });
  detach(process.execPath, '__auto-update');
}

/** "Updated to vX" once after an update, then null. */
export function takeUpdateNotice(): string | null {
  const st = readState();
  if (!st.updated) return null;
  writeState({ updated: undefined });
  // the notice is only true if this binary is the new one
  return st.updated.to === VERSION ? `${NAME} updated to v${VERSION}` : null;
}

/** `dl update`: foreground update with output, then the dependencies. */
export async function updateCommand() {
  try {
    const v = await updateNow((s) => console.log(s));
    console.log(v ? `✓ ${NAME} ${VERSION} → ${v}` : `✓ ${NAME} ${VERSION} is up to date`);
  } catch (e) {
    console.error(`${NAME} update: ${(e as Error).message}`);
    process.exitCode = 1;
  }
  for (const s of SIBLINGS) {
    const dir = installDir();
    const p = dir && path.join(dir, s);
    if (p && fs.existsSync(p)) spawnSync(p, ['update'], { stdio: 'inherit' });
  }
  if (!process.argv.includes('--no-deps') && BREW_DEPS.length > 0 && findBrew()) {
    console.log(`checking ${BREW_DEPS.join(', ')}…`);
    upgradeDeps('inherit');
    writeState({ lastDeps: Date.now() });
  }
}
