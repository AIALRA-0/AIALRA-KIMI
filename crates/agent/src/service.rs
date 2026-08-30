#[cfg(unix)]
use std::path::Path;

use anyhow::Result;

#[cfg(windows)]
const WINDOWS_RUN_VALUE: &str = "AIALRA-KIMI-Agent";
#[cfg(windows)]
const WINDOWS_TASK_NAME: &str = "AIALRA-KIMI-Agent";

pub fn install() -> Result<()> {
    install_platform()
}

pub fn uninstall() -> Result<()> {
    uninstall_platform()
}

#[cfg(windows)]
fn install_platform() -> Result<()> {
    use anyhow::{Context, bail};
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
    let _ = Command::new("reg.exe")
        .args([
            "DELETE",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            WINDOWS_RUN_VALUE,
            "/f",
        ])
        .status();

    let user = String::from_utf8(
        Command::new("whoami.exe")
            .output()
            .context("failed to resolve the current Windows user")?
            .stdout,
    )
    .context("Windows returned a non-UTF-8 account name")?;
    let task_xml_path = state_dir.join("agent-task.xml");
    std::fs::write(
        &task_xml_path,
        utf16le_with_bom(&windows_task_xml(
            &executable,
            &state_dir,
            &kimi_home,
            user.trim(),
        )),
    )
    .context("failed to write the Windows task definition")?;
    let status = Command::new("schtasks.exe")
        .args([
            "/Create",
            "/TN",
            WINDOWS_TASK_NAME,
            "/XML",
            &task_xml_path.to_string_lossy(),
            "/F",
        ])
        .status()
        .context("failed to create the current-user watchdog task")?;
    let _ = std::fs::remove_file(&task_xml_path);
    if !status.success() {
        bail!("Windows rejected the current-user watchdog task");
    }
    let status = Command::new("schtasks.exe")
        .args(["/Run", "/TN", WINDOWS_TASK_NAME])
        .status()
        .context("failed to start the current-user watchdog task")?;
    if !status.success() {
        bail!("Windows rejected the watchdog task start request");
    }
    println!("Installed and started the current-user AIALRA-KIMI agent task");
    println!("Task Scheduler restarts the agent and checks it every five minutes");
    Ok(())
}

#[cfg(windows)]
fn windows_task_xml(
    executable: &std::path::Path,
    state_dir: &std::path::Path,
    kimi_home: &std::path::Path,
    user: &str,
) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>AIALRA-KIMI outbound host agent</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger>
    <CalendarTrigger>
      <Repetition><Interval>PT1M</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <StartBoundary>2000-01-01T00:00:00</StartBoundary><Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>{executable}</Command><Arguments>watchdog --state-dir &quot;{state_dir}&quot; --kimi-home &quot;{kimi_home}&quot;</Arguments></Exec></Actions>
</Task>"#,
        user = xml_escape(user),
        executable = xml_escape(&executable.to_string_lossy()),
        state_dir = xml_escape(&state_dir.to_string_lossy()),
        kimi_home = xml_escape(&kimi_home.to_string_lossy()),
    )
}

#[cfg(windows)]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(windows)]
fn utf16le_with_bom(value: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(2 + value.len() * 2);
    bytes.extend_from_slice(&[0xff, 0xfe]);
    for unit in value.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
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
        let _child_job = assign_child_to_kill_on_close_job(&child)?;
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
struct ChildJob(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for ChildJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn assign_child_to_kill_on_close_job(child: &tokio::process::Child) -> Result<ChildJob> {
    use anyhow::{Context, bail};
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };

    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(std::io::Error::last_os_error()).context("failed to create the agent job");
    }
    let job = ChildJob(job);
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if configured == 0 {
        return Err(std::io::Error::last_os_error()).context("failed to configure the agent job");
    }
    let process = child
        .raw_handle()
        .context("the child process handle is unavailable")?;
    if unsafe { AssignProcessToJobObject(job.0, process.cast()) } == 0 {
        bail!(
            "failed to assign the host agent to its job: {}",
            std::io::Error::last_os_error()
        );
    }
    Ok(job)
}

#[cfg(windows)]
fn uninstall_platform() -> Result<()> {
    use anyhow::{Context, bail};
    use std::process::Command;

    let _ = Command::new("schtasks.exe")
        .args(["/End", "/TN", WINDOWS_TASK_NAME])
        .status();
    let status = Command::new("schtasks.exe")
        .args(["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"])
        .status()
        .context("failed to remove the current-user watchdog task")?;
    if !status.success() {
        bail!("Windows rejected the watchdog task removal");
    }
    let _ = Command::new("reg.exe")
        .args([
            "DELETE",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            WINDOWS_RUN_VALUE,
            "/f",
        ])
        .status();
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
    fn windows_task_restarts_and_escapes_paths() {
        let task = super::windows_task_xml(
            std::path::Path::new(r"C:\Program Files\AIALRA & Kimi\agent.exe"),
            std::path::Path::new(r"C:\Users\owner\AppData\Local\AIALRA Kimi"),
            std::path::Path::new(r"C:\Users\owner\.kimi-code"),
            r"DESKTOP\owner",
        );
        assert!(task.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
        assert!(task.contains("<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count>"));
        assert!(task.contains("<Interval>PT1M</Interval>"));
        assert!(task.contains("AIALRA &amp; Kimi"));
        assert!(task.contains("watchdog --state-dir &quot;C:\\Users\\owner"));
        let encoded = super::utf16le_with_bom(&task);
        assert_eq!(&encoded[..2], &[0xff, 0xfe]);
        assert!(encoded.windows(4).any(|window| window == b"<\0T\0"));
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
