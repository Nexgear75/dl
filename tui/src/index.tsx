import React from 'react';
import { render } from 'ink';
import { App } from './App';
import { Client, connectExisting, socketPath } from './lib/client';

const VERSION = '0.1.0';

const HELP = `dl ${VERSION} — terminal download manager (aria2 + yt-dlp)

Usage:
  dl                 open the interface
  dl <link|file>     open and add a link, magnet, .torrent, .txt or .md
  dl --stop          stop the background daemon
  dl --version

Inside: press ? for keys. Config: ~/.config/dl/config.toml`;

async function main() {
  const args = process.argv.slice(2);
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

  let client: Client;
  try {
    client = await Client.connect();
  } catch (e) {
    console.error(`dl: ${(e as Error).message}\n(socket: ${socketPath()})`);
    process.exit(1);
  }

  const initial = args.filter((a) => !a.startsWith('--')).join(' ');
  const app = render(<App client={client} initialInput={initial || undefined} />, {
    alternateScreen: true,
    exitOnCtrlC: false,
    maxFps: 30,
  });
  await app.waitUntilExit();
  client.close();
  process.exit(0);
}

void main();
