import React from 'react';
import { render } from 'ink';
import { App } from './App';
import { Client, connectExisting, socketPath } from './lib/client';
import { VERSION, autoUpdateWorker, maybeAutoUpdate, takeUpdateNotice, updateCommand } from './lib/update';

const HELP = `dl ${VERSION} — terminal download manager (aria2 + yt-dlp)

Usage:
  dl                 open the interface
  dl <link|file>     open and add a link, magnet, .torrent, .txt or .md
  dl --stop          stop the background daemon
  dl update          update now (dl and yt-dlp)
  dl --version

Inside: press ? for keys. Config: ~/.config/dl/config.toml
Updates install themselves in the background (DL_NO_AUTOUPDATE=1 to disable).`;

async function main() {
  const args = process.argv.slice(2);
  // hidden commands used by the background updater
  if (args[0] === '__auto-update') return autoUpdateWorker();
  if (args[0] === '__maybe-update') return maybeAutoUpdate();
  if (args[0] === 'update' && args.length <= 2) return updateCommand();
  if (args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    return;
  }
  if (args.includes('-V') || args.includes('--version')) {
    console.log(`dl ${VERSION}`);
    return;
  }
  if (args.includes('--stop')) {
    const c = await connectExisting();
    if (!c) {
      console.log('dl-daemon is not running');
      return;
    }
    await c.call('shutdown').catch(() => {});
    c.close();
    console.log('dl-daemon stopped');
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('dl needs an interactive terminal');
    process.exit(1);
  }

  maybeAutoUpdate();
  let client: Client;
  try {
    client = await Client.connect();
  } catch (e) {
    console.error(`dl: ${(e as Error).message}\n(socket: ${socketPath()})`);
    process.exit(1);
  }

  const initial = args.filter((a) => !a.startsWith('--')).join(' ');
  const app = render(<App client={client} initialInput={initial || undefined} startNotice={takeUpdateNotice() ?? undefined} />, {
    alternateScreen: true,
    exitOnCtrlC: false,
    maxFps: 30,
  });
  await app.waitUntilExit();
  client.close();
  process.exit(0);
}

void main();
