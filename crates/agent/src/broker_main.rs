#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(windows)]
mod broker_protocol;

#[cfg(windows)]
mod windows_broker {
    use std::{
        collections::{HashMap, HashSet, VecDeque},
        ffi::{OsStr, OsString},
        fs,
        io::{BufRead, BufReader, Read, Write},
        net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
        os::windows::ffi::OsStrExt,
        path::Path,
        process::Command,
        ptr,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
        thread,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    use anyhow::{Context, Result, bail};
    use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
    use serde_json::{Value, json};
    use uuid::Uuid;
    use windows_service::{
        define_windows_service,
        service::{
            ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
            ServiceType,
        },
        service_control_handler::{self, ServiceControlHandlerResult},
        service_dispatcher,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        Security::{
            CheckTokenMembership, CreateWellKnownSid, LOGON32_LOGON_INTERACTIVE,
            LOGON32_PROVIDER_DEFAULT, LogonUserW, SECURITY_MAX_SID_SIZE,
            WinBuiltinAdministratorsSid,
        },
    };
    use zeroize::Zeroizing;

    use crate::broker_protocol::{
        BROKER_MAX_FRAME_BYTES, BROKER_SERVICE_NAME, BrokerCommand, BrokerConfig, BrokerRequest,
        BrokerResponse, config_path, open, seal,
    };

    const SERVICE_TYPE: ServiceType = ServiceType::OWN_PROCESS;
    const MAX_TERMINALS: usize = 2;
    const MAX_OUTPUT_BYTES: usize = 512 * 1024;

    define_windows_service!(ffi_service_main, service_main);

    pub fn run() -> Result<()> {
        let command = std::env::args().nth(1).unwrap_or_else(|| "help".to_owned());
        match command.as_str() {
            "service" => service_dispatcher::start(BROKER_SERVICE_NAME, ffi_service_main)
                .context("failed to start the Windows service dispatcher"),
            "run-console" => serve(Arc::new(AtomicBool::new(false))),
            "install" => install(),
            "uninstall" => uninstall(),
            _ => {
                println!(
                    "Usage: aialra-kimi-elevated-broker <install|uninstall|service|run-console>"
                );
                Ok(())
            }
        }
    }

    fn service_main(_arguments: Vec<OsString>) {
        let _ = run_service();
    }

    fn run_service() -> windows_service::Result<()> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_handler = stop.clone();
        let handler = move |event| match event {
            ServiceControl::Stop => {
                stop_handler.store(true, Ordering::SeqCst);
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        };
        let status = service_control_handler::register(BROKER_SERVICE_NAME, handler)?;
        status.set_service_status(ServiceStatus {
            service_type: SERVICE_TYPE,
            current_state: ServiceState::Running,
            controls_accepted: ServiceControlAccept::STOP,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::ZERO,
            process_id: None,
        })?;
        let exit_code = if serve(stop).is_ok() { 0 } else { 1 };
        status.set_service_status(ServiceStatus {
            service_type: SERVICE_TYPE,
            current_state: ServiceState::Stopped,
            controls_accepted: ServiceControlAccept::empty(),
            exit_code: ServiceExitCode::Win32(exit_code),
            checkpoint: 0,
            wait_hint: Duration::ZERO,
            process_id: None,
        })?;
        Ok(())
    }

    fn serve(stop: Arc<AtomicBool>) -> Result<()> {
        let config = BrokerConfig::load()?;
        let key = Arc::new(config.key_bytes()?);
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, config.port))
            .context("failed to bind the elevated broker loopback port")?;
        listener.set_nonblocking(true)?;
        let state = Arc::new(Mutex::new(BrokerState::default()));
        while !stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, address)) if address.ip().is_loopback() => {
                    let state = state.clone();
                    let key = key.clone();
                    thread::spawn(move || {
                        let _ = handle_client(stream, &key, &state);
                    });
                }
                Ok((_, _)) => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(100));
                }
                Err(error) => return Err(error).context("elevated broker listener failed"),
            }
            if let Ok(mut state) = state.lock() {
                state.reap_expired();
            }
        }
        if let Ok(mut state) = state.lock() {
            state.kill_all();
        }
        Ok(())
    }

    fn handle_client(
        mut stream: TcpStream,
        key: &[u8; 32],
        state: &Arc<Mutex<BrokerState>>,
    ) -> Result<()> {
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        let mut reader = BufReader::new(stream.try_clone()?);
        let mut frame = String::new();
        reader
            .by_ref()
            .take((BROKER_MAX_FRAME_BYTES + 1) as u64)
            .read_line(&mut frame)?;
        if frame.len() > BROKER_MAX_FRAME_BYTES {
            bail!("elevated broker request exceeded the limit");
        }
        let request: BrokerRequest = open(key, frame.trim_end())?;
        let response = match handle_request(request, state) {
            Ok(response) => response,
            Err((request_id, error)) => BrokerResponse {
                request_id,
                ok: false,
                body: Value::Null,
                error: Some(error),
            },
        };
        let encoded = seal(key, &response)?;
        stream.write_all(encoded.as_bytes())?;
        stream.write_all(b"\n")?;
        stream.flush()?;
        Ok(())
    }

    fn handle_request(
        request: BrokerRequest,
        state: &Arc<Mutex<BrokerState>>,
    ) -> std::result::Result<BrokerResponse, (String, String)> {
        let request_id = request.request_id.clone();
        let result = (|| -> Result<Value> {
            validate_fresh_request(&request, state)?;
            match request.command {
                BrokerCommand::Open {
                    username,
                    password,
                    shell,
                    columns,
                    rows,
                } => open_terminal(state, username, password, shell, columns, rows),
                BrokerCommand::Input { terminal_id, data } => {
                    if data.len() > 64 * 1024 {
                        bail!("terminal input exceeded the limit");
                    }
                    let mut state = state
                        .lock()
                        .map_err(|_| anyhow::anyhow!("broker state unavailable"))?;
                    let terminal = state
                        .sessions
                        .get_mut(&terminal_id)
                        .context("terminal not found")?;
                    let mut writer = terminal
                        .writer
                        .lock()
                        .map_err(|_| anyhow::anyhow!("terminal input unavailable"))?;
                    writer.write_all(data.as_bytes())?;
                    writer.flush()?;
                    drop(writer);
                    terminal.last_activity = Instant::now();
                    Ok(json!({ "accepted": true }))
                }
                BrokerCommand::Resize {
                    terminal_id,
                    columns,
                    rows,
                } => {
                    validate_dimensions(columns, rows)?;
                    let mut state = state
                        .lock()
                        .map_err(|_| anyhow::anyhow!("broker state unavailable"))?;
                    let terminal = state
                        .sessions
                        .get_mut(&terminal_id)
                        .context("terminal not found")?;
                    terminal.master.resize(PtySize {
                        rows,
                        cols: columns,
                        pixel_width: 0,
                        pixel_height: 0,
                    })?;
                    terminal.last_activity = Instant::now();
                    Ok(json!({ "columns": columns, "rows": rows }))
                }
                BrokerCommand::Read {
                    terminal_id,
                    cursor,
                } => {
                    let mut state = state
                        .lock()
                        .map_err(|_| anyhow::anyhow!("broker state unavailable"))?;
                    let terminal = state
                        .sessions
                        .get_mut(&terminal_id)
                        .context("terminal not found")?;
                    terminal.last_activity = Instant::now();
                    let output = terminal
                        .output
                        .lock()
                        .map_err(|_| anyhow::anyhow!("terminal output unavailable"))?;
                    let effective = cursor.max(output.base_offset);
                    let start =
                        usize::try_from(effective - output.base_offset).unwrap_or(usize::MAX);
                    let data = if start < output.data.len() {
                        String::from_utf8_lossy(&output.data[start..]).into_owned()
                    } else {
                        String::new()
                    };
                    Ok(json!({
                        "data": data,
                        "cursor": output.base_offset + output.data.len() as u64,
                        "truncated": cursor < output.base_offset,
                        "exited": output.exited
                    }))
                }
                BrokerCommand::Close { terminal_id } => {
                    let mut state = state
                        .lock()
                        .map_err(|_| anyhow::anyhow!("broker state unavailable"))?;
                    let closed = state.kill(&terminal_id).is_ok();
                    Ok(json!({ "closed": closed }))
                }
            }
        })();
        match result {
            Ok(body) => Ok(BrokerResponse {
                request_id,
                ok: true,
                body,
                error: None,
            }),
            Err(_) => Err((
                request_id,
                "elevated broker request was rejected".to_owned(),
            )),
        }
    }

    fn validate_fresh_request(
        request: &BrokerRequest,
        state: &Arc<Mutex<BrokerState>>,
    ) -> Result<()> {
        let now = unix_millis();
        if now.abs_diff(request.timestamp_ms) > 30_000 {
            bail!("stale elevated broker request");
        }
        if Uuid::parse_str(&request.request_id).is_err() {
            bail!("invalid elevated broker request identity");
        }
        let mut state = state
            .lock()
            .map_err(|_| anyhow::anyhow!("broker state unavailable"))?;
        if !state.used_request_ids.insert(request.request_id.clone()) {
            bail!("replayed elevated broker request");
        }
        state.request_order.push_back(request.request_id.clone());
        while state.request_order.len() > 4096 {
            if let Some(id) = state.request_order.pop_front() {
                state.used_request_ids.remove(&id);
            }
        }
        Ok(())
    }

    fn open_terminal(
        state: &Arc<Mutex<BrokerState>>,
        username: String,
        password: Zeroizing<String>,
        shell: String,
        columns: u16,
        rows: u16,
    ) -> Result<Value> {
        validate_dimensions(columns, rows)?;
        let normalized_user = username.to_lowercase();
        {
            let mut state = state
                .lock()
                .map_err(|_| anyhow::anyhow!("broker state unavailable"))?;
            state.check_auth_rate(&normalized_user)?;
            if state.sessions.len() >= MAX_TERMINALS {
                bail!("elevated terminal limit reached");
            }
        }
        if !validate_administrator(&username, &password) {
            if let Ok(mut state) = state.lock() {
                state.record_auth_failure(normalized_user);
            }
            bail!("administrator authentication failed");
        }
        let pair = native_pty_system().openpty(PtySize {
            rows,
            cols: columns,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut command = match shell.to_ascii_lowercase().as_str() {
            "powershell" => {
                let mut command = CommandBuilder::new("powershell.exe");
                command.args(["-NoLogo", "-NoProfile"]);
                command
            }
            "cmd" => CommandBuilder::new("cmd.exe"),
            _ => bail!("unsupported elevated shell"),
        };
        command.env("TERM", "xterm-256color");
        let child = pair.slave.spawn_command(command)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer = Arc::new(Mutex::new(pair.master.take_writer()?));
        let output = Arc::new(Mutex::new(OutputBuffer::default()));
        let thread_output = output.clone();
        thread::spawn(move || {
            let mut buffer = [0_u8; 16 * 1024];
            loop {
                match std::io::Read::read(&mut reader, &mut buffer) {
                    Ok(0) | Err(_) => {
                        if let Ok(mut output) = thread_output.lock() {
                            output.exited = true;
                        }
                        break;
                    }
                    Ok(count) => {
                        if let Ok(mut output) = thread_output.lock() {
                            output.push(&buffer[..count]);
                        }
                    }
                }
            }
        });
        let id = format!("elevated_{}", Uuid::new_v4());
        let mut state = state
            .lock()
            .map_err(|_| anyhow::anyhow!("broker state unavailable"))?;
        state.auth_failures.remove(&normalized_user);
        state.sessions.insert(
            id.clone(),
            BrokerTerminal {
                opened_at: Instant::now(),
                last_activity: Instant::now(),
                master: pair.master,
                writer,
                child,
                output,
            },
        );
        Ok(json!({ "terminalId": id, "elevated": true }))
    }

    #[derive(Default)]
    struct OutputBuffer {
        base_offset: u64,
        data: Vec<u8>,
        exited: bool,
    }

    impl OutputBuffer {
        fn push(&mut self, bytes: &[u8]) {
            self.data.extend_from_slice(bytes);
            if self.data.len() > MAX_OUTPUT_BYTES {
                let overflow = self.data.len() - MAX_OUTPUT_BYTES;
                self.data.drain(..overflow);
                self.base_offset += overflow as u64;
            }
        }
    }

    struct BrokerTerminal {
        opened_at: Instant,
        last_activity: Instant,
        master: Box<dyn MasterPty + Send>,
        writer: Arc<Mutex<Box<dyn Write + Send>>>,
        child: Box<dyn Child + Send + Sync>,
        output: Arc<Mutex<OutputBuffer>>,
    }

    #[derive(Default)]
    struct BrokerState {
        sessions: HashMap<String, BrokerTerminal>,
        auth_failures: HashMap<String, VecDeque<Instant>>,
        used_request_ids: HashSet<String>,
        request_order: VecDeque<String>,
    }

    impl BrokerState {
        fn check_auth_rate(&mut self, username: &str) -> Result<()> {
            let now = Instant::now();
            let attempts = self.auth_failures.entry(username.to_owned()).or_default();
            attempts.retain(|attempt| now.duration_since(*attempt) < Duration::from_secs(60));
            if attempts.len() >= 5 {
                bail!("administrator authentication is rate limited");
            }
            Ok(())
        }

        fn record_auth_failure(&mut self, username: String) {
            self.auth_failures
                .entry(username)
                .or_default()
                .push_back(Instant::now());
        }

        fn reap_expired(&mut self) {
            let now = Instant::now();
            let ids = self
                .sessions
                .iter()
                .filter(|(_, terminal)| {
                    now.duration_since(terminal.last_activity) >= Duration::from_secs(15 * 60)
                        || now.duration_since(terminal.opened_at) >= Duration::from_secs(60 * 60)
                })
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for id in ids {
                let _ = self.kill(&id);
            }
        }

        fn kill(&mut self, terminal_id: &str) -> Result<()> {
            let mut terminal = self
                .sessions
                .remove(terminal_id)
                .context("terminal not found")?;
            let _ = terminal.child.kill();
            let _ = terminal.child.wait();
            Ok(())
        }

        fn kill_all(&mut self) {
            let ids = self.sessions.keys().cloned().collect::<Vec<_>>();
            for id in ids {
                let _ = self.kill(&id);
            }
        }
    }

    fn validate_dimensions(columns: u16, rows: u16) -> Result<()> {
        if !(2..=500).contains(&columns) || !(2..=500).contains(&rows) {
            bail!("terminal dimensions are outside the supported range");
        }
        Ok(())
    }

    fn validate_administrator(username: &str, password: &str) -> bool {
        let (domain, account) = if let Some((domain, account)) = username.split_once('\\') {
            (Some(domain), account)
        } else {
            (None, username)
        };
        let account = wide(account);
        let domain = domain.map(wide);
        let password = Zeroizing::new(wide(password));
        let mut token: HANDLE = ptr::null_mut();
        let logged_on = unsafe {
            LogonUserW(
                account.as_ptr(),
                domain.as_ref().map_or(ptr::null(), |value| value.as_ptr()),
                password.as_ptr(),
                LOGON32_LOGON_INTERACTIVE,
                LOGON32_PROVIDER_DEFAULT,
                &mut token,
            )
        };
        if logged_on == 0 || token.is_null() {
            return false;
        }
        let mut sid = [0_u8; SECURITY_MAX_SID_SIZE as usize];
        let mut sid_size = sid.len() as u32;
        let created = unsafe {
            CreateWellKnownSid(
                WinBuiltinAdministratorsSid,
                ptr::null_mut(),
                sid.as_mut_ptr().cast(),
                &mut sid_size,
            )
        };
        let mut is_member = 0;
        let checked = if created != 0 {
            unsafe { CheckTokenMembership(token, sid.as_mut_ptr().cast(), &mut is_member) }
        } else {
            0
        };
        unsafe {
            CloseHandle(token);
        }
        checked != 0 && is_member != 0
    }

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(Some(0)).collect()
    }

    fn unix_millis() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0)
    }

    fn install() -> Result<()> {
        let path = config_path()?;
        let directory = path.parent().context("invalid broker configuration path")?;
        fs::create_dir_all(directory)?;
        if !path.exists() {
            let config = BrokerConfig::generate();
            fs::write(&path, serde_json::to_vec_pretty(&config)?)?;
        }
        restrict_config_acl(directory)?;
        let executable = std::env::current_exe()?;
        let service_command = format!("\"{}\" service", executable.display());
        let exists = Command::new("sc.exe")
            .args(["query", BROKER_SERVICE_NAME])
            .output()
            .is_ok_and(|output| output.status.success());
        let verb = if exists { "config" } else { "create" };
        let mut command = Command::new("sc.exe");
        command.args([
            verb,
            BROKER_SERVICE_NAME,
            "binPath=",
            &service_command,
            "start=",
            "auto",
            "obj=",
            "LocalSystem",
        ]);
        if !command.status()?.success() {
            bail!("Windows rejected the elevated broker service installation");
        }
        let _ = Command::new("sc.exe")
            .args([
                "description",
                BROKER_SERVICE_NAME,
                "AIALRA-KIMI LocalSystem terminal broker; loopback only",
            ])
            .status();
        let status = Command::new("sc.exe")
            .args(["start", BROKER_SERVICE_NAME])
            .status()?;
        if !status.success() && !exists {
            bail!("the elevated broker was installed but did not start");
        }
        println!("Installed the AIALRA-KIMI LocalSystem elevated broker");
        Ok(())
    }

    fn uninstall() -> Result<()> {
        let _ = Command::new("sc.exe")
            .args(["stop", BROKER_SERVICE_NAME])
            .status();
        let status = Command::new("sc.exe")
            .args(["delete", BROKER_SERVICE_NAME])
            .status()?;
        if !status.success() {
            bail!("Windows rejected the elevated broker service removal");
        }
        println!("Removed the AIALRA-KIMI LocalSystem elevated broker");
        println!("The machine broker key was preserved for a recoverable reinstall");
        Ok(())
    }

    fn restrict_config_acl(directory: &Path) -> Result<()> {
        let output = Command::new("whoami.exe").args(["/user"]).output()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let sid = text
            .split_whitespace()
            .find(|part| part.starts_with("S-1-"))
            .context("failed to resolve the installing user SID")?;
        let grants = [
            "*S-1-5-18:(OI)(CI)F".to_owned(),
            "*S-1-5-32-544:(OI)(CI)F".to_owned(),
            format!("*{sid}:(OI)(CI)RX"),
        ];
        let status = Command::new("icacls.exe")
            .arg(directory)
            .arg("/inheritance:r")
            .arg("/grant:r")
            .args(grants)
            .status()?;
        if !status.success() {
            bail!("failed to restrict the elevated broker configuration ACL");
        }
        Ok(())
    }
}

#[cfg(windows)]
fn main() -> anyhow::Result<()> {
    windows_broker::run()
}

#[cfg(not(windows))]
fn main() {
    eprintln!("The AIALRA-KIMI elevated broker is only available on Windows");
}
