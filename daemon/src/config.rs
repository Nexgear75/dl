use serde::Deserialize;
use std::path::PathBuf;

#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Config {
    /// Default destination directory.
    pub download_dir: String,
    /// Max downloads running at the same time (aria2 and yt-dlp each).
    pub max_concurrent: u32,
    /// Connections per HTTP download.
    pub connections: u32,
    /// Global download limit, e.g. "0" (none), "5M", "800K".
    pub global_limit: String,
    /// macOS notification when a download finishes or fails.
    pub notifications: bool,
    /// Stop the daemon after this many minutes with nothing downloading and
    /// no dl/tf window open (0 = never). It restarts on demand.
    pub idle_exit_minutes: u64,
    pub aria2c_path: String,
    pub ytdlp_path: String,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            download_dir: "~/Downloads".into(),
            max_concurrent: 5,
            connections: 16,
            global_limit: "0".into(),
            notifications: true,
            idle_exit_minutes: 5,
            aria2c_path: "aria2c".into(),
            ytdlp_path: "yt-dlp".into(),
        }
    }
}

const DEFAULT_FILE: &str = r#"# dl configuration
download_dir = "~/Downloads"
max_concurrent = 5
connections = 16
# "0" = unlimited, otherwise e.g. "5M" or "800K"
global_limit = "0"
notifications = true
# stop the background daemon after N idle minutes (nothing downloading, no
# window open); it starts again by itself when needed. 0 = keep it running
idle_exit_minutes = 5
aria2c_path = "aria2c"
ytdlp_path = "yt-dlp"
"#;

pub fn home() -> PathBuf {
    dirs::home_dir().expect("cannot resolve home directory")
}

pub fn expand(p: &str) -> PathBuf {
    let p = p.trim();
    if p == "~" {
        home()
    } else if let Some(rest) = p.strip_prefix("~/") {
        home().join(rest)
    } else {
        PathBuf::from(p)
    }
}

pub fn data_dir() -> PathBuf {
    match std::env::var("DL_DATA_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ => home().join(".local/share/dl"),
    }
}

pub fn socket_path() -> PathBuf {
    match std::env::var("DL_SOCKET") {
        Ok(s) if !s.is_empty() => PathBuf::from(s),
        _ => data_dir().join("dl.sock"),
    }
}

pub fn config_path() -> PathBuf {
    home().join(".config/dl/config.toml")
}

impl Config {
    pub fn load() -> Config {
        let path = config_path();
        match std::fs::read_to_string(&path) {
            Ok(s) => toml::from_str(&s).unwrap_or_else(|e| {
                eprintln!("invalid config {}: {e}", path.display());
                Config::default()
            }),
            Err(_) => {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&path, DEFAULT_FILE);
                Config::default()
            }
        }
    }

    pub fn download_dir(&self) -> PathBuf {
        expand(&self.download_dir)
    }
}

/// Parses "0", "500K", "2M", "1.5MB", "1G" (base 1024) into bytes.
pub fn parse_size(s: &str) -> Option<u64> {
    let s = s.trim().to_uppercase();
    let s = s.trim_end_matches("/S").trim_end_matches('B').trim_end_matches("I");
    if s.is_empty() {
        return Some(0);
    }
    let (num, mult) = match s.chars().last()? {
        'K' => (&s[..s.len() - 1], 1024f64),
        'M' => (&s[..s.len() - 1], 1024f64 * 1024.0),
        'G' => (&s[..s.len() - 1], 1024f64 * 1024.0 * 1024.0),
        _ => (s, 1f64),
    };
    let n: f64 = num.trim().parse().ok()?;
    if n < 0.0 {
        return None;
    }
    Some((n * mult) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sizes() {
        assert_eq!(parse_size("0"), Some(0));
        assert_eq!(parse_size("500K"), Some(500 * 1024));
        assert_eq!(parse_size("2M"), Some(2 * 1024 * 1024));
        assert_eq!(parse_size("1.5mb"), Some(1572864));
        assert_eq!(parse_size("2MiB"), Some(2 * 1024 * 1024));
        assert_eq!(parse_size("abc"), None);
    }
}
