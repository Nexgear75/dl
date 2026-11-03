mod aria2;
mod config;
mod core;
mod detect;
mod notify;
mod server;
mod ytdlp;

use anyhow::Result;
use std::os::fd::AsRawFd;
use std::time::Duration;
use tokio::signal::unix::{SignalKind, signal};

use crate::config::{Config, data_dir, socket_path};

fn redirect_logs(path: &std::path::Path) {
    if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        unsafe {
            libc::dup2(f.as_raw_fd(), 2);
        }
        std::mem::forget(f);
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("dl-daemon {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let foreground = args.iter().any(|a| a == "--foreground");

    let data = data_dir();
    std::fs::create_dir_all(&data)?;
    let sock = socket_path();
    if sock.exists() {
        if std::os::unix::net::UnixStream::connect(&sock).is_ok() {
            eprintln!("dl-daemon already running ({})", sock.display());
            return Ok(());
        }
        std::fs::remove_file(&sock)?;
    }
    if !foreground {
        redirect_logs(&data.join("daemon.log"));
    }
    unsafe {
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
    }

    let cfg = Config::load();
    let (_aria_child, aria) = aria2::spawn(&cfg, &data).await?;
    let core = core::Core::new(aria, cfg, &data);
    eprintln!("dl-daemon started, socket {}", sock.display());

    let poller = core.clone();
    tokio::spawn(async move {
        let mut failures = 0;
        let mut tick = tokio::time::interval(Duration::from_millis(500));
        loop {
            tick.tick().await;
            poller.yt.tick();
            match poller.poll().await {
                Ok(()) => failures = 0,
                Err(e) => {
                    failures += 1;
                    eprintln!("poll error: {e:#}");
                    if failures >= 20 {
                        eprintln!("aria2 is unreachable, exiting");
                        poller.yt.stop_all();
                        let _ = std::fs::remove_file(socket_path());
                        std::process::exit(1);
                    }
                }
            }
        }
    });

    let stopper = core.clone();
    tokio::spawn(async move {
        let mut term = signal(SignalKind::terminate()).unwrap();
        let mut int = signal(SignalKind::interrupt()).unwrap();
        tokio::select! {
            _ = term.recv() => {},
            _ = int.recv() => {},
        }
        stopper.shutdown().await;
        let _ = std::fs::remove_file(socket_path());
        std::process::exit(0);
    });

    server::run(core, sock).await
}
