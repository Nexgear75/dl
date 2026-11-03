import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, usePaste, useWindowSize } from 'ink';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Client } from './lib/client';
import type { AddResult, Detection, Download, State, VideoInfo, VideoPrefs } from './lib/types';
import { formatBytes, formatSpeed, parseSize, tildify, truncate } from './lib/format';
import { isPathLike, pathExists, suggest, type Suggestion } from './lib/complete';
import { splitBurst } from './lib/keys';
import { Header } from './components/Header';
import { DownloadRow, rowHeight } from './components/DownloadRow';
import { Picker, pickerHeight, type PickerItem } from './components/Picker';
import { Help } from './components/Help';
import { InputLine, Suggestions, suggestionsHeight } from './components/InputBar';
import { ACCENT, DIM, KIND } from './components/theme';

// ---------------------------------------------------------------- modes

type Purpose = 'link' | 'dir' | 'limit';

interface InputMode {
  t: 'input';
  purpose: Purpose;
  label: string;
  color: string;
  placeholder?: string;
  value: string;
  cursor: number;
  sel: number;
  /** user navigated the completion list explicitly */
  nav: boolean;
  resolve: (v: string | null) => void;
}

interface PickerMode {
  t: 'picker';
  title: string;
  subtitle?: string;
  items: PickerItem[];
  multi: boolean;
  cursor: number;
  checked: boolean[];
  resolve: (v: number[] | null) => void;
}

type Mode =
  | { t: 'normal' }
  | InputMode
  | PickerMode
  | { t: 'help' }
  | { t: 'confirm'; message: string; resolve: (b: boolean) => void }
  | { t: 'busy'; message: string };

interface Notice {
  text: string;
  level: 'info' | 'ok' | 'error';
}

const QUALITIES = [2160, 1440, 1080, 720, 480, 360];
const COMMON_LANGS: [string, string][] = [
  ['fr', 'French'],
  ['en', 'English'],
  ['es', 'Spanish'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['ja', 'Japanese'],
];

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function qualityLabel(h: number): string {
  const tag: Record<number, string> = { 4320: '8K', 2160: '4K', 1440: '2K', 1080: 'Full HD', 720: 'HD' };
  return tag[h] ? `${h}p · ${tag[h]}` : `${h}p`;
}

function kindTag(det: Detection | null): { text: string; color: string } | null {
  if (!det) return null;
  switch (det.kind) {
    case 'http':
      return { text: 'HTTP', color: KIND.http.color };
    case 'magnet':
      return { text: 'MAGNET', color: KIND.torrent.color };
    case 'torrent':
      return { text: 'TORRENT', color: KIND.torrent.color };
    case 'metalink':
      return { text: 'METALINK', color: 'blue' };
    case 'video':
      return { text: 'VIDEO', color: KIND.video.color };
    case 'batch':
    case 'multi':
      return { text: `${det.links} LINKS`, color: 'yellow' };
  }
}

function copy(text: string) {
  const p = spawn('pbcopy');
  p.on('error', () => {});
  p.stdin.end(text);
}

// ---------------------------------------------------------------- text editing

function editInput(m: InputMode, input: string, key: any): InputMode | null {
  const chars = Array.from(m.value);
  let c = m.cursor;
  const set = (arr: string[], cursor: number): InputMode => ({ ...m, value: arr.join(''), cursor, sel: 0, nav: false });
  if (key.backspace || key.delete) {
    if (c === 0) return m;
    chars.splice(c - 1, 1);
    return set(chars, c - 1);
  }
  if (key.leftArrow || (key.ctrl && input === 'b')) return { ...m, cursor: Math.max(0, c - 1) };
  if (key.rightArrow || (key.ctrl && input === 'f')) return { ...m, cursor: Math.min(chars.length, c + 1) };
  if (key.home || (key.ctrl && input === 'a')) return { ...m, cursor: 0 };
  if (key.end || (key.ctrl && input === 'e')) return { ...m, cursor: chars.length };
  if (key.ctrl && input === 'u') return set(chars.slice(c), 0);
  if (key.ctrl && input === 'k') return set(chars.slice(0, c), c);
  if (key.ctrl && input === 'w') {
    let i = c;
    const sep = (ch: string) => ch === '/' || ch === ' ';
    while (i > 0 && sep(chars[i - 1])) i--;
    while (i > 0 && !sep(chars[i - 1])) i--;
    chars.splice(i, c - i);
    return set(chars, i);
  }
  if (input && !key.ctrl && !key.meta && !key.return && !key.tab && !key.escape) {
    // never insert control characters into the text
    const ins = Array.from(input.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, ''));
    if (ins.length === 0) return m;
    chars.splice(c, 0, ...ins);
    return set(chars, c + ins.length);
  }
  return null;
}

function suggestionsFor(mode: Mode): Suggestion[] {
  if (mode.t !== 'input' || (mode.purpose !== 'link' && mode.purpose !== 'dir')) return [];
  const list = suggest(mode.value, mode.purpose === 'dir' ? 'dir' : 'link');
  // hide the list when the only match is exactly what is typed
  if (list.length === 1 && list[0].value === mode.value) return [];
  return list;
}

// ---------------------------------------------------------------- app

interface Props {
  client: Client;
  initialInput?: string;
  /** shown once at startup (e.g. "dl updated to v0.2.0") */
  startNotice?: string;
}

export function App({ client, initialInput, startNotice }: Props) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const width = Math.max(40, columns);

  const [state, setState] = useState<State | null>(null);
  const [connection, setConnection] = useState<'connected' | 'reconnecting'>('connected');
  const [frame, setFrame] = useState(0);
  const [mode, setModeState] = useState<Mode>({ t: 'normal' });
  // the key handler reads the mode from this ref so that several keys
  // delivered in one chunk each see the result of the previous one
  const modeRef = useRef<Mode>(mode);
  const setMode = useCallback((m: Mode) => {
    modeRef.current = m;
    setModeState(m);
  }, []);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [detected, setDetected] = useState<{ value: string; det: Detection | null; error?: string } | null>(null);
  const [spin, setSpin] = useState(0);

  const lastIdx = useRef(0);
  const scroll = useRef(0);
  const pendingKey = useRef<{ k: string; at: number } | null>(null);
  const dismissed = useRef<Set<string>>(new Set());
  const flowToken = useRef(0);
  const stateRef = useRef<State | null>(null);
  stateRef.current = state;

  // ------------------------------------------------ daemon events
  useEffect(() => {
    const onState = (s: State) => {
      setState(s);
      setFrame((f) => f + 1);
    };
    const onStatus = (s: 'connected' | 'reconnecting') => setConnection(s);
    client.on('state', onState);
    client.on('status', onStatus);
    return () => {
      client.off('state', onState);
      client.off('status', onStatus);
    };
  }, [client]);

  // notices fade out
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.level === 'error' ? 10000 : 5000);
    return () => clearTimeout(t);
  }, [notice]);

  // spinner while busy
  useEffect(() => {
    if (mode.t !== 'busy') return;
    const t = setInterval(() => setSpin((s) => s + 1), 90);
    return () => clearInterval(t);
  }, [mode.t]);

  const say = useCallback((text: string, level: Notice['level'] = 'info') => setNotice({ text, level }), []);
  useEffect(() => {
    if (startNotice) say(startNotice, "ok");
  }, []);

  // ------------------------------------------------ promise-based dialogs
  const ask = useCallback(
    (opts: { purpose: Purpose; label: string; color: string; initial?: string; placeholder?: string }) =>
      new Promise<string | null>((resolve) => {
        const value = opts.initial ?? '';
        setMode({
          t: 'input',
          purpose: opts.purpose,
          label: opts.label,
          color: opts.color,
          placeholder: opts.placeholder,
          value,
          cursor: Array.from(value).length,
          sel: 0,
          nav: false,
          resolve,
        });
      }),
    [],
  );

  const pick = useCallback(
    (opts: { title: string; subtitle?: string; items: PickerItem[]; multi?: boolean; checked?: boolean[] }) =>
      new Promise<number[] | null>((resolve) => {
        setMode({
          t: 'picker',
          title: opts.title,
          subtitle: opts.subtitle,
          items: opts.items,
          multi: !!opts.multi,
          cursor: 0,
          checked: opts.checked ?? opts.items.map(() => !!opts.multi),
          resolve,
        });
      }),
    [],
  );

  const confirm = useCallback(
    (message: string) => new Promise<boolean>((resolve) => setMode({ t: 'confirm', message, resolve })),
    [],
  );

  const backToNormal = useCallback(() => setMode({ t: 'normal' }), []);

  // ------------------------------------------------ flows
  const askGenericVideoPrefs = useCallback(
    async (subtitle: string): Promise<VideoPrefs | null> => {
      const q = await pick({
        title: 'Video quality (applied to every video)',
        subtitle,
        items: [{ label: 'Best available' }, ...QUALITIES.map((h) => ({ label: `Up to ${qualityLabel(h)}` }))],
      });
      if (!q) return null;
      const l = await pick({
        title: 'Audio language (when several tracks exist)',
        subtitle: 'Falls back to the original track if the language is missing',
        items: [{ label: 'Original / default' }, ...COMMON_LANGS.map(([c, n]) => ({ label: n, hint: c }))],
      });
      if (!l) return null;
      return {
        height: q[0] === 0 ? null : QUALITIES[q[0] - 1],
        lang: l[0] === 0 ? null : COMMON_LANGS[l[0] - 1][0],
      };
    },
    [pick],
  );

  const addFlow = useCallback(
    async (raw: string, detection?: Detection) => {
      const input = raw.trim();
      if (!input) return backToNormal();
      const token = ++flowToken.current;
      const alive = () => token === flowToken.current;
      try {
        const det = detection ?? (await client.call<Detection>('detect', { input }));
        let video: VideoPrefs | undefined;
        let toAdd = input;
        let what = '';

        if (det.kind === 'video') {
          setMode({ t: 'busy', message: 'Fetching video info…' });
          const url = input.replace(/^yt:/, '');
          const info = await client.call<VideoInfo>('probe', { url });
          if (!alive()) return;
          if (info.playlist) {
            if (info.entries.length === 0) throw new Error('empty playlist');
            const prefs = await askGenericVideoPrefs(`Playlist “${info.title}” · ${info.entries.length} videos`);
            if (!prefs) return backToNormal();
            video = prefs;
            toAdd = info.entries.join(' ');
            what = `${info.entries.length} videos from “${info.title}”`;
          } else {
            const q = await pick({
              title: info.title,
              subtitle: 'Video quality',
              items: [{ label: 'Best available' }, ...info.heights.map((h) => ({ label: qualityLabel(h) }))],
            });
            if (!q) return backToNormal();
            let lang: string | null = null;
            if (info.languages.length > 1) {
              const l = await pick({
                title: info.title,
                subtitle: 'Audio language',
                items: info.languages.map((x) => ({ label: x.label, hint: x.code })),
              });
              if (!l) return backToNormal();
              lang = info.languages[l[0]].code;
            }
            video = { height: q[0] === 0 ? null : info.heights[q[0] - 1], lang };
            what = info.title;
          }
        } else if ((det.kind === 'batch' || det.kind === 'multi') && (det.videos ?? 0) > 0) {
          const prefs = await askGenericVideoPrefs(`${det.links} links · ${det.videos} videos`);
          if (!prefs) return backToNormal();
          video = prefs;
        }
        if (!alive()) return;

        const defaultDir = stateRef.current?.global.download_dir ?? '~/Downloads';
        const dir = await ask({
          purpose: 'dir',
          label: 'SAVE TO',
          color: 'magenta',
          initial: tildify(defaultDir) + '/',
        });
        if (dir === null || !alive()) return backToNormal();

        setMode({ t: 'busy', message: 'Adding…' });
        const res = await client.call<AddResult>('add', { input: toAdd, dir, video });
        backToNormal();
        if (res.ids.length > 0) setSelId(res.ids[0]);
        if (res.errors.length > 0) {
          say(`Added ${res.ids.length}, ${res.errors.length} failed: ${res.errors[0]}`, 'error');
        } else if (res.ids.length === 1) {
          say(`Added ${what || truncate(input, 60)}`, 'ok');
        } else {
          say(`Added ${what || `${res.ids.length} downloads`}`, 'ok');
        }
      } catch (e) {
        if (!alive()) return;
        backToNormal();
        say((e as Error).message, 'error');
      }
    },
    [ask, askGenericVideoPrefs, backToNormal, client, pick, say],
  );

  const openAdd = useCallback(
    async (initial = '') => {
      let value = initial;
      for (;;) {
        const v = await ask({
          purpose: 'link',
          label: 'ADD',
          color: ACCENT,
          initial: value,
          placeholder: 'paste a URL / magnet, or type a path (~/…) to a .torrent, .txt or .md',
        });
        if (v === null || v.trim() === '') return backToNormal();
        try {
          const det = await client.call<Detection>('detect', { input: v.trim() });
          return await addFlow(v, det);
        } catch (e) {
          // keep the user in the input with their text so they can fix it
          say((e as Error).message, 'error');
          value = v;
        }
      }
    },
    [addFlow, ask, backToNormal, client, say],
  );

  const chooseFiles = useCallback(
    async (d: Download) => {
      const files = d.files ?? [];
      const prefix = d.dir.endsWith('/') ? d.dir : d.dir + '/';
      const sel = await pick({
        title: d.name,
        subtitle: `${files.length} files · ${formatBytes(files.reduce((a, f) => a + f.length, 0))}`,
        multi: true,
        items: files.map((f) => ({
          label: f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path,
          hint: formatBytes(f.length),
        })),
        checked: files.map(() => true),
      });
      backToNormal();
      if (sel === null) {
        dismissed.current.add(d.id);
        say('File choice postponed: press ⏎ on the torrent when ready', 'info');
        return;
      }
      if (sel.length === 0) {
        say('No file selected: torrent removed', 'info');
      }
      try {
        await client.call('select', { id: d.id, indices: sel.map((i) => files[i].index) });
        if (sel.length) say(`Downloading ${sel.length}/${files.length} files`, 'ok');
      } catch (e) {
        say((e as Error).message, 'error');
      }
    },
    [backToNormal, client, pick, say],
  );

  // initial link from the command line
  useEffect(() => {
    if (initialInput) void addFlow(initialInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // open the file picker automatically when a torrent becomes ready
  useEffect(() => {
    if (mode.t !== 'normal' || !state) return;
    const d = state.downloads.find((x) => x.status === 'selecting' && !dismissed.current.has(x.id));
    if (d) {
      dismissed.current.add(d.id); // open once automatically
      setSelId(d.id);
      void chooseFiles(d);
    }
  }, [state, mode.t, chooseFiles]);

  // ------------------------------------------------ live detection while typing a link
  const inputValue = mode.t === 'input' ? mode.value : '';
  const inputPurpose = mode.t === 'input' ? mode.purpose : null;
  useEffect(() => {
    if (inputPurpose !== 'link' || inputValue.trim() === '') {
      setDetected(null);
      return;
    }
    const v = inputValue;
    const t = setTimeout(() => {
      client
        .call<Detection>('detect', { input: v })
        .then((det) => setDetected({ value: v, det }))
        .catch((e) => setDetected({ value: v, det: null, error: (e as Error).message }));
    }, 150);
    return () => clearTimeout(t);
  }, [inputValue, inputPurpose, client]);

  const suggestions: Suggestion[] = useMemo(() => suggestionsFor(mode), [mode]);

  // ------------------------------------------------ list geometry
  const downloads = state?.downloads ?? [];
  let idx = selId ? downloads.findIndex((d) => d.id === selId) : -1;
  if (idx < 0) idx = Math.min(lastIdx.current, Math.max(0, downloads.length - 1));
  lastIdx.current = idx;
  const selected: Download | undefined = downloads[idx];

  const headerH = 2;
  const footerH =
    mode.t === 'input' ? 1 + suggestionsHeight(suggestions.length) + 1 + 1 : 3;
  const areaH = Math.max(3, rows - headerH - footerH);
  // the picker sits at the bottom of the list area so progress stays visible
  const pickerH =
    mode.t === 'picker'
      ? pickerHeight(mode.items.length, !!mode.subtitle, mode.multi, areaH - 3 >= 9 ? areaH - 3 : areaH)
      : 0;
  const listH = mode.t === 'help' ? areaH : areaH - pickerH;
  const heights = downloads.map((d) => rowHeight(d, expanded.has(d.id), width));
  if (idx < scroll.current) scroll.current = idx;
  const sum = (a: number, b: number) => heights.slice(a, b + 1).reduce((x, y) => x + y, 0);
  while (scroll.current < idx && sum(scroll.current, idx) > listH) scroll.current++;
  if (scroll.current > Math.max(0, downloads.length - 1)) scroll.current = 0;
  const visibleRows: Download[] = [];
  {
    let used = 0;
    for (let i = scroll.current; i < downloads.length; i++) {
      if (used + heights[i] > listH && visibleRows.length > 0) break;
      visibleRows.push(downloads[i]);
      used += heights[i];
    }
  }

  const moveTo = (i: number) => {
    if (downloads.length === 0) return;
    const c = Math.max(0, Math.min(downloads.length - 1, i));
    setSelId(downloads[c].id);
    lastIdx.current = c;
  };

  // ------------------------------------------------ actions on the selection
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) say(ok, 'ok');
    } catch (e) {
      say((e as Error).message, 'error');
    }
  };

  const togglePause = (d: Download) => {
    if (d.status === 'selecting') return void chooseFiles(d);
    if (d.status === 'paused' || (d.status === 'error' && d.kind === 'video'))
      return act(() => client.call('resume', { id: d.id }));
    if (d.status === 'active' || d.status === 'waiting' || d.status === 'metadata')
      return act(() => client.call('pause', { id: d.id }));
  };

  const removeSel = async (d: Download) => {
    const finished = d.status === 'complete' || d.status === 'error';
    if (finished) {
      return act(() => client.call('remove', { id: d.id, delete: false }), 'Removed from list (file kept)');
    }
    const yes = await confirm(`Cancel “${truncate(d.name, 40)}” and delete its partial data?`);
    backToNormal();
    if (yes) await act(() => client.call('remove', { id: d.id, delete: true }), 'Download cancelled');
  };

  const retry = async (d: Download) => {
    if (d.status !== 'error') return say('Only failed downloads can be retried', 'info');
    if (d.kind === 'video') return act(() => client.call('resume', { id: d.id }), 'Retrying');
    if (!d.url) return say('No URL to retry this download', 'error');
    await act(async () => {
      await client.call('add', { input: d.url, dir: d.dir });
      await client.call('remove', { id: d.id, delete: false });
    }, 'Retrying');
  };

  const setLimit = async (d: Download | null) => {
    const current = d ? d.limit : state?.global.limit ?? 0;
    const v = await ask({
      purpose: 'limit',
      label: d ? 'LIMIT' : 'GLOBAL LIMIT',
      color: 'yellow',
      initial: current > 0 ? `${Math.round(current / 1024)}K` : '',
      placeholder: 'e.g. 2M, 500K, empty or 0 = unlimited',
    });
    backToNormal();
    if (v === null) return;
    const bytes = parseSize(v);
    if (bytes === null) return say(`Invalid limit “${v}” (try 2M, 500K or 0)`, 'error');
    const msg = bytes === 0 ? 'Limit removed' : `Limit set to ${formatSpeed(bytes)}`;
    await act(() => client.call('limit', d ? { id: d.id, limit: bytes } : { limit: bytes }), d ? msg : `Global ${msg[0].toLowerCase()}${msg.slice(1)}`);
  };

  const quit = async (stopDaemon: boolean) => {
    if (stopDaemon) {
      const active = downloads.filter((d) => d.status === 'active' || d.status === 'waiting').length;
      if (active > 0) {
        const yes = await confirm(`Stop the daemon? ${active} download(s) will resume on next launch.`);
        backToNormal();
        if (!yes) return;
      }
      try {
        await client.call('shutdown');
      } catch {}
    }
    exit();
  };

  const normalKey = (input: string, key: any) => {
    const now = Date.now();
    const pend = pendingKey.current && now - pendingKey.current.at < 600 ? pendingKey.current.k : null;
    pendingKey.current = null;
    const d = selected;
    const half = Math.max(1, Math.floor(listH / 6));

    if (key.ctrl && input === 'c') return void quit(false);
    if (key.ctrl && input === 'd') return moveTo(idx + half);
    if (key.ctrl && input === 'u') return moveTo(idx - half);
    if (input === 'j' || key.downArrow) return moveTo(idx + 1);
    if (input === 'k' || key.upArrow) return moveTo(idx - 1);
    if (key.pageDown) return moveTo(idx + half * 2);
    if (key.pageUp) return moveTo(idx - half * 2);
    if (input === 'G' || key.end) return moveTo(downloads.length - 1);
    if (input === 'g' || key.home) {
      if (pend === 'g' || key.home) return moveTo(0);
      pendingKey.current = { k: 'g', at: now };
      return;
    }
    if (input === 'i' || input === 'a') return void openAdd();
    if (input === '?') return setMode({ t: 'help' });
    if (input === 'q') return void quit(false);
    if (input === 'Q') return void quit(true);
    if (input === 'L') return void setLimit(null);
    if (input === 'c') return void act(() => client.call('clear'), 'Finished downloads cleared');
    if (input === 'P') {
      const anyActive = downloads.some((x) => x.status === 'active' || x.status === 'waiting');
      return void act(
        () => client.call(anyActive ? 'pause_all' : 'resume_all'),
        anyActive ? 'All paused' : 'All resumed',
      );
    }
    if (!d) return;
    if (key.escape) return setExpanded(new Set());
    if (key.leftArrow) {
      if (!expanded.has(d.id)) return;
      const next = new Set(expanded);
      next.delete(d.id);
      return setExpanded(next);
    }
    if (key.rightArrow && d.status !== 'selecting') {
      if (expanded.has(d.id)) return;
      return setExpanded(new Set(expanded).add(d.id));
    }
    if (key.return || key.rightArrow) {
      if (d.status === 'selecting') return void chooseFiles(d);
      const next = new Set(expanded);
      if (next.has(d.id)) next.delete(d.id);
      else next.add(d.id);
      return setExpanded(next);
    }
    if (input === 'p' || input === ' ') return void togglePause(d);
    if (input === 'x' || key.delete || key.backspace) return void removeSel(d);
    if (input === 'd') {
      if (pend === 'd') return void removeSel(d);
      pendingKey.current = { k: 'd', at: now };
      return;
    }
    if (input === 'r') return void retry(d);
    if (input === 'l') return void setLimit(d);
    if (input === 'o') {
      const target = d.path && fs.existsSync(d.path) ? d.path : d.dir;
      execFile('open', d.path && fs.existsSync(d.path) ? ['-R', target] : [target], () => {});
      return;
    }
    if (input === 'y') {
      const text = d.path ?? d.url ?? d.name;
      copy(text);
      return say(`Copied ${truncate(tildify(text), 60)}`, 'ok');
    }
  };

  // ------------------------------------------------ input handling
  usePaste((text) => {
    const clean = text.replace(/[\r\n]+/g, ' ').trim();
    const mode = modeRef.current;
    if (mode.t === 'normal') {
      void openAdd(clean);
    } else if (mode.t === 'input') {
      const r = editInput(mode, clean, {});
      if (r) setMode(r);
    }
  });

  const handleKey = (input: string, key: any): void => {
    const mode = modeRef.current;
    // a burst of plain keys outside text input: handle them one by one
    if (input.length > 1 && !key.ctrl && !key.meta && mode.t !== 'input') {
      for (const ch of input) handleKey(ch, {});
      return;
    }
    const suggestions = suggestionsFor(mode);
    // ---------- input mode
    if (mode.t === 'input') {
      const m = mode;
      if (key.escape || (key.ctrl && input === 'c')) {
        flowToken.current++;
        m.resolve(null);
        return;
      }
      const hasSugg = suggestions.length > 0;
      const accept = (s: Suggestion): InputMode => ({
        ...m,
        value: s.value,
        cursor: Array.from(s.value).length,
        sel: 0,
        nav: false,
      });
      if (key.return) {
        const exists = pathExists(m.value);
        // a directory is never a valid link: Enter walks into the highlighted entry
        if (hasSugg && isPathLike(m.value) && (m.nav || exists === null || (m.purpose === 'link' && exists === 'dir'))) {
          const s = suggestions[Math.min(m.sel, suggestions.length - 1)];
          if (s.isDir || m.purpose === 'dir') return setMode(accept(s));
          // a file in link mode: accept and submit right away
          m.resolve(s.value);
          return;
        }
        m.resolve(m.value);
        return;
      }
      if (key.tab && !key.shift) {
        if (hasSugg) return setMode(accept(suggestions[Math.min(m.sel, suggestions.length - 1)]));
        if (pathExists(m.value) === 'dir' && !m.value.endsWith('/'))
          return setMode({ ...m, value: m.value + '/', cursor: Array.from(m.value).length + 1 });
        return;
      }
      if (hasSugg && key.rightArrow && m.cursor === Array.from(m.value).length) {
        return setMode(accept(suggestions[Math.min(m.sel, suggestions.length - 1)]));
      }
      if (hasSugg && (key.downArrow || (key.ctrl && input === 'n'))) {
        return setMode({ ...m, sel: (m.sel + 1) % suggestions.length, nav: true });
      }
      if (hasSugg && (key.upArrow || (key.ctrl && input === 'p') || (key.tab && key.shift))) {
        return setMode({ ...m, sel: (m.sel - 1 + suggestions.length) % suggestions.length, nav: true });
      }
      const r = editInput(m, input, key);
      if (r) setMode(r);
      return;
    }

    // ---------- picker
    if (mode.t === 'picker') {
      const m = mode;
      const n = m.items.length;
      if (key.escape || input === 'q' || (key.ctrl && input === 'c')) {
        flowToken.current++;
        return m.resolve(null);
      }
      if (input === 'j' || key.downArrow) return setMode({ ...m, cursor: Math.min(n - 1, m.cursor + 1) });
      if (input === 'k' || key.upArrow) return setMode({ ...m, cursor: Math.max(0, m.cursor - 1) });
      if (input === 'g' || key.home) return setMode({ ...m, cursor: 0 });
      if (input === 'G' || key.end) return setMode({ ...m, cursor: n - 1 });
      if ((key.ctrl && input === 'd') || key.pageDown) return setMode({ ...m, cursor: Math.min(n - 1, m.cursor + 10) });
      if ((key.ctrl && input === 'u') || key.pageUp) return setMode({ ...m, cursor: Math.max(0, m.cursor - 10) });
      if (m.multi && input === ' ') {
        const checked = [...m.checked];
        checked[m.cursor] = !checked[m.cursor];
        return setMode({ ...m, checked, cursor: Math.min(n - 1, m.cursor + 1) });
      }
      if (m.multi && input === 'a') {
        const all = m.checked.every(Boolean);
        return setMode({ ...m, checked: m.checked.map(() => !all) });
      }
      if (!m.multi && /^[1-9]$/.test(input) && Number(input) <= n) return m.resolve([Number(input) - 1]);
      if (key.return) {
        if (m.multi) return m.resolve(m.checked.flatMap((c, i) => (c ? [i] : [])));
        return m.resolve([m.cursor]);
      }
      return;
    }

    // ---------- confirm
    if (mode.t === 'confirm') {
      if (input === 'y' || input === 'Y' || key.return) return mode.resolve(true);
      if (input === 'n' || input === 'N' || key.escape || input === 'q') return mode.resolve(false);
      return;
    }

    // ---------- help
    if (mode.t === 'help') return backToNormal();

    // ---------- busy
    if (mode.t === 'busy') {
      if (key.escape || (key.ctrl && input === 'c')) {
        flowToken.current++;
        backToNormal();
        say('Cancelled', 'info');
      }
      return;
    }

    // ---------- normal mode (several keys can arrive in one chunk, e.g. "dd")
    if (input.length > 1 && !key.ctrl && !key.meta) {
      for (const ch of input) normalKey(ch, {});
      return;
    }
    normalKey(input, key);
  };
  const handleKeyRef = useRef(handleKey);
  handleKeyRef.current = handleKey;
  const keyQueue = useRef<[string, any][]>([]);
  const pumping = useRef(false);

  useInput((input, key) => {
    keyQueue.current.push(...splitBurst(input, key));
    if (pumping.current) return;
    pumping.current = true;
    // one event per macrotask so that flows resumed by a resolved dialog
    // (microtasks) can open the next dialog before the following key
    const step = () => {
      const ev = keyQueue.current.shift();
      if (!ev) {
        pumping.current = false;
        return;
      }
      handleKeyRef.current(ev[0], ev[1]);
      setTimeout(step, 0);
    };
    step();
  });

  // ------------------------------------------------ render
  let body: React.ReactNode;
  let overlay: React.ReactNode = null;
  if (mode.t === 'picker') {
    overlay = (
      <Picker
        title={mode.title}
        subtitle={mode.subtitle}
        items={mode.items}
        multi={mode.multi}
        cursor={mode.cursor}
        checked={mode.checked}
        width={width}
        height={pickerH}
      />
    );
  }
  if (mode.t === 'help') {
    body = <Help width={width} height={listH} />;
  } else if (listH <= 0) {
    body = null;
  } else if (!state) {
    body = (
      <Box height={listH} alignItems="center" justifyContent="center">
        <Text color={DIM}>Connecting to dl-daemon…</Text>
      </Box>
    );
  } else if (downloads.length === 0) {
    body = (
      <Box height={listH} flexDirection="column" alignItems="center" justifyContent="center">
        <Text bold>No downloads yet</Text>
        <Text color={DIM}> </Text>
        <Text color={DIM}>
          Press <Text color={ACCENT}>i</Text> and paste a link, a magnet,
        </Text>
        <Text color={DIM}>or a path to a .torrent, .txt or .md file.</Text>
      </Box>
    );
  } else {
    body = (
      <Box flexDirection="column" height={listH} overflow="hidden">
        {visibleRows.map((d) => (
          <DownloadRow
            key={d.id}
            d={d}
            selected={d.id === selected?.id}
            expanded={expanded.has(d.id)}
            width={width}
            frame={frame}
          />
        ))}
      </Box>
    );
  }

  let footer: React.ReactNode;
  if (mode.t === 'input') {
    const det = mode.purpose === 'link' && detected?.value === mode.value ? detected : null;
    const tag = det?.det ? kindTag(det.det) : null;
    const keys =
      mode.purpose === 'limit'
        ? '⏎ apply · esc cancel'
        : 'tab/→ complete · ↑↓ browse · ⏎ ' + (mode.purpose === 'dir' ? 'save here' : 'add') + ' · esc cancel';
    footer = (
      <>
        <Suggestions items={suggestions} sel={Math.min(mode.sel, Math.max(0, suggestions.length - 1))} width={width} />
        <InputLine
          label={mode.label}
          color={mode.color}
          value={mode.value}
          cursor={mode.cursor}
          width={width}
          tag={tag}
          placeholder={mode.placeholder}
        />
        <Text color={det?.error && !isPathLike(mode.value) ? 'red' : DIM} wrap="truncate">
          {det?.error && mode.value.length > 3 && !(isPathLike(mode.value) && suggestions.length) ? det.error : keys}
        </Text>
      </>
    );
  } else {
    let status: React.ReactNode;
    if (mode.t === 'confirm') {
      status = (
        <Text color="yellow" wrap="truncate">
          {mode.message} <Text bold>[y/n]</Text>
        </Text>
      );
    } else if (mode.t === 'busy') {
      status = (
        <Text color={ACCENT}>
          {SPINNER[spin % SPINNER.length]} {mode.message} <Text color={DIM}>(esc to cancel)</Text>
        </Text>
      );
    } else if (notice) {
      const color = notice.level === 'error' ? 'red' : notice.level === 'ok' ? 'green' : ACCENT;
      status = (
        <Text color={color} wrap="truncate">
          {notice.level === 'error' ? '✗ ' : notice.level === 'ok' ? '✓ ' : '› '}
          {notice.text}
        </Text>
      );
    } else if (selected) {
      status = (
        <Text color={DIM} wrap="truncate">
          {tildify(selected.path ?? selected.url ?? selected.dir)}
        </Text>
      );
    } else {
      status = <Text> </Text>;
    }
    const keys =
      mode.t === 'picker'
        ? ''
        : 'i add · p pause · P all · dd remove · l/L limit · c clear · ⏎ details · ? help · q quit';
    footer = (
      <>
        {status}
        <Text color={DIM} wrap="truncate">
          {keys}
        </Text>
      </>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={rows}>
      <Header global={state?.global ?? null} width={width} connection={connection} />
      {body}
      {overlay}
      <Box flexDirection="column" width={width}>
        <Text color={DIM}>{'─'.repeat(width)}</Text>
        {footer}
      </Box>
    </Box>
  );
}
