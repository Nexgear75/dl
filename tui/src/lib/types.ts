export type Status =
  | 'active'
  | 'waiting'
  | 'paused'
  | 'complete'
  | 'error'
  | 'selecting'
  | 'metadata';

export interface FileEntry {
  index: number;
  path: string;
  length: number;
  selected: boolean;
}

export interface Download {
  id: string;
  kind: 'http' | 'torrent' | 'video';
  name: string;
  status: Status;
  total: number;
  done: number;
  speed: number;
  up_speed: number;
  connections: number;
  seeders: number;
  dir: string;
  path: string | null;
  error: string | null;
  phase: string | null;
  limit: number;
  files: FileEntry[] | null;
  url: string | null;
}

export interface Global {
  down: number;
  up: number;
  active: number;
  total: number;
  limit: number;
  download_dir: string;
}

export interface State {
  downloads: Download[];
  global: Global;
}

export type DetectKind =
  | 'http'
  | 'magnet'
  | 'torrent'
  | 'metalink'
  | 'video'
  | 'batch'
  | 'multi';

export interface Detection {
  kind: DetectKind;
  links?: number;
  videos?: number;
  torrents?: number;
}

export interface VideoInfo {
  title: string;
  playlist: boolean;
  entries: string[];
  heights: number[];
  languages: { code: string; label: string }[];
  duration: number | null;
}

export interface VideoPrefs {
  height: number | null;
  lang: string | null;
}

export interface AddResult {
  ids: string[];
  errors: string[];
}
