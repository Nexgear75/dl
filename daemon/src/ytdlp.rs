//! Video downloads through yt-dlp (one child process per job).

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::notify;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct VideoPrefs {
    /// Max height, None = best available.
    pub height: Option<u32>,
    /// Preferred audio language code (e.g. "fr"), None = original/default.
    pub lang: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct YtJob {
    pub id: String,
    pub seq: u64,
    pub url: String,
    pub title: String,
    pub dir: String,
    pub prefs: VideoPrefs,
    pub limit: u64,
    /// waiting | active | paused | complete | error
    pub status: String,
    pub error: Option<String>,
    pub filepath: Option<String>,
    #[serde(skip)]
    pub phase: String,
    #[serde(skip)]
    pub done: u64,
    #[serde(skip)]
    pub total: u64,
    #[serde(skip)]
    pub speed: u64,
    #[serde(skip)]
    pub streams_done: u64,
    #[serde(skip)]
    pid: Option<i32>,
    /// Bumped every time the process is (re)started or killed on purpose,
    /// so a stale exit does not overwrite the job state.
    #[serde(skip)]
    run: u64,
    #[serde(skip)]
    seen_running: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct AudioLang {
    pub code: String,
    pub label: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct VideoInfo {
    pub title: String,
    pub playlist: bool,
    pub entries: Vec<String>,
    pub heights: Vec<u32>,
    pub languages: Vec<AudioLang>,
    pub duration: Option<f64>,
}

pub struct YtManager {
    jobs: Mutex<Vec<YtJob>>,
    bin: String,
    store: PathBuf,
    paths_dir: PathBuf,
    max: usize,
    seq: Arc<AtomicU64>,
    next_id: AtomicU64,
    notifications: bool,
}

fn format_selector(p: &VideoPrefs) -> String {
    let h = p.height.map(|h| format!("[height<={h}]")).unwrap_or_default();
    let mut alts = Vec::new();
    if let Some(l) = p.lang.as_deref().filter(|l| !l.is_empty()) {
        alts.push(format!("bv*{h}+ba[language^={l}]"));
    }
    alts.push(format!("bv*{h}+ba"));
    alts.push(format!("b{h}"));
    alts.push("bv*+ba/b".to_string());
    alts.join("/")
}

fn num(s: &str) -> Option<f64> {
    if s == "NA" { None } else { s.parse().ok() }
}

fn kill_group(pid: i32, sig: i32) {
    unsafe {
        libc::kill(-pid, sig);
    }
}

impl YtManager {
    pub fn new(bin: String, data_dir: &std::path::Path, max: usize, seq: Arc<AtomicU64>, notifications: bool) -> Arc<Self> {
        let store = data_dir.join("videos.json");
        let paths_dir = data_dir.join("yt");
        std::fs::create_dir_all(&paths_dir).ok();
        let mut jobs: Vec<YtJob> = std::fs::read_to_string(&store)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let mut max_id = 0;
        for j in jobs.iter_mut() {
            j.seq = seq.fetch_add(1, Ordering::SeqCst);
            if j.status == "active" {
                j.status = "waiting".into();
            }
            if let Some(n) = j.id.strip_prefix("y:").and_then(|n| n.parse::<u64>().ok()) {
                max_id = max_id.max(n);
            }
        }
        Arc::new(YtManager {
            jobs: Mutex::new(jobs),
            bin,
            store,
            paths_dir,
            max: max.max(1),
            seq,
            next_id: AtomicU64::new(max_id + 1),
            notifications,
        })
    }

    pub fn snapshot(&self) -> Vec<YtJob> {
        self.jobs.lock().unwrap().clone()
    }

    fn save(&self) {
        let jobs = self.jobs.lock().unwrap();
        let keep: Vec<&YtJob> = jobs.iter().filter(|j| j.status != "complete").collect();
        if let Ok(s) = serde_json::to_string_pretty(&keep) {
            let _ = std::fs::write(&self.store, s);
        }
    }

    pub async fn probe(&self, url: &str) -> Result<VideoInfo> {
        let out = tokio::time::timeout(
            Duration::from_secs(90),
            Command::new(&self.bin)
                .args(["-J", "--flat-playlist", "--no-warnings", url])
                .stdin(Stdio::null())
                .output(),
        )
        .await
        .context("yt-dlp timed out")?
        .with_context(|| format!("cannot run {} (is yt-dlp installed?)", self.bin))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            let line = err.lines().rev().find(|l| l.contains("ERROR")).unwrap_or("yt-dlp failed");
            bail!("{}", line.trim_start_matches("ERROR: "));
        }
        let v: Value = serde_json::from_slice(&out.stdout)?;
        let title = v["title"].as_str().unwrap_or("video").to_string();
        if v["_type"].as_str() == Some("playlist") {
            let entries = v["entries"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|e| e["url"].as_str().or(e["webpage_url"].as_str()).map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            return Ok(VideoInfo { title, playlist: true, entries, heights: vec![], languages: vec![], duration: None });
        }
        let mut heights: Vec<u32> = Vec::new();
        let mut languages: Vec<AudioLang> = Vec::new();
        for f in v["formats"].as_array().into_iter().flatten() {
            let vcodec = f["vcodec"].as_str().unwrap_or("");
            if let Some(h) = f["height"].as_u64() {
                if vcodec != "none" && !heights.contains(&(h as u32)) {
                    heights.push(h as u32);
                }
            }
            let acodec = f["acodec"].as_str().unwrap_or("");
            if vcodec == "none" && acodec != "none" {
                if let Some(code) = f["language"].as_str() {
                    let base = code.split('-').next().unwrap_or(code).to_string();
                    if !languages.iter().any(|l| l.code == base) {
                        let note = f["format_note"].as_str().unwrap_or("");
                        let label = note.split(',').next().unwrap_or("").trim();
                        let label = if label.is_empty() || label.eq_ignore_ascii_case("default") { code } else { label };
                        languages.push(AudioLang { code: base, label: label.to_string() });
                    }
                }
            }
        }
        heights.sort_unstable_by(|a, b| b.cmp(a));
        Ok(VideoInfo { title, playlist: false, entries: vec![], heights, languages, duration: v["duration"].as_f64() })
    }

    pub fn add(&self, url: &str, dir: &str, prefs: VideoPrefs) -> String {
        let id = format!("y:{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let job = YtJob {
            id: id.clone(),
            seq: self.seq.fetch_add(1, Ordering::SeqCst),
            url: url.to_string(),
            title: url.to_string(),
            dir: dir.to_string(),
            prefs,
            limit: 0,
            status: "waiting".into(),
            error: None,
            filepath: None,
            phase: String::new(),
            done: 0,
            total: 0,
            speed: 0,
            streams_done: 0,
            pid: None,
            run: 0,
            seen_running: false,
        };
        self.jobs.lock().unwrap().push(job);
        self.save();
        id
    }

    /// Starts queued jobs while there is room.
    pub fn tick(self: &Arc<Self>) {
        let to_start: Vec<String> = {
            let jobs = self.jobs.lock().unwrap();
            let running = jobs.iter().filter(|j| j.status == "active").count();
            jobs.iter()
                .filter(|j| j.status == "waiting")
                .take(self.max.saturating_sub(running))
                .map(|j| j.id.clone())
                .collect()
        };
        for id in to_start {
            self.start(&id);
        }
    }

    fn start(self: &Arc<Self>, id: &str) {
        let (job, run) = {
            let mut jobs = self.jobs.lock().unwrap();
            let Some(j) = jobs.iter_mut().find(|j| j.id == id) else { return };
            j.run += 1;
            j.status = "active".into();
            j.error = None;
            j.speed = 0;
            j.phase = "starting".into();
            j.seen_running = true;
            (j.clone(), j.run)
        };
        let path_file = self.paths_dir.join(format!("{}.path", id.replace(':', "_")));
        let _ = std::fs::remove_file(&path_file);
        let mut cmd = Command::new(&self.bin);
        cmd.args([
            "--newline",
            "--no-colors",
            "--no-playlist",
            "-N",
            "4",
            "-f",
            &format_selector(&job.prefs),
            "-P",
            &job.dir,
            "-o",
            "%(title)s [%(height)sp].%(ext)s",
            "--progress-template",
            "download:DLP|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(info.vcodec)s|%(info.title)s",
            "--print-to-file",
            "after_move:%(filepath)s",
        ]);
        cmd.arg(&path_file);
        if job.limit > 0 {
            cmd.args(["-r", &job.limit.to_string()]);
        }
        cmd.arg(&job.url)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                self.update(id, run, |j| {
                    j.status = "error".into();
                    j.error = Some(format!("cannot run yt-dlp: {e}"));
                });
                return;
            }
        };
        let pid = child.id().map(|p| p as i32);
        self.update(id, run, |j| j.pid = pid);

        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let me = self.clone();
        let jid = id.to_string();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                me.on_line(&jid, run, &line);
            }
        });
        let last_err = Arc::new(Mutex::new(String::new()));
        let le = last_err.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.starts_with("ERROR") {
                    *le.lock().unwrap() = line.trim_start_matches("ERROR: ").to_string();
                }
            }
        });
        let me = self.clone();
        let jid = id.to_string();
        tokio::spawn(async move {
            let status = child.wait().await;
            let ok = status.map(|s| s.success()).unwrap_or(false);
            let filepath = std::fs::read_to_string(&path_file).ok().map(|s| s.trim().to_string());
            let _ = std::fs::remove_file(&path_file);
            let err = last_err.lock().unwrap().clone();
            let mut finished: Option<(bool, String)> = None;
            me.update(&jid, run, |j| {
                j.pid = None;
                j.speed = 0;
                if ok {
                    j.status = "complete".into();
                    j.phase = String::new();
                    j.filepath = filepath.clone();
                    let size = filepath.as_ref().and_then(|f| std::fs::metadata(f).ok()).map(|m| m.len());
                    if let Some(size) = size {
                        j.total = size;
                    }
                    j.done = j.total;
                } else {
                    j.status = "error".into();
                    j.error = Some(if err.is_empty() { "yt-dlp failed".into() } else { err.clone() });
                }
                finished = Some((ok, j.title.clone()));
            });
            me.save();
            if let Some((ok, title)) = finished {
                if me.notifications {
                    if ok {
                        notify::send("Download complete", &title);
                    } else {
                        notify::send("Download failed", &title);
                    }
                }
            }
        });
    }

    fn update(&self, id: &str, run: u64, f: impl FnOnce(&mut YtJob)) {
        let mut jobs = self.jobs.lock().unwrap();
        if let Some(j) = jobs.iter_mut().find(|j| j.id == id && j.run == run) {
            f(j);
        }
    }

    fn on_line(&self, id: &str, run: u64, line: &str) {
        if let Some(rest) = line.strip_prefix("DLP|") {
            let parts: Vec<&str> = rest.splitn(6, '|').collect();
            if parts.len() < 6 {
                return;
            }
            let done = num(parts[0]).unwrap_or(0.0) as u64;
            let total = num(parts[1]).or(num(parts[2])).unwrap_or(0.0) as u64;
            let speed = num(parts[3]).unwrap_or(0.0) as u64;
            let phase = if parts[4] == "none" { "audio" } else { "video" };
            let title = parts[5];
            self.update(id, run, |j| {
                if j.phase != phase && (j.phase == "video" || j.phase == "audio") {
                    j.streams_done += 1;
                }
                j.phase = phase.into();
                j.done = done;
                j.total = total.max(done);
                j.speed = speed;
                if title != "NA" && !title.is_empty() {
                    j.title = title.to_string();
                }
            });
        } else if line.starts_with("[Merger]") || line.starts_with("[VideoConvertor]") || line.starts_with("[ExtractAudio]") {
            self.update(id, run, |j| {
                j.phase = "merging".into();
                j.speed = 0;
            });
        }
    }

    fn find(&self, id: &str) -> Option<YtJob> {
        self.jobs.lock().unwrap().iter().find(|j| j.id == id).cloned()
    }

    pub fn pause(&self, id: &str) {
        let mut jobs = self.jobs.lock().unwrap();
        if let Some(j) = jobs.iter_mut().find(|j| j.id == id) {
            match j.status.as_str() {
                "active" => {
                    if let Some(pid) = j.pid {
                        kill_group(pid, libc::SIGSTOP);
                    }
                    j.status = "paused".into();
                    j.speed = 0;
                }
                "waiting" => j.status = "paused".into(),
                _ => {}
            }
        }
    }

    pub fn resume(&self, id: &str) {
        let mut jobs = self.jobs.lock().unwrap();
        if let Some(j) = jobs.iter_mut().find(|j| j.id == id) {
            match (j.status.as_str(), j.pid) {
                ("paused", Some(pid)) => {
                    kill_group(pid, libc::SIGCONT);
                    j.status = "active".into();
                }
                ("paused", None) | ("error", _) => j.status = "waiting".into(),
                _ => {}
            }
        }
    }

    pub fn pause_all(&self) {
        let ids: Vec<String> = self.snapshot().into_iter().map(|j| j.id).collect();
        ids.iter().for_each(|id| self.pause(id));
    }

    pub fn resume_all(&self) {
        let ids: Vec<String> = self
            .snapshot()
            .into_iter()
            .filter(|j| j.status == "paused")
            .map(|j| j.id)
            .collect();
        ids.iter().for_each(|id| self.resume(id));
    }

    /// Kills the process (if any). The job stays in the list unless `forget`.
    fn kill(&self, id: &str, forget: bool) -> Option<YtJob> {
        let mut jobs = self.jobs.lock().unwrap();
        let idx = jobs.iter().position(|j| j.id == id)?;
        let j = &mut jobs[idx];
        j.run += 1; // invalidate the running process' updates
        if let Some(pid) = j.pid.take() {
            kill_group(pid, libc::SIGCONT);
            kill_group(pid, libc::SIGTERM);
        }
        if forget { Some(jobs.remove(idx)) } else { Some(j.clone()) }
    }

    pub fn remove(&self, id: &str, delete_partial: bool) {
        if let Some(job) = self.kill(id, true) {
            if delete_partial && job.status != "complete" {
                // yt-dlp leaves "<name>.part" / ".ytdl" files; remove those matching the title.
                let dir = PathBuf::from(&job.dir);
                let stem = job.title.replace('/', "⧸");
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(500));
                    if let Ok(rd) = std::fs::read_dir(&dir) {
                        for e in rd.flatten() {
                            let name = e.file_name().to_string_lossy().to_string();
                            if name.starts_with(&stem) && (name.ends_with(".part") || name.ends_with(".ytdl") || name.contains(".part-Frag")) {
                                let _ = std::fs::remove_file(e.path());
                            }
                        }
                    }
                });
            }
        }
        self.save();
    }

    pub fn set_limit(self: &Arc<Self>, id: &str, bytes: u64) {
        let was_active = {
            let mut jobs = self.jobs.lock().unwrap();
            let Some(j) = jobs.iter_mut().find(|j| j.id == id) else { return };
            j.limit = bytes;
            j.status == "active"
        };
        if was_active {
            // yt-dlp cannot change its rate on the fly: restart it, it resumes from .part.
            self.kill(id, false);
            self.start(id);
        }
        self.save();
    }

    pub fn clear_finished(&self) {
        self.jobs
            .lock()
            .unwrap()
            .retain(|j| j.status != "complete" && j.status != "error");
        self.save();
    }

    pub fn stop_all(&self) {
        let jobs = self.jobs.lock().unwrap();
        for j in jobs.iter() {
            if let Some(pid) = j.pid {
                kill_group(pid, libc::SIGCONT);
                kill_group(pid, libc::SIGTERM);
            }
        }
        drop(jobs);
        self.save();
    }

    pub fn exists(&self, id: &str) -> bool {
        self.find(id).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selector() {
        assert_eq!(format_selector(&VideoPrefs::default()), "bv*+ba/b/bv*+ba/b");
        assert_eq!(
            format_selector(&VideoPrefs { height: Some(1080), lang: Some("fr".into()) }),
            "bv*[height<=1080]+ba[language^=fr]/bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b"
        );
    }
}
