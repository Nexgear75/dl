/// Fire-and-forget macOS notification through AppleScript.
pub fn send(title: &str, body: &str) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "display notification \"{}\" with title \"dl\" subtitle \"{}\"",
        esc(body),
        esc(title)
    );
    let _ = std::process::Command::new("osascript")
        .args(["-e", &script])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}
