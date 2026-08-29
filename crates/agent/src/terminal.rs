use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use rand::{RngCore, rngs::OsRng};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
use subtle::ConstantTimeEq;
use tokio::sync::mpsc;
use uuid::Uuid;
#[cfg(windows)]
use zeroize::Zeroizing;

#[cfg(windows)]
use crate::{broker_protocol::BrokerCommand, elevated_broker_client::ElevatedBrokerClient};

#[derive(Debug)]
pub struct TerminalOutput {
    pub terminal_id: String,
    pub data: String,
}

struct TerminalSession {
    id: String,
    channel_id: Option<String>,
    resume_token_hash: [u8; 32],
    detached_at: Option<Instant>,
    scrollback: String,
    elevated: bool,
    opened_at: Instant,
    last_activity: Instant,
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
}

pub struct TerminalManager {
    sessions: HashMap<String, TerminalSession>,
    #[cfg(windows)]
    broker_sessions: HashMap<String, BrokerTerminalSession>,
    output: mpsc::Sender<TerminalOutput>,
}

#[cfg(windows)]
struct BrokerTerminalSession {
    id: String,
    channel_id: String,
    broker_terminal_id: String,
    client: ElevatedBrokerClient,
    stop: Arc<AtomicBool>,
    opened_at: Instant,
    last_activity: Instant,
}

impl TerminalManager {
    pub fn new(output: mpsc::Sender<TerminalOutput>) -> Self {
        Self {
            sessions: HashMap::new(),
            #[cfg(windows)]
            broker_sessions: HashMap::new(),
            output,
        }
    }

    pub fn open(&mut self, channel_id: &str, body: &mut Value, elevated: bool) -> Result<Value> {
        #[cfg(windows)]
        if elevated {
            return self.open_windows_elevated(channel_id, body);
        }
        if self
            .sessions
            .values()
            .any(|session| session.channel_id.as_deref() == Some(channel_id))
        {
            bail!("this encrypted channel already owns a terminal");
        }
        let columns = dimension(body, "columns", 120)?;
        let rows = dimension(body, "rows", 32)?;
        let pair = native_pty_system().openpty(PtySize {
            rows,
            cols: columns,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut command = shell_command(body, elevated)?;
        command.env("TERM", "xterm-256color");
        let child = pair
            .slave
            .spawn_command(command)
            .context("failed to start terminal shell")?;
        drop(pair.slave);
        let mut reader = pair
            .master
            .try_clone_reader()
            .context("failed to attach terminal output")?;
        let writer = Arc::new(Mutex::new(
            pair.master
                .take_writer()
                .context("failed to attach terminal input")?,
        ));
        let id = format!("terminal_{}", Uuid::new_v4());
        let output = self.output.clone();
        let output_terminal = id.clone();
        thread::Builder::new()
            .name(format!("aialra-terminal-reader-{id}"))
            .spawn(move || copy_output(&mut reader, &output, &output_terminal))
            .context("failed to start terminal output reader")?;
        let mut resume_token = [0_u8; 32];
        OsRng.fill_bytes(&mut resume_token);
        let resume_token = URL_SAFE_NO_PAD.encode(resume_token);
        let resume_token_hash: [u8; 32] = Sha256::digest(resume_token.as_bytes()).into();
        self.sessions.insert(
            id.clone(),
            TerminalSession {
                id: id.clone(),
                channel_id: Some(channel_id.to_owned()),
                resume_token_hash,
                detached_at: None,
                scrollback: String::new(),
                elevated,
                opened_at: Instant::now(),
                last_activity: Instant::now(),
                master: pair.master,
                writer,
                child,
            },
        );
        Ok(json!({ "terminalId": id, "resumeToken": resume_token, "elevated": elevated }))
    }

    pub fn resume(&mut self, channel_id: &str, body: &Value) -> Result<Value> {
        if self
            .sessions
            .values()
            .any(|session| session.channel_id.as_deref() == Some(channel_id))
        {
            bail!("this encrypted channel already owns a terminal");
        }
        let terminal_id = body
            .get("terminalId")
            .and_then(Value::as_str)
            .context("terminal id is required")?;
        let resume_token = body
            .get("resumeToken")
            .and_then(Value::as_str)
            .context("terminal resume token is required")?;
        let candidate: [u8; 32] = Sha256::digest(resume_token.as_bytes()).into();
        let session = self
            .sessions
            .get_mut(terminal_id)
            .context("terminal is no longer available")?;
        if session.elevated {
            bail!("elevated terminals cannot be resumed");
        }
        if session.resume_token_hash.ct_eq(&candidate).unwrap_u8() != 1 {
            bail!("terminal resume token is invalid");
        }
        if session.channel_id.is_some() {
            bail!("terminal is already attached to another channel");
        }
        session.channel_id = Some(channel_id.to_owned());
        session.detached_at = None;
        session.last_activity = Instant::now();
        let scrollback = session.scrollback.clone();
        Ok(json!({
            "terminalId": session.id,
            "elevated": false,
            "scrollback": scrollback
        }))
    }

    pub fn input(&mut self, channel_id: &str, body: &Value) -> Result<Value> {
        let data = body
            .get("data")
            .and_then(Value::as_str)
            .context("terminal data is required")?;
        if data.len() > 64 * 1024 {
            bail!("terminal input frame is too large");
        }
        #[cfg(windows)]
        if let Some(session) = self
            .broker_sessions
            .values_mut()
            .find(|session| session.channel_id == channel_id)
        {
            let result = session.client.call(BrokerCommand::Input {
                terminal_id: session.broker_terminal_id.clone(),
                data: data.to_owned(),
            })?;
            session.last_activity = Instant::now();
            return Ok(result);
        }
        let session = self.by_channel_mut(channel_id)?;
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal input lock failed"))?;
        writer.write_all(data.as_bytes())?;
        writer.flush()?;
        drop(writer);
        session.last_activity = Instant::now();
        Ok(json!({ "accepted": true }))
    }

    pub fn resize(&mut self, channel_id: &str, body: &Value) -> Result<Value> {
        let columns = dimension(body, "columns", 120)?;
        let rows = dimension(body, "rows", 32)?;
        #[cfg(windows)]
        if let Some(session) = self
            .broker_sessions
            .values_mut()
            .find(|session| session.channel_id == channel_id)
        {
            let result = session.client.call(BrokerCommand::Resize {
                terminal_id: session.broker_terminal_id.clone(),
                columns,
                rows,
            })?;
            session.last_activity = Instant::now();
            return Ok(result);
        }
        let session = self.by_channel_mut(channel_id)?;
        session.master.resize(PtySize {
            rows,
            cols: columns,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        session.last_activity = Instant::now();
        Ok(json!({ "columns": columns, "rows": rows }))
    }

    pub fn close_channel(&mut self, channel_id: &str) -> Result<Value> {
        #[cfg(windows)]
        if let Some(id) = self
            .broker_sessions
            .values()
            .find(|session| session.channel_id == channel_id)
            .map(|session| session.id.clone())
        {
            self.kill_broker(&id);
            return Ok(json!({ "closed": true }));
        }
        let id = self
            .sessions
            .values()
            .find(|session| session.channel_id.as_deref() == Some(channel_id))
            .map(|session| session.id.clone());
        if let Some(ref id) = id {
            self.kill(id)?;
        }
        Ok(json!({ "closed": id.is_some() }))
    }

    pub fn disconnect_channel(&mut self, channel_id: &str) {
        #[cfg(windows)]
        if let Some(id) = self
            .broker_sessions
            .values()
            .find(|session| session.channel_id == channel_id)
            .map(|session| session.id.clone())
        {
            self.kill_broker(&id);
            return;
        }
        let id = self
            .sessions
            .values()
            .find(|session| session.channel_id.as_deref() == Some(channel_id))
            .map(|session| session.id.clone());
        let Some(id) = id else { return };
        let elevated = self
            .sessions
            .get(&id)
            .is_some_and(|session| session.elevated);
        if elevated {
            let _ = self.kill(&id);
        } else if let Some(session) = self.sessions.get_mut(&id) {
            session.channel_id = None;
            session.detached_at = Some(Instant::now());
        }
    }

    pub fn disconnect_all_channels(&mut self) {
        let channel_ids = self
            .sessions
            .values()
            .filter_map(|session| session.channel_id.clone())
            .collect::<Vec<_>>();
        #[cfg(windows)]
        let channel_ids = {
            let mut channel_ids = channel_ids;
            channel_ids.extend(
                self.broker_sessions
                    .values()
                    .map(|session| session.channel_id.clone()),
            );
            channel_ids
        };
        for channel_id in channel_ids {
            self.disconnect_channel(&channel_id);
        }
    }

    pub fn route_output(&mut self, output: &TerminalOutput) -> Option<String> {
        #[cfg(windows)]
        if let Some(session) = self.broker_sessions.get(&output.terminal_id) {
            return Some(session.channel_id.clone());
        }
        let session = self.sessions.get_mut(&output.terminal_id)?;
        session.scrollback.push_str(&output.data);
        const MAX_SCROLLBACK_BYTES: usize = 256 * 1024;
        if session.scrollback.len() > MAX_SCROLLBACK_BYTES {
            let overflow = session.scrollback.len() - MAX_SCROLLBACK_BYTES;
            let boundary = session.scrollback.ceil_char_boundary(overflow);
            session.scrollback.drain(..boundary);
        }
        session.channel_id.clone()
    }

    pub fn reap_expired(&mut self) {
        let now = Instant::now();
        let expired = self
            .sessions
            .values()
            .filter(|session| {
                (session.elevated
                    && (now.duration_since(session.last_activity) >= Duration::from_secs(15 * 60)
                        || now.duration_since(session.opened_at) >= Duration::from_secs(60 * 60)))
                    || (!session.elevated
                        && session.detached_at.is_some_and(|detached_at| {
                            now.duration_since(detached_at) >= Duration::from_secs(2 * 60)
                        }))
            })
            .map(|session| session.id.clone())
            .collect::<Vec<_>>();
        for id in expired {
            let _ = self.kill(&id);
        }
        #[cfg(windows)]
        {
            let expired = self
                .broker_sessions
                .values()
                .filter(|session| {
                    now.duration_since(session.last_activity) >= Duration::from_secs(15 * 60)
                        || now.duration_since(session.opened_at) >= Duration::from_secs(60 * 60)
                })
                .map(|session| session.id.clone())
                .collect::<Vec<_>>();
            for id in expired {
                self.kill_broker(&id);
            }
        }
    }

    fn by_channel_mut(&mut self, channel_id: &str) -> Result<&mut TerminalSession> {
        self.sessions
            .values_mut()
            .find(|session| session.channel_id.as_deref() == Some(channel_id))
            .context("terminal is not open for this encrypted channel")
    }

    fn kill(&mut self, terminal_id: &str) -> Result<()> {
        if let Some(mut session) = self.sessions.remove(terminal_id) {
            session
                .child
                .kill()
                .context("failed to terminate terminal process")?;
            let _ = session.child.wait();
        }
        Ok(())
    }

    #[cfg(windows)]
    fn open_windows_elevated(&mut self, channel_id: &str, body: &mut Value) -> Result<Value> {
        if self
            .broker_sessions
            .values()
            .any(|session| session.channel_id == channel_id)
        {
            bail!("this encrypted channel already owns an elevated terminal");
        }
        let object = body
            .as_object_mut()
            .context("elevated terminal request must be an object")?;
        let username = object
            .remove("username")
            .and_then(|value| value.as_str().map(str::to_owned))
            .filter(|value| !value.is_empty())
            .context("administrator username is required")?;
        let password = object
            .remove("password")
            .and_then(|value| value.as_str().map(str::to_owned))
            .map(Zeroizing::new)
            .context("administrator password is required")?;
        let shell = object
            .get("shell")
            .and_then(Value::as_str)
            .unwrap_or("powershell")
            .to_owned();
        let columns = dimension(body, "columns", 120)?;
        let rows = dimension(body, "rows", 32)?;
        let client = ElevatedBrokerClient::load()?;
        let response = client.call(BrokerCommand::Open {
            username,
            password,
            shell,
            columns,
            rows,
        })?;
        let broker_terminal_id = response
            .get("terminalId")
            .and_then(Value::as_str)
            .context("elevated broker omitted the terminal identity")?
            .to_owned();
        let id = format!("terminal_{}", Uuid::new_v4());
        let stop = Arc::new(AtomicBool::new(false));
        let poll_stop = stop.clone();
        let poll_client = client.clone();
        let poll_broker_id = broker_terminal_id.clone();
        let poll_terminal_id = id.clone();
        let output = self.output.clone();
        thread::Builder::new()
            .name(format!("aialra-broker-terminal-reader-{id}"))
            .spawn(move || {
                let mut cursor = 0_u64;
                while !poll_stop.load(Ordering::SeqCst) {
                    let response = poll_client.call(BrokerCommand::Read {
                        terminal_id: poll_broker_id.clone(),
                        cursor,
                    });
                    match response {
                        Ok(response) => {
                            cursor = response
                                .get("cursor")
                                .and_then(Value::as_u64)
                                .unwrap_or(cursor);
                            if let Some(data) = response.get("data").and_then(Value::as_str)
                                && !data.is_empty()
                                && output
                                    .blocking_send(TerminalOutput {
                                        terminal_id: poll_terminal_id.clone(),
                                        data: data.to_owned(),
                                    })
                                    .is_err()
                            {
                                break;
                            }
                            if response.get("exited").and_then(Value::as_bool) == Some(true) {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                    thread::sleep(Duration::from_millis(100));
                }
            })?;
        self.broker_sessions.insert(
            id.clone(),
            BrokerTerminalSession {
                id: id.clone(),
                channel_id: channel_id.to_owned(),
                broker_terminal_id,
                client,
                stop,
                opened_at: Instant::now(),
                last_activity: Instant::now(),
            },
        );
        Ok(json!({ "terminalId": id, "elevated": true }))
    }

    #[cfg(windows)]
    fn kill_broker(&mut self, terminal_id: &str) {
        if let Some(session) = self.broker_sessions.remove(terminal_id) {
            session.stop.store(true, Ordering::SeqCst);
            let _ = session.client.call(BrokerCommand::Close {
                terminal_id: session.broker_terminal_id,
            });
        }
    }
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        for (_, mut session) in self.sessions.drain() {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
        #[cfg(windows)]
        {
            let ids = self.broker_sessions.keys().cloned().collect::<Vec<_>>();
            for id in ids {
                self.kill_broker(&id);
            }
        }
    }
}

fn shell_command(body: &Value, elevated: bool) -> Result<CommandBuilder> {
    #[cfg(windows)]
    {
        if elevated {
            bail!("Windows elevation requires the separately installed LocalSystem broker");
        }
        let shell = body
            .get("shell")
            .and_then(Value::as_str)
            .unwrap_or("powershell");
        match shell.to_ascii_lowercase().as_str() {
            "powershell" => {
                let mut command = CommandBuilder::new("powershell.exe");
                command.args(["-NoLogo", "-NoProfile"]);
                Ok(command)
            }
            "cmd" => Ok(CommandBuilder::new("cmd.exe")),
            _ => bail!("unsupported Windows shell"),
        }
    }
    #[cfg(unix)]
    {
        let _ = body;
        if elevated {
            let mut command = CommandBuilder::new("sudo");
            command.args(["-k", "-i"]);
            return Ok(command);
        }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned());
        Ok(CommandBuilder::new(shell))
    }
}

fn dimension(body: &Value, key: &str, fallback: u16) -> Result<u16> {
    let value = body
        .get(key)
        .and_then(Value::as_u64)
        .unwrap_or(u64::from(fallback));
    if !(2..=500).contains(&value) {
        bail!("terminal {key} is outside the supported range");
    }
    Ok(value as u16)
}

fn copy_output(reader: &mut dyn Read, output: &mpsc::Sender<TerminalOutput>, terminal_id: &str) {
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                if output
                    .blocking_send(TerminalOutput {
                        terminal_id: terminal_id.to_owned(),
                        data: String::from_utf8_lossy(&buffer[..count]).into_owned(),
                    })
                    .is_err()
                {
                    break;
                }
            }
        }
    }
}
