# dl

Full-screen terminal download manager built on **aria2** (HTTP/FTP, torrents, magnets) and **yt-dlp** (video sites), with vim keys.

```
 dl  ↓ 12.4 MB/s   ↑ 0 B/s                              2 active · 3 total · ~/Downloads
────────────────────────────────────────────────────────────────────────────────────────
▌ ↓ ubuntu-24.04-desktop-amd64.iso                                                  HTTP
▌   ████████████████▍──────────────   54.1%  3.20 GB / 5.91 GB    8.10 MB/s    5m42s

  ↓ Big Buck Bunny                                                               TORRENT
    ████▏──────────────────────────   13.0%  54.2 MB / 417 MB     4.30 MB/s    1m24s

  ✓ Me at the zoo                                                                  VIDEO
    ███████████████████████████████  100.0%  463 KB / 463 KB                     done
────────────────────────────────────────────────────────────────────────────────────────
 ADD  › ~/Downloads/fi                                                         
i add · p pause · P all · dd remove · l/L limit · c clear · ⏎ details · ? help · q quit
```

## Features

- **One input, automatic detection**: paste a URL, a `magnet:` link, or type a path to a `.torrent`, `.metalink`, `.txt` or `.md` file. The type shows up live while you type.
- **Several downloads at once**: add new ones anytime, each with its own progress bar, speed (MB/s, base 1024) and ETA.
- **Torrents**: pick the files to download before it starts (magnets too, once metadata arrives). No seeding after completion.
- **Videos** (YouTube, Vimeo, Twitch, X, TikTok… via yt-dlp): choose quality and audio language when the video has several tracks. Playlists are expanded. Prefix any URL with `yt:` to force yt-dlp.
- **Link lists**: a `.txt`/`.md` file (or several pasted links) adds everything at once; quality/language is asked once for the whole batch.
- **Path autocompletion**: directories first, prefix → substring → fuzzy matching, only relevant files shown.
- **Background daemon**: downloads keep running after you quit; `dl` reattaches to them. The session survives restarts.
- Pause/resume, cancel (deletes partial data), retry, per-download and global speed limits, macOS notifications.

## Install

Requirements: `aria2`, `yt-dlp`, `ffmpeg` (runtime), `cargo` and `bun` (build).

```sh
brew install aria2 yt-dlp ffmpeg
./scripts/install.sh          # installs dl and dl-daemon into ~/.local/bin
```

## Usage

```sh
dl                      # open the interface
dl <link|file>          # open and add something right away
dl --stop               # stop the background daemon
```

### Keys

| Normal mode | |
|---|---|
| `j` `k` / `↓` `↑` | move |
| `gg` / `G` | top / bottom |
| `ctrl-d` / `ctrl-u` | half page down / up |
| `i` `a` | add a link, magnet or file |
| `⏎` | details · pick torrent files |
| `p` `space` | pause / resume |
| `P` | pause / resume all |
| `dd` `x` | remove (cancelling deletes partial data, finished files are kept) |
| `r` | retry a failed download |
| `l` / `L` | speed limit for the selection / global (`2M`, `500K`, `0`) |
| `c` | clear finished downloads |
| `o` | reveal in Finder |
| `y` | copy path or URL |
| `?` | help |
| `q` / `Q` | quit (downloads continue) / quit and stop the daemon |

| Input | |
|---|---|
| `tab` `→` | accept completion |
| `↑` `↓` `ctrl-n` `ctrl-p` | browse completions |
| `⏎` | submit (on a partial path: accept the highlighted entry) |
| `ctrl-w` / `ctrl-u` | delete word / line |
| `esc` | back to normal mode |

Pickers: `j`/`k`, `space` toggle, `a` all/none, `⏎` confirm, `esc` cancel.

## Configuration

`~/.config/dl/config.toml` (created on first run):

```toml
download_dir = "~/Downloads"
max_concurrent = 5      # simultaneous downloads (aria2 and yt-dlp each)
connections = 16        # connections per HTTP download
global_limit = "0"      # e.g. "5M"
notifications = true
aria2c_path = "aria2c"
ytdlp_path = "yt-dlp"
```

State, aria2 session and logs live in `~/.local/share/dl/` (`daemon.log`).

## Architecture

```
dl (Ink/React, compiled with bun)  ⇄  ~/.local/share/dl/dl.sock  ⇄  dl-daemon (Rust/tokio)
                                       JSON lines                      ├─ aria2c (JSON-RPC, localhost + secret)
                                                                       └─ yt-dlp processes
```

- `daemon/` — Rust daemon: spawns and drives `aria2c` over JSON-RPC, runs yt-dlp jobs, merges both into one list pushed to clients every 500 ms. Started on demand by `dl`.
- `tui/` — Ink 8 interface. Talks to the daemon over a Unix socket; spawns it if needed.

Development:

```sh
cd daemon && cargo test && cargo build
cd tui && bun install && bun test && bun run dev   # uses daemon/target/debug if not installed
```
