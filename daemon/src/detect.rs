use regex::Regex;
use std::path::PathBuf;
use std::sync::LazyLock;

use crate::config::expand;

#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    Http(String),
    Magnet(String),
    /// Remote .torrent URL (aria2 fetches it, then follows it).
    TorrentUrl(String),
    TorrentFile(PathBuf),
    Metalink(PathBuf),
    Video(String),
    /// A text/markdown file containing links.
    Batch(PathBuf, Vec<String>),
    /// Several links typed or pasted at once.
    Multi(Vec<String>),
}

impl Target {
    pub fn kind(&self) -> &'static str {
        match self {
            Target::Http(_) => "http",
            Target::Magnet(_) => "magnet",
            Target::TorrentUrl(_) | Target::TorrentFile(_) => "torrent",
            Target::Metalink(_) => "metalink",
            Target::Video(_) => "video",
            Target::Batch(..) => "batch",
            Target::Multi(_) => "multi",
        }
    }
}

const VIDEO_HOSTS: &[&str] = &[
    "youtube.com",
    "youtu.be",
    "youtube-nocookie.com",
    "vimeo.com",
    "dailymotion.com",
    "dai.ly",
    "twitch.tv",
    "x.com",
    "twitter.com",
    "tiktok.com",
    "instagram.com",
    "facebook.com",
    "fb.watch",
    "reddit.com",
    "v.redd.it",
    "soundcloud.com",
    "bilibili.com",
    "arte.tv",
    "france.tv",
    "rumble.com",
    "streamable.com",
    "odysee.com",
    "bandcamp.com",
    "kick.com",
    "nebula.tv",
];

static LINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:yt:)?(?:https?|ftp|sftp)://[^\s<>()\[\]"'`]+|magnet:\?[^\s<>()\[\]"'`]+"#).unwrap()
});

fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let host = rest.split(['/', '?', '#']).next()?;
    let host = host.rsplit('@').next()?; // strip credentials
    let host = host.split(':').next()?; // strip port
    Some(host.to_lowercase())
}

pub fn is_video_url(url: &str) -> bool {
    match host_of(url) {
        Some(h) => VIDEO_HOSTS
            .iter()
            .any(|v| h == *v || h.ends_with(&format!(".{v}"))),
        None => false,
    }
}

/// Classify a single URL-like link (no local files).
pub fn detect_link(link: &str) -> Option<Target> {
    let l = link.trim().trim_end_matches(['.', ',', ';']);
    if let Some(u) = l.strip_prefix("yt:") {
        return Some(Target::Video(u.to_string()));
    }
    let lower = l.to_lowercase();
    if lower.starts_with("magnet:?") {
        return Some(Target::Magnet(l.to_string()));
    }
    if !(lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("ftp://")
        || lower.starts_with("sftp://"))
    {
        return None;
    }
    if is_video_url(l) {
        return Some(Target::Video(l.to_string()));
    }
    let path = lower.split(['?', '#']).next().unwrap_or("");
    if path.ends_with(".torrent") {
        return Some(Target::TorrentUrl(l.to_string()));
    }
    Some(Target::Http(l.to_string()))
}

pub fn extract_links(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for m in LINK_RE.find_iter(text) {
        let l = m.as_str().trim_end_matches(['.', ',', ';', ':']).to_string();
        if !out.contains(&l) {
            out.push(l);
        }
    }
    out
}

pub fn detect(input: &str) -> Result<Target, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("empty input".into());
    }
    // Several links at once (pasted list).
    if input.split_whitespace().count() > 1 {
        let links = extract_links(input);
        if links.len() > 1 {
            return Ok(Target::Multi(links));
        }
    }
    if let Some(t) = detect_link(input) {
        return Ok(t);
    }
    let path = expand(input);
    if path.is_dir() {
        return Err("this is a directory, pick a file".into());
    }
    if !path.is_file() {
        return Err(format!("not a link or an existing file: {input}"));
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "torrent" => Ok(Target::TorrentFile(path)),
        "metalink" | "meta4" => Ok(Target::Metalink(path)),
        _ => {
            let text = std::fs::read_to_string(&path)
                .map_err(|_| "unsupported file (expected .torrent, .metalink, .txt or .md)".to_string())?;
            let links = extract_links(&text);
            if links.is_empty() {
                Err("no link found in this file".into())
            } else {
                Ok(Target::Batch(path, links))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links() {
        assert_eq!(detect_link("https://youtu.be/abc").unwrap().kind(), "video");
        assert_eq!(detect_link("https://www.youtube.com/watch?v=x").unwrap().kind(), "video");
        assert_eq!(detect_link("https://notyoutube.com/a.zip").unwrap().kind(), "http");
        assert_eq!(detect_link("https://ex.com/ubuntu.iso").unwrap().kind(), "http");
        assert_eq!(detect_link("https://ex.com/a.torrent?x=1").unwrap().kind(), "torrent");
        assert_eq!(detect_link("magnet:?xt=urn:btih:abc").unwrap().kind(), "magnet");
        assert_eq!(detect_link("yt:https://ex.com/page").unwrap(), Target::Video("https://ex.com/page".into()));
        assert!(detect_link("hello").is_none());
    }

    #[test]
    fn markdown_extraction() {
        let md = "# list\n- [iso](https://ex.com/a.iso)\n- https://youtu.be/x, and\nmagnet:?xt=urn:btih:abc&dn=x\nhttps://ex.com/a.iso";
        assert_eq!(
            extract_links(md),
            vec!["https://ex.com/a.iso", "https://youtu.be/x", "magnet:?xt=urn:btih:abc&dn=x"]
        );
    }

    #[test]
    fn multi() {
        match detect("https://a.com/1.zip https://b.com/2.zip").unwrap() {
            Target::Multi(l) => assert_eq!(l.len(), 2),
            t => panic!("{t:?}"),
        }
    }
}
