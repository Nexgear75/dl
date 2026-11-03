//! Newline-delimited JSON over a Unix socket.
//!   request : {"id": 1, "method": "add", "params": {...}}
//!   response: {"id": 1, "ok": true, "result": ...} | {"id": 1, "ok": false, "error": "..."}
//!   event   : {"event": "state", "data": {...}}

use anyhow::{Result, anyhow};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::sync::mpsc;

use crate::config::parse_size;
use crate::core::Core;
use crate::detect::{Target, detect, detect_link};
use crate::ytdlp::VideoPrefs;

#[derive(Deserialize)]
struct Request {
    id: u64,
    method: String,
    #[serde(default)]
    params: Value,
}

fn s(p: &Value, k: &str) -> Option<String> {
    p[k].as_str().map(String::from)
}

fn need(p: &Value, k: &str) -> Result<String> {
    s(p, k).ok_or_else(|| anyhow!("missing param {k}"))
}

fn describe(t: &Target) -> Value {
    match t {
        Target::Batch(_, links) | Target::Multi(links) => {
            let mut videos = 0;
            let mut torrents = 0;
            for l in links {
                match detect_link(l).map(|t| t.kind()) {
                    Some("video") => videos += 1,
                    Some("torrent" | "magnet") => torrents += 1,
                    _ => {}
                }
            }
            json!({"kind": t.kind(), "links": links.len(), "videos": videos, "torrents": torrents})
        }
        _ => json!({"kind": t.kind()}),
    }
}

async fn dispatch(core: &Arc<Core>, method: &str, p: Value) -> Result<Value> {
    Ok(match method {
        "ping" => json!("pong"),
        "config" => json!({
            "download_dir": core.cfg.download_dir().display().to_string(),
            "max_concurrent": core.cfg.max_concurrent,
        }),
        "detect" => {
            let t = detect(&need(&p, "input")?).map_err(|e| anyhow!(e))?;
            describe(&t)
        }
        "probe" => serde_json::to_value(core.yt.probe(&need(&p, "url")?).await?)?,
        "add" => {
            let video: Option<VideoPrefs> = if p["video"].is_object() {
                Some(serde_json::from_value(p["video"].clone())?)
            } else {
                None
            };
            core.add(&need(&p, "input")?, s(&p, "dir"), video, p["select"].as_bool().unwrap_or(true)).await?
        }
        "select" => {
            let idx: Vec<u32> = serde_json::from_value(p["indices"].clone()).unwrap_or_default();
            core.select(&need(&p, "id")?, idx).await?;
            json!(true)
        }
        "pause" => {
            core.pause(&need(&p, "id")?).await?;
            json!(true)
        }
        "resume" => {
            core.resume(&need(&p, "id")?).await?;
            json!(true)
        }
        "pause_all" => {
            core.pause_all().await?;
            json!(true)
        }
        "resume_all" => {
            core.resume_all().await?;
            json!(true)
        }
        "remove" => {
            core.remove(&need(&p, "id")?, p["delete"].as_bool().unwrap_or(false)).await?;
            json!(true)
        }
        "limit" => {
            let bytes = match &p["limit"] {
                Value::Number(n) => n.as_u64().unwrap_or(0),
                Value::String(v) => parse_size(v).ok_or_else(|| anyhow!("invalid limit: {v} (try 2M, 500K, 0)"))?,
                _ => 0,
            };
            core.limit(p["id"].as_str(), bytes).await?;
            json!(bytes)
        }
        "clear" => {
            core.clear().await?;
            json!(true)
        }
        "shutdown" => {
            let c = core.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                c.shutdown().await;
                let _ = std::fs::remove_file(crate::config::socket_path());
                std::process::exit(0);
            });
            json!(true)
        }
        m => return Err(anyhow!("unknown method {m}")),
    })
}

pub async fn run(core: Arc<Core>, sock: PathBuf) -> Result<()> {
    let listener = UnixListener::bind(&sock)?;
    loop {
        let (stream, _) = listener.accept().await?;
        let core = core.clone();
        tokio::spawn(async move {
            core.clients.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let (rd, mut wr) = stream.into_split();
            let (tx, mut rx) = mpsc::unbounded_channel::<String>();
            let mut events = core.events.subscribe();
            let initial = core.last_state.lock().unwrap().clone();
            if !initial.is_empty() {
                let _ = tx.send(initial);
            }
            let writer = tokio::spawn(async move {
                loop {
                    let line = tokio::select! {
                        l = rx.recv() => match l { Some(l) => l, None => break },
                        e = events.recv() => match e {
                            Ok(l) => l,
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(_) => break,
                        },
                    };
                    if wr.write_all(line.as_bytes()).await.is_err() || wr.write_all(b"\n").await.is_err() {
                        break;
                    }
                }
            });
            let mut lines = BufReader::new(rd).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let req: Request = match serde_json::from_str(&line) {
                    Ok(r) => r,
                    Err(e) => {
                        let _ = tx.send(json!({"id": 0, "ok": false, "error": format!("bad request: {e}")}).to_string());
                        continue;
                    }
                };
                let core = core.clone();
                let tx = tx.clone();
                tokio::spawn(async move {
                    let resp = match dispatch(&core, &req.method, req.params).await {
                        Ok(r) => json!({"id": req.id, "ok": true, "result": r}),
                        Err(e) => json!({"id": req.id, "ok": false, "error": e.to_string()}),
                    };
                    let _ = tx.send(resp.to_string());
                    // push a fresh state right after any mutation
                    if !matches!(req.method.as_str(), "ping" | "config" | "detect" | "probe") {
                        let _ = core.poll().await;
                    }
                });
            }
            drop(tx);
            writer.abort();
            core.clients.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        });
    }
}
