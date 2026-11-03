use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;
use tokio::process::{Child, Command};

use crate::config::{Config, parse_size};

pub struct Aria2 {
    url: String,
    token: String,
    http: reqwest::Client,
}

impl Aria2 {
    pub async fn call(&self, method: &str, params: Vec<Value>) -> Result<Value> {
        let mut p = vec![json!(format!("token:{}", self.token))];
        p.extend(params);
        let body = json!({"jsonrpc": "2.0", "id": "dl", "method": format!("aria2.{method}"), "params": p});
        let resp: Value = self
            .http
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("aria2 rpc {method}"))?
            .json()
            .await?;
        if let Some(err) = resp.get("error") {
            bail!("{}", err["message"].as_str().unwrap_or("aria2 error"));
        }
        Ok(resp["result"].clone())
    }
}

fn random_hex(n: usize) -> String {
    use std::io::Read;
    let mut buf = vec![0u8; n];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut buf);
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn free_port() -> Result<u16> {
    let l = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(l.local_addr()?.port())
}

pub async fn spawn(cfg: &Config, data_dir: &Path) -> Result<(Child, Aria2)> {
    let port = free_port()?;
    let token = random_hex(16);
    let session = data_dir.join("aria2.session");
    if !session.exists() {
        std::fs::write(&session, "")?;
    }
    let dl_dir = cfg.download_dir();
    std::fs::create_dir_all(&dl_dir).ok();
    let conns = cfg.connections.clamp(1, 16);
    let limit = parse_size(&cfg.global_limit).unwrap_or(0);

    let mut cmd = Command::new(&cfg.aria2c_path);
    cmd.args([
        "--enable-rpc=true".to_string(),
        "--rpc-listen-all=false".to_string(),
        format!("--rpc-listen-port={port}"),
        format!("--rpc-secret={token}"),
        format!("--dir={}", dl_dir.display()),
        "--continue=true".to_string(),
        format!("--max-concurrent-downloads={}", cfg.max_concurrent.max(1)),
        format!("--split={conns}"),
        format!("--max-connection-per-server={conns}"),
        "--min-split-size=1M".to_string(),
        "--seed-time=0".to_string(),
        "--follow-torrent=mem".to_string(),
        "--follow-metalink=mem".to_string(),
        "--auto-file-renaming=true".to_string(),
        "--file-allocation=none".to_string(),
        "--enable-dht=true".to_string(),
        "--bt-enable-lpd=true".to_string(),
        "--enable-peer-exchange=true".to_string(),
        format!("--max-overall-download-limit={limit}"),
        format!("--save-session={}", session.display()),
        format!("--input-file={}", session.display()),
        "--save-session-interval=10".to_string(),
        format!("--stop-with-process={}", std::process::id()),
        "--summary-interval=0".to_string(),
        "--console-log-level=warn".to_string(),
        "--quiet=true".to_string(),
    ]);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .process_group(0);
    let child = cmd
        .spawn()
        .with_context(|| format!("cannot start {} (is aria2 installed?)", cfg.aria2c_path))?;

    let aria = Aria2 {
        url: format!("http://127.0.0.1:{port}/jsonrpc"),
        token,
        http: reqwest::Client::new(),
    };
    for _ in 0..50 {
        if aria.call("getVersion", vec![]).await.is_ok() {
            return Ok((child, aria));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(anyhow!("aria2c did not answer on port {port}"))
}
