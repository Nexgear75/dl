//! Aggregates aria2 downloads and yt-dlp jobs into one list and applies actions.

use anyhow::{Result, anyhow, bail};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

use crate::aria2::Aria2;
use crate::config::{Config, expand, parse_size};
use crate::detect::{Target, detect, detect_link};
use crate::notify;
use crate::ytdlp::{VideoPrefs, YtManager};

#[derive(Serialize, Clone, Debug)]
pub struct FileEntry {
    pub index: u32,
    pub path: String,
    pub length: u64,
    pub selected: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct Download {
    pub id: String,
    pub kind: String,
    pub name: String,
    /// active | waiting | paused | complete | error | selecting | metadata
    pub status: String,
    pub total: u64,
    pub done: u64,
    pub speed: u64,
    pub up_speed: u64,
    pub connections: u64,
    pub seeders: u64,
    pub dir: String,
    pub path: Option<String>,
    pub error: Option<String>,
    pub phase: Option<String>,
    pub limit: u64,
    pub files: Option<Vec<FileEntry>>,
    pub url: Option<String>,
    #[serde(skip)]
    seq: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct Persist {
    /// Torrents paused until the user picks files.
    selecting: HashSet<String>,
    /// Magnet / remote-torrent metadata downloads whose result needs a file pick.
    pending_meta: HashSet<String>,
    limits: HashMap<String, u64>,
    /// gid → copy of an uploaded .torrent/.metalink that aria2 keeps in the
    /// download dir (named after the SHA-1 of the data) to restore its session.
    #[serde(default)]
    uploaded: HashMap<String, String>,
}

/// Deletes aria2's saved copy of an uploaded torrent/metalink once no download uses it.
fn forget_uploaded(p: &mut Persist, gid: &str) {
    if let Some(path) = p.uploaded.remove(gid) {
        if !p.uploaded.values().any(|v| *v == path) {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn uploaded_copy(dir: &str, data: &[u8]) -> String {
    let hash = sha1_smol::Sha1::from(data).digest().to_string();
    Path::new(dir).join(format!("{hash}.torrent")).display().to_string()
}

/// A magnet whose metadata download has no peer is paused then resumed after
/// this long: aria2 then announces to its trackers and asks the DHT again,
/// instead of waiting for the tracker interval (often 30 min).
const META_KICK_AFTER: Duration = Duration::from_secs(45);

#[derive(Default)]
struct MetaIdle {
    /// since when it has had no connection
    since: Option<Instant>,
    /// paused by us, to resume on the next poll
    kicking: bool,
    kicks: u32,
}

struct Inner {
    p: Persist,
    meta_idle: HashMap<String, MetaIdle>,
    order: HashMap<String, u64>,
    seen_incomplete: HashSet<String>,
    notified: HashSet<String>,
    global_limit: u64,
}

pub struct Core {
    pub aria: Aria2,
    pub cfg: Config,
    pub yt: Arc<YtManager>,
    seq: Arc<AtomicU64>,
    inner: Mutex<Inner>,
    pub events: broadcast::Sender<String>,
    pub last_state: Mutex<String>,
    state_file: PathBuf,
    /// downloads currently transferring or queued (updated on every poll)
    pub busy: AtomicUsize,
    /// connected TUI / tf clients
    pub clients: AtomicUsize,
}

const KEYS: &[&str] = &[
    "gid",
    "status",
    "totalLength",
    "completedLength",
    "downloadSpeed",
    "uploadSpeed",
    "connections",
    "numSeeders",
    "errorCode",
    "errorMessage",
    "dir",
    "files",
    "bittorrent",
    "followedBy",
    "following",
    "belongsTo",
    "infoHash",
];

fn n(v: &Value) -> u64 {
    v.as_str()
        .and_then(|s| s.parse().ok())
        .or(v.as_u64())
        .unwrap_or(0)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_files(v: &Value) -> Vec<FileEntry> {
    v.as_array()
        .into_iter()
        .flatten()
        .map(|f| FileEntry {
            index: n(&f["index"]) as u32,
            path: f["path"].as_str().unwrap_or("").to_string(),
            length: n(&f["length"]),
            selected: f["selected"].as_str() != Some("false"),
        })
        .collect()
}

fn magnet_name(it: &Value) -> String {
    let hash = it["infoHash"].as_str().unwrap_or("");
    format!("magnet {}", &hash[..hash.len().min(12)])
}

fn display_name(it: &Value) -> String {
    if let Some(name) = it["bittorrent"]["info"]["name"].as_str() {
        return name.to_string();
    }
    let f0 = &it["files"][0];
    let path = f0["path"].as_str().unwrap_or("");
    if path.starts_with("[METADATA]") {
        return magnet_name(it);
    }
    if !path.is_empty() {
        return Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string());
    }
    if let Some(uri) = f0["uris"][0]["uri"].as_str() {
        let clean = uri.split(['?', '#']).next().unwrap_or(uri);
        let last = clean.trim_end_matches('/').rsplit('/').next().unwrap_or(clean);
        if !last.is_empty() && !last.contains("://") {
            return percent_decode(last);
        }
        return uri.to_string();
    }
    if it["infoHash"].is_string() {
        return magnet_name(it);
    }
    it["gid"].as_str().unwrap_or("?").to_string()
}

fn gid_of(id: &str) -> Option<&str> {
    id.strip_prefix("a:")
}

impl Core {
    pub fn new(aria: Aria2, cfg: Config, data_dir: &Path) -> Arc<Core> {
        let seq = Arc::new(AtomicU64::new(1));
        let yt = YtManager::new(
            cfg.ytdlp_path.clone(),
            data_dir,
            cfg.max_concurrent as usize,
            seq.clone(),
            cfg.notifications,
        );
        let state_file = data_dir.join("state.json");
        let p: Persist = std::fs::read_to_string(&state_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let global_limit = parse_size(&cfg.global_limit).unwrap_or(0);
        let (events, _) = broadcast::channel(64);
        Arc::new(Core {
            aria,
            cfg,
            yt,
            seq,
            inner: Mutex::new(Inner {
                p,
                order: HashMap::new(),
                meta_idle: HashMap::new(),
                seen_incomplete: HashSet::new(),
                notified: HashSet::new(),
                global_limit,
            }),
            events,
            last_state: Mutex::new(String::new()),
            state_file,
            busy: AtomicUsize::new(0),
            clients: AtomicUsize::new(0),
        })
    }

    fn save(&self) {
        let inner = self.inner.lock().unwrap();
        if let Ok(s) = serde_json::to_string(&inner.p) {
            let _ = std::fs::write(&self.state_file, s);
        }
    }

    // ------------------------------------------------------------------ polling

    pub async fn poll(&self) -> Result<()> {
        let keys = json!(KEYS);
        let (active, waiting, stopped, gstat) = tokio::try_join!(
            self.aria.call("tellActive", vec![keys.clone()]),
            self.aria.call("tellWaiting", vec![json!(0), json!(1000), keys.clone()]),
            self.aria.call("tellStopped", vec![json!(0), json!(1000), keys.clone()]),
            self.aria.call("getGlobalStat", vec![]),
        )?;
        let mut items: Vec<Value> = Vec::new();
        for list in [active, waiting, stopped] {
            if let Value::Array(a) = list {
                items.extend(a);
            }
        }
        let by_gid: HashMap<String, &Value> = items
            .iter()
            .filter_map(|it| Some((it["gid"].as_str()?.to_string(), it)))
            .collect();

        // Metadata finished → decide whether the user must pick files.
        let mut to_unpause: Vec<String> = Vec::new();
        let mut changed = false;
        {
            let mut inner = self.inner.lock().unwrap();
            let pending: Vec<String> = inner.p.pending_meta.iter().cloned().collect();
            for gid in pending {
                let Some(it) = by_gid.get(&gid) else {
                    inner.p.pending_meta.remove(&gid);
                    changed = true;
                    continue;
                };
                match it["status"].as_str().unwrap_or("") {
                    "complete" => {
                        let followers: Vec<String> = it["followedBy"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect();
                        for f in followers {
                            let count = by_gid
                                .get(&f)
                                .map(|fv| fv["files"].as_array().map(|a| a.len()).unwrap_or(0))
                                .unwrap_or(0);
                            if count > 1 {
                                inner.p.selecting.insert(f);
                            } else {
                                to_unpause.push(f);
                            }
                        }
                        inner.p.pending_meta.remove(&gid);
                        changed = true;
                    }
                    "error" | "removed" => {
                        inner.p.pending_meta.remove(&gid);
                        changed = true;
                    }
                    _ => {}
                }
            }
            // forget selections for downloads that no longer exist
            let before = inner.p.selecting.len();
            inner.p.selecting.retain(|g| by_gid.contains_key(g));
            changed |= before != inner.p.selecting.len();
        }
        if changed {
            self.save();
        }
        for g in to_unpause {
            let _ = self.aria.call("unpause", vec![json!(g)]).await;
        }

        let mut downloads: Vec<Download> = Vec::new();
        let mut notifications: Vec<(&'static str, String)> = Vec::new();
        let mut kick: Vec<String> = Vec::new();
        let mut resume: Vec<String> = Vec::new();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.meta_idle.retain(|g, _| by_gid.contains_key(g));
            for it in &items {
                let Some(gid) = it["gid"].as_str() else { continue };
                let raw = it["status"].as_str().unwrap_or("");
                let followed = it["followedBy"].as_array().map(|a| !a.is_empty()).unwrap_or(false);
                if raw == "removed" || (followed && raw == "complete") {
                    continue;
                }
                let seq = if let Some(parent) = it["following"].as_str().and_then(|p| inner.order.get(p).copied()) {
                    *inner.order.entry(gid.to_string()).or_insert(parent)
                } else {
                    let next = self.seq.fetch_add(1, Ordering::SeqCst);
                    *inner.order.entry(gid.to_string()).or_insert(next)
                };
                let name = display_name(it);
                let is_meta = it["files"][0]["path"]
                    .as_str()
                    .map(|p| p.starts_with("[METADATA]"))
                    .unwrap_or(false);
                let mut kicking = false;
                if is_meta {
                    let idle = inner.meta_idle.entry(gid.to_string()).or_default();
                    match raw {
                        "active" if n(&it["connections"]) == 0 => {
                            let since = *idle.since.get_or_insert_with(Instant::now);
                            if since.elapsed() >= META_KICK_AFTER {
                                idle.since = None;
                                idle.kicking = true;
                                idle.kicks += 1;
                                kick.push(gid.to_string());
                            }
                        }
                        "active" => idle.since = None,
                        "paused" if idle.kicking => {
                            idle.kicking = false;
                            resume.push(gid.to_string());
                        }
                        _ => {}
                    }
                    kicking = idle.kicking || resume.iter().any(|g| g == gid);
                }
                let status = if inner.p.selecting.contains(gid) && raw == "paused" {
                    "selecting"
                } else if is_meta && (raw == "active" || raw == "waiting" || (raw == "paused" && kicking)) {
                    "metadata"
                } else {
                    raw
                };
                let is_torrent = it["bittorrent"].is_object() || it["infoHash"].is_string();
                let files = parse_files(&it["files"]);
                let path = if is_torrent {
                    it["bittorrent"]["info"]["name"]
                        .as_str()
                        .map(|n| format!("{}/{}", it["dir"].as_str().unwrap_or(""), n))
                } else {
                    files.first().map(|f| f.path.clone()).filter(|p| !p.is_empty())
                };
                let id = format!("a:{gid}");
                if status != "complete" && status != "error" {
                    inner.seen_incomplete.insert(id.clone());
                } else if inner.seen_incomplete.contains(&id) && !inner.notified.contains(&id) {
                    inner.notified.insert(id.clone());
                    if !is_meta {
                        let title = if status == "complete" { "Download complete" } else { "Download failed" };
                        notifications.push((title, name.clone()));
                    }
                }
                if status == "complete" {
                    forget_uploaded(&mut inner.p, gid);
                }
                let url = files
                    .first()
                    .and(it["files"][0]["uris"][0]["uri"].as_str())
                    .map(String::from);
                downloads.push(Download {
                    id: id.clone(),
                    kind: if is_torrent { "torrent".into() } else { "http".into() },
                    name,
                    status: status.to_string(),
                    total: n(&it["totalLength"]),
                    done: n(&it["completedLength"]),
                    speed: n(&it["downloadSpeed"]),
                    up_speed: n(&it["uploadSpeed"]),
                    connections: n(&it["connections"]),
                    seeders: n(&it["numSeeders"]),
                    dir: it["dir"].as_str().unwrap_or("").to_string(),
                    path,
                    error: it["errorMessage"].as_str().filter(|_| raw == "error").map(String::from),
                    phase: None,
                    limit: inner.p.limits.get(gid).copied().unwrap_or(0),
                    files: if status == "selecting" || is_torrent { Some(files) } else { None },
                    url,
                    seq,
                });
            }
        }
        for g in kick {
            let _ = self.aria.call("forcePause", vec![json!(g)]).await;
        }
        for g in resume {
            let _ = self.aria.call("unpause", vec![json!(g)]).await;
        }
        if self.cfg.notifications {
            for (t, b) in notifications {
                notify::send(t, &b);
            }
        }

        let mut yt_speed = 0;
        for j in self.yt.snapshot() {
            yt_speed += j.speed;
            downloads.push(Download {
                id: j.id.clone(),
                kind: "video".into(),
                name: j.title.clone(),
                status: j.status.clone(),
                total: j.total,
                done: j.done,
                speed: j.speed,
                up_speed: 0,
                connections: 0,
                seeders: 0,
                dir: j.dir.clone(),
                path: j.filepath.clone(),
                error: j.error.clone(),
                phase: Some(j.phase.clone()).filter(|p| !p.is_empty() && j.status == "active"),
                limit: j.limit,
                files: None,
                url: Some(j.url.clone()),
                seq: j.seq,
            });
        }
        downloads.sort_by_key(|d| d.seq);

        let global_limit = self.inner.lock().unwrap().global_limit;
        let active = downloads.iter().filter(|d| d.status == "active" || d.status == "metadata").count();
        let busy = downloads.iter().filter(|d| matches!(d.status.as_str(), "active" | "metadata" | "waiting")).count();
        self.busy.store(busy, Ordering::Relaxed);
        let data = json!({
            "downloads": downloads,
            "global": {
                "down": n(&gstat["downloadSpeed"]) + yt_speed,
                "up": n(&gstat["uploadSpeed"]),
                "active": active,
                "total": downloads.len(),
                "limit": global_limit,
                "download_dir": self.cfg.download_dir().display().to_string(),
            }
        });
        let line = json!({"event": "state", "data": data}).to_string();
        *self.last_state.lock().unwrap() = line.clone();
        let _ = self.events.send(line);
        Ok(())
    }

    // ------------------------------------------------------------------ actions

    /// Fixes the list position of a new aria2 download at creation time.
    fn register(&self, gid: &str) {
        let next = self.seq.fetch_add(1, Ordering::SeqCst);
        self.inner.lock().unwrap().order.entry(gid.to_string()).or_insert(next);
    }

    fn resolve_dir(&self, dir: Option<String>) -> Result<String> {
        if let Some(d) = &dir {
            if d.chars().any(|c| c.is_control()) {
                bail!("invalid directory name");
            }
        }
        let d = match dir.filter(|d| !d.trim().is_empty()) {
            Some(d) => expand(&d),
            None => self.cfg.download_dir(),
        };
        let d: PathBuf = d.components().collect();
        std::fs::create_dir_all(&d).map_err(|e| anyhow!("cannot create {}: {e}", d.display()))?;
        Ok(d.display().to_string())
    }

    /// `select`: let the user pick files of a single torrent before it starts
    /// (false = download every file right away, like a batch).
    pub async fn add(&self, input: &str, dir: Option<String>, video: Option<VideoPrefs>, select: bool) -> Result<Value> {
        let target = detect(input).map_err(|e| anyhow!(e))?;
        let dir = self.resolve_dir(dir)?;
        let mut ids: Vec<String> = Vec::new();
        let mut errors: Vec<String> = Vec::new();
        match target {
            Target::Batch(_, links) | Target::Multi(links) => {
                for l in links {
                    match detect_link(&l) {
                        Some(t) => match self.add_one(t, &dir, video.clone(), false).await {
                            Ok(mut v) => ids.append(&mut v),
                            Err(e) => errors.push(format!("{l}: {e}")),
                        },
                        None => errors.push(format!("{l}: unsupported")),
                    }
                }
            }
            t => ids = self.add_one(t, &dir, video, select).await?,
        }
        self.yt.tick();
        Ok(json!({"ids": ids, "errors": errors}))
    }

    async fn add_one(&self, t: Target, dir: &str, video: Option<VideoPrefs>, select: bool) -> Result<Vec<String>> {
        let opts = || json!({"dir": dir});
        match t {
            Target::Http(u) => {
                let gid = self.aria.call("addUri", vec![json!([u]), opts()]).await?;
                let gid = gid.as_str().unwrap_or("").to_string();
                self.register(&gid);
                Ok(vec![format!("a:{gid}")])
            }
            Target::Magnet(u) | Target::TorrentUrl(u) => {
                let mut o = opts();
                if select {
                    o["pause-metadata"] = json!("true");
                }
                let gid = self.aria.call("addUri", vec![json!([u]), o]).await?;
                let gid = gid.as_str().unwrap_or("").to_string();
                self.register(&gid);
                if select {
                    self.inner.lock().unwrap().p.pending_meta.insert(gid.clone());
                    self.save();
                }
                Ok(vec![format!("a:{gid}")])
            }
            Target::TorrentFile(p) => {
                let bytes = std::fs::read(&p)?;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                let mut o = opts();
                if select {
                    o["pause"] = json!("true");
                }
                let gid = self.aria.call("addTorrent", vec![json!(b64), json!([]), o]).await?;
                let gid = gid.as_str().unwrap_or("").to_string();
                self.register(&gid);
                self.inner.lock().unwrap().p.uploaded.insert(gid.clone(), uploaded_copy(dir, &bytes));
                self.save();
                if select {
                    let files = self.aria.call("getFiles", vec![json!(gid)]).await?;
                    if files.as_array().map(|a| a.len()).unwrap_or(0) > 1 {
                        self.inner.lock().unwrap().p.selecting.insert(gid.clone());
                        self.save();
                    } else {
                        self.aria.call("unpause", vec![json!(gid)]).await?;
                    }
                }
                Ok(vec![format!("a:{gid}")])
            }
            Target::Metalink(p) => {
                let bytes = std::fs::read(&p)?;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                let gids = self.aria.call("addMetalink", vec![json!(b64), opts()]).await?;
                let gids: Vec<String> = gids
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|g| g.as_str().map(String::from))
                    .collect();
                gids.iter().for_each(|g| self.register(g));
                {
                    let copy = uploaded_copy(dir, &bytes).replace(".torrent", ".meta4");
                    let mut inner = self.inner.lock().unwrap();
                    for g in &gids {
                        inner.p.uploaded.insert(g.clone(), copy.clone());
                    }
                }
                self.save();
                Ok(gids.into_iter().map(|g| format!("a:{g}")).collect())
            }
            Target::Video(u) => Ok(vec![self.yt.add(&u, dir, video.unwrap_or_default())]),
            Target::Batch(..) | Target::Multi(_) => bail!("nested link list"),
        }
    }

    pub async fn select(&self, id: &str, indices: Vec<u32>) -> Result<()> {
        let gid = gid_of(id).ok_or_else(|| anyhow!("not a torrent"))?;
        if indices.is_empty() {
            return self.remove(id, true).await;
        }
        let list: Vec<String> = indices.iter().map(|i| i.to_string()).collect();
        self.aria
            .call("changeOption", vec![json!(gid), json!({"select-file": list.join(",")})])
            .await?;
        self.inner.lock().unwrap().p.selecting.remove(gid);
        self.save();
        self.aria.call("unpause", vec![json!(gid)]).await?;
        Ok(())
    }

    pub async fn pause(&self, id: &str) -> Result<()> {
        match gid_of(id) {
            Some(gid) => {
                if !self.inner.lock().unwrap().p.selecting.contains(gid) {
                    let _ = self.aria.call("pause", vec![json!(gid)]).await;
                }
            }
            None => self.yt.pause(id),
        }
        Ok(())
    }

    pub async fn resume(&self, id: &str) -> Result<()> {
        match gid_of(id) {
            Some(gid) => {
                if self.inner.lock().unwrap().p.selecting.contains(gid) {
                    bail!("pick the files to download first (enter)");
                }
                let _ = self.aria.call("unpause", vec![json!(gid)]).await;
            }
            None => {
                self.yt.resume(id);
                self.yt.tick();
            }
        }
        Ok(())
    }

    pub async fn pause_all(&self) -> Result<()> {
        let _ = self.aria.call("pauseAll", vec![]).await;
        self.yt.pause_all();
        Ok(())
    }

    pub async fn resume_all(&self) -> Result<()> {
        let waiting = self
            .aria
            .call("tellWaiting", vec![json!(0), json!(1000), json!(["gid", "status"])])
            .await?;
        let selecting = self.inner.lock().unwrap().p.selecting.clone();
        for it in waiting.as_array().into_iter().flatten() {
            let gid = it["gid"].as_str().unwrap_or("");
            if it["status"].as_str() == Some("paused") && !selecting.contains(gid) {
                let _ = self.aria.call("unpause", vec![json!(gid)]).await;
            }
        }
        self.yt.resume_all();
        self.yt.tick();
        Ok(())
    }

    pub async fn remove(&self, id: &str, delete_partial: bool) -> Result<()> {
        let Some(gid) = gid_of(id) else {
            if !self.yt.exists(id) {
                bail!("unknown download");
            }
            self.yt.remove(id, delete_partial);
            return Ok(());
        };
        let st = self
            .aria
            .call("tellStatus", vec![json!(gid), json!(["status", "files", "dir", "bittorrent", "infoHash"])])
            .await?;
        let status = st["status"].as_str().unwrap_or("").to_string();
        if matches!(status.as_str(), "active" | "waiting" | "paused") {
            self.aria.call("forceRemove", vec![json!(gid)]).await?;
            for _ in 0..30 {
                tokio::time::sleep(Duration::from_millis(100)).await;
                let s = self.aria.call("tellStatus", vec![json!(gid), json!(["status"])]).await;
                if !matches!(s.as_ref().ok().and_then(|v| v["status"].as_str()), Some("active" | "waiting" | "paused")) {
                    break;
                }
            }
        }
        let _ = self.aria.call("removeDownloadResult", vec![json!(gid)]).await;
        if delete_partial && status != "complete" {
            delete_partial_files(&st);
        }
        {
            let mut inner = self.inner.lock().unwrap();
            forget_uploaded(&mut inner.p, gid);
            inner.p.selecting.remove(gid);
            inner.p.pending_meta.remove(gid);
            inner.p.limits.remove(gid);
        }
        self.save();
        Ok(())
    }

    pub async fn limit(&self, id: Option<&str>, bytes: u64) -> Result<()> {
        match id {
            None => {
                self.aria
                    .call("changeGlobalOption", vec![json!({"max-overall-download-limit": bytes.to_string()})])
                    .await?;
                self.inner.lock().unwrap().global_limit = bytes;
            }
            Some(id) => match gid_of(id) {
                Some(gid) => {
                    self.aria
                        .call("changeOption", vec![json!(gid), json!({"max-download-limit": bytes.to_string()})])
                        .await?;
                    self.inner.lock().unwrap().p.limits.insert(gid.to_string(), bytes);
                    self.save();
                }
                None => self.yt.set_limit(id, bytes),
            },
        }
        Ok(())
    }

    pub async fn clear(&self) -> Result<()> {
        let _ = self.aria.call("purgeDownloadResult", vec![]).await;
        self.yt.clear_finished();
        Ok(())
    }

    pub async fn shutdown(&self) {
        self.yt.stop_all();
        self.save();
        let _ = self.aria.call("saveSession", vec![]).await;
        let _ = self.aria.call("forceShutdown", vec![]).await;
    }
}

/// Deletes the partial data of an unfinished aria2 download, but only when
/// aria2's control file is present (so we never delete a file aria2 did not create).
fn delete_partial_files(st: &Value) {
    let dir = PathBuf::from(st["dir"].as_str().unwrap_or(""));
    let files = parse_files(&st["files"]);
    if let Some(name) = st["bittorrent"]["info"]["name"].as_str() {
        let control = dir.join(format!("{name}.aria2"));
        if !control.exists() {
            return;
        }
        for f in files.iter().filter(|f| f.selected && !f.path.is_empty()) {
            let _ = std::fs::remove_file(&f.path);
            // remove now-empty parent directories up to the download dir
            let mut p = Path::new(&f.path).parent();
            while let Some(d) = p {
                if d == dir || !d.starts_with(&dir) || std::fs::remove_dir(d).is_err() {
                    break;
                }
                p = d.parent();
            }
        }
        let _ = std::fs::remove_file(control);
    } else {
        for f in files.iter().filter(|f| !f.path.is_empty()) {
            let control = PathBuf::from(format!("{}.aria2", f.path));
            if control.exists() {
                let _ = std::fs::remove_file(&f.path);
                let _ = std::fs::remove_file(control);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decode() {
        assert_eq!(percent_decode("My%20File%2B1.zip"), "My File+1.zip");
        assert_eq!(percent_decode("bad%zz%"), "bad%zz%");
    }
    #[test]
    fn names() {
        let it = json!({"gid":"1","files":[{"path":"","uris":[{"uri":"https://ex.com/dir/ubuntu%2024.iso?x=1"}]}]});
        assert_eq!(display_name(&it), "ubuntu 24.iso");
        let m = json!({"gid":"1","infoHash":"abcdef0123456789","files":[{"path":"[METADATA]abcdef","uris":[]}]});
        assert_eq!(display_name(&m), "magnet abcdef012345");
    }
}
