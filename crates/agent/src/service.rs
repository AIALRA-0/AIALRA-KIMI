#[cfg(unix)]
use std::path::Path;

use anyhow::Result;

#[cfg(windows)]
const WINDOWS_RUN_VALUE: &str = "AIALRA-KIMI-Agent";

pub fn install() -> Result<()> {
    install_platform()
}

pub fn uninstall() -> Result<()> {
    uninstall_platform()
}

#[cfg(windows)]
fn install_platform() -> Result<()> {
    use anyhow::{Context, bail};
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let executable = std::env::current_exe().context("failed to resolve the agent executable")?;
    let state_dir = crate::config::data_dir()?;
    let home = directories::BaseDirs::new().context("unable to resolve the user profile")?;
    let kimi_home = home.home_dir().join(".kimi-code");
    std::fs::create_dir_all(&state_dir).context("failed to create the agent state directory")?;
    std::fs::write(state_dir.join("watchdog.stop"), b"replace")
        .context("failed to signal the previous watchdog")?;
    std::thread::sleep(std::time::Duration::from_secs(6));
    let _ = std::fs::remove_file(state_dir.join("watchdog.stop"));
    let action = watchdog_action(&executable, &state_dir, &kimi_home);
    let status = Command::new("reg.exe")
        .args([
            "ADD",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            WINDOWS_RUN_VALUE,
            "/t",
            "REG_SZ",
            "/d",
            &action,
            "/f",
        ])
        .status()
        .context("failed to create the current-user startup entry")?;
    if !status.success() {
        bail!("Windows rejected the current-user agent startup entry");
    }
    Command::new(&executable)
        .args([
            "watchdog",
            "--state-dir",
            &state_dir.to_string_lossy(),
            "--kimi-home",
            &kimi_home.to_string_lossy(),
        ])
        .creation_flags(0x0000_0008 | 0x0800_0000)
        .spawn()
        .context("failed to start the current-user agent watchdog")?;
    println!("Installed and started the current-user AIALRA-KIMI watchdog");
    println!("The watchdog starts at sign-in and restarts the agent after failures");
    Ok(())
}

#[cfg(windows)]
fn watchdog_action(
    executable: &std::path::Path,
    state_dir: &std::path::Path,
    kimi_home: &std::path::Path,
) -> String {
    format!(
        "\"{}\" watchdog --state-dir \"{}\" --kimi-home \"{}\"",
        executable.display(),
        state_dir.display(),
        kimi_home.display()
    )
}

#[cfg(windows)]
pub async fn run_watchdog(
    state_dir: std::path::PathBuf,
    kimi_home: std::path::PathBuf,
) -> Result<()> {
    use anyhow::Context;
    use std::time::Duration;

    let executable = std::env::current_exe().context("failed to resolve the agent executable")?;
    let stop_path = state_dir.join("watchdog.stop");
    loop {
        if stop_path.exists() {
            return Ok(());
        }
        let mut child = tokio::process::Command::new(&executable)
            .args([
                "run",
                "--state-dir",
                &state_dir.to_string_lossy(),
                "--kimi-home",
                &kimi_home.to_string_lossy(),
                "--background",
            ])
            .creation_flags(0x0800_0000)
            .spawn()
            .context("failed to start the host agent")?;
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(5)) => {
                    if stop_path.exists() {
                        let _ = child.kill().await;
                        return Ok(());
                    }
                }
                _ = child.wait() => break,
            }
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}

#[cfg(windows)]
fn uninstall_platform() -> Result<()> {
    use anyhow::{Context, bail};
    use std::process::Command;

    let status = Command::new("reg.exe")
        .args([
            "DELETE",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            WINDOWS_RUN_VALUE,
            "/f",
        ])
        .status()
        .context("failed to remove the current-user startup entry")?;
    if !status.success() {
        bail!("Windows rejected the current-user startup entry removal");
    }
    std::fs::write(crate::config::data_dir()?.join("watchdog.stop"), b"stop")
        .context("failed to stop the current-user watchdog")?;
    println!("Removed the current-user AIALRA-KIMI watchdog");
    Ok(())
}

#[cfg(unix)]
fn install_platform() -> Result<()> {
    use anyhow::{Context, bail};
    use std::fs;
    use std::process::Command;

    let executable = std::env::current_exe().context("failed to resolve the agent executable")?;
    let unit_path = linux_unit_path()?;
    let parent = unit_path
        .parent()
        .context("invalid systemd user unit path")?;
    fs::create_dir_all(parent).context("failed to create the systemd user directory")?;
    let unit = format!(
        "[Unit]\nDescription=AIALRA-KIMI outbound host agent\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart={} run\nRestart=always\nRestartSec=3\nUMask=0077\nPrivateTmp=true\nProtectSystem=full\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\n\n[Install]\nWantedBy=default.target\n",
        systemd_quote(&executable),
    );
    fs::write(&unit_path, unit).context("failed to write the systemd user unit")?;
    for args in [
        ["--user", "daemon-reload"].as_slice(),
        ["--user", "enable", "--now", "aialra-kimi-agent.service"].as_slice(),
    ] {
        let status = Command::new("systemctl")
            .args(args)
            .status()
            .context("failed to invoke systemctl --user")?;
        if !status.success() {
            bail!("systemd rejected the AIALRA-KIMI user service installation");
        }
    }
    println!("Installed and started aialra-kimi-agent.service");
    println!(
        "For a headless VPS, enable user lingering with loginctl after reviewing local policy"
    );
    Ok(())
}

#[cfg(unix)]
fn uninstall_platform() -> Result<()> {
    use anyhow::Context;
    use std::fs;
    use std::process::Command;

    let _ = Command::new("systemctl")
        .args(["--user", "disable", "--now", "aialra-kimi-agent.service"])
        .status();
    let path = linux_unit_path()?;
    if path.exists() {
        fs::remove_file(&path).context("failed to remove the systemd user unit")?;
    }
    let _ = Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .status();
    println!("Removed aialra-kimi-agent.service");
    Ok(())
}

#[cfg(unix)]
fn linux_unit_path() -> Result<std::path::PathBuf> {
    use anyhow::Context;

    let config_home = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".config"))
        })
        .context("unable to resolve the systemd user directory")?;
    Ok(config_home.join("systemd/user/aialra-kimi-agent.service"))
}

#[cfg(unix)]
fn systemd_quote(path: &Path) -> String {
    format!(
        "\"{}\"",
        path.to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
    )
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn windows_watchdog_action_quotes_all_paths() {
        let action = super::watchdog_action(
            std::path::Path::new(r"C:\Program Files\AIALRA & Kimi\agent.exe"),
            std::path::Path::new(r"C:\Users\owner\AppData\Local\AIALRA Kimi"),
            std::path::Path::new(r"C:\Users\owner\.kimi-code"),
        );
        assert!(action.starts_with('"'));
        assert!(action.contains("agent.exe\" watchdog"));
        assert!(action.contains("--state-dir \"C:\\Users\\owner"));
        assert!(action.contains("--kimi-home \"C:\\Users\\owner\\.kimi-code\""));
    }

    #[cfg(unix)]
    #[test]
    fn systemd_path_is_quoted() {
        assert_eq!(
            super::systemd_quote(std::path::Path::new("/opt/AIALRA Kimi/agent")),
            "\"/opt/AIALRA Kimi/agent\""
        );
    }
}
