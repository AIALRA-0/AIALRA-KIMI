use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::Signer;
use futures_util::{SinkExt, StreamExt};
use rand::{RngCore, rngs::OsRng};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::task::{JoinHandle, JoinSet};
use tokio::{
    sync::{Mutex, mpsc, watch},
    time::{MissedTickBehavior, timeout},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};
use url::Url;
use uuid::Uuid;

#[cfg(windows)]
use crate::elevated_broker_client::ElevatedBrokerClient;

use crate::{
    config::{AgentConfig, HostMode, validate_server_url},
    crypto::{EncryptedFrame, SecureChannel},
    events::{KimiEventController, start as start_kimi_events},
    identity::{HostIdentity, verifying_key_from_pem},
    kimi::{KimiClient, KimiHeartbeat, KimiProbe, KimiRuntime},
    terminal::{TerminalManager, TerminalOutput},
};

const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_RELAY_MESSAGE_BYTES: usize = 12 * 1024 * 1024;
const MAX_ACTIVE_CHANNELS: usize = 16;
const MAX_RELAY_SILENCE: Duration = Duration::from_secs(45);

struct AbortOnDrop<T>(JoinHandle<T>);

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub async fn enroll(
    server_url: Url,
    code: String,
    display_name: String,
    mode: HostMode,
    kimi_executable: String,
    kimi_port: u16,
) -> Result<()> {
    validate_server_url(&server_url)?;
    if crate::config::config_path()?.exists() || crate::config::identity_path()?.exists() {
        bail!("this device is already enrolled; revoke it before explicit re-enrollment");
    }
    let identity = HostIdentity::generate();
    let (mut socket, _) = connect_async(agent_websocket_url(&server_url)?.as_str())
        .await
        .context("failed to connect to the control plane")?;
    let request_id = Uuid::new_v4().to_string();
    socket
        .send(Message::Text(
            json!({
                "type": "agent.enroll",
                "requestId": request_id,
                "code": code,
                "publicKey": identity.public_key_pem(),
                "displayName": display_name,
                "mode": mode.to_string(),
                "platform": platform_name(),
                "agentVersion": AGENT_VERSION
            })
            .to_string()
            .into(),
        ))
        .await?;
    while let Some(message) = socket.next().await {
        let message = message?;
        let Message::Text(text) = message else {
            continue;
        };
        let value: Value = serde_json::from_str(&text)?;
        if value.get("type").and_then(Value::as_str) == Some("server.enrolled") {
            let host_id = value
                .get("hostId")
                .and_then(Value::as_str)
                .context("enrollment response omitted host identity")?;
            let verification_key = value
                .get("grantVerificationKey")
                .and_then(Value::as_str)
                .context("enrollment response omitted the grant verification key")?;
            verifying_key_from_pem(verification_key)?;
            identity.save()?;
            AgentConfig {
                server_url,
                host_id: host_id.to_owned(),
                display_name,
                mode,
                grant_verification_key: verification_key.to_owned(),
                kimi_executable,
                kimi_port,
            }
            .save()?;
            info!(host_id, "agent enrollment completed");
            return Ok(());
        }
        if value.get("type").and_then(Value::as_str) == Some("agent.error") {
            bail!("control plane rejected enrollment");
        }
    }
    bail!("control plane closed the enrollment connection")
}

pub async fn run_forever(config: AgentConfig, identity: HostIdentity) -> Result<()> {
    let (terminal_tx, mut terminal_rx) = mpsc::channel::<TerminalOutput>(256);
    let terminals = Arc::new(Mutex::new(TerminalManager::new(terminal_tx)));
    let mut runtime_backoff = Duration::from_secs(1);
    loop {
        match KimiRuntime::ensure(&config).await {
            Ok(runtime) => {
                runtime_backoff = Duration::from_secs(1);
                let kimi = runtime.client().clone();
                let mut relay_backoff = Duration::from_secs(1);
                loop {
                    let probe = match kimi.probe().await {
                        Ok(probe) => probe,
                        Err(error) => {
                            warn!(error = %error, "Kimi server is degraded and will be restarted");
                            break;
                        }
                    };
                    match run_connection(
                        &config,
                        &identity,
                        &kimi,
                        probe,
                        Arc::clone(&terminals),
                        &mut terminal_rx,
                    )
                    .await
                    {
                        Ok(()) => relay_backoff = Duration::from_secs(1),
                        Err(error) => warn!(error = %error, "relay connection ended"),
                    }
                    {
                        let mut terminals = terminals.lock().await;
                        terminals.disconnect_all_channels();
                        terminals.reap_expired();
                    }
                    tokio::time::sleep(relay_backoff).await;
                    relay_backoff = (relay_backoff * 2).min(Duration::from_secs(30));
                }
            }
            Err(error) => warn!(error = %error, "Kimi server could not be started"),
        }
        {
            let mut terminals = terminals.lock().await;
            terminals.disconnect_all_channels();
            terminals.reap_expired();
        }
        tokio::time::sleep(runtime_backoff).await;
        runtime_backoff = (runtime_backoff * 2).min(Duration::from_secs(30));
    }
}

async fn run_connection(
    config: &AgentConfig,
    identity: &HostIdentity,
    kimi: &KimiClient,
    probe: KimiProbe,
    terminals: Arc<Mutex<TerminalManager>>,
    terminal_rx: &mut mpsc::Receiver<TerminalOutput>,
) -> Result<()> {
    let (socket, _) = connect_async(agent_websocket_url(&config.server_url)?.as_str())
        .await
        .context("failed to connect to the relay")?;
    let (mut websocket_sink, mut websocket_stream) = socket.split();
    let (outgoing_tx, mut outgoing_rx) = mpsc::channel::<Value>(256);
    let mut writer = AbortOnDrop(tokio::spawn(async move {
        while let Some(value) = outgoing_rx.recv().await {
            websocket_sink
                .send(Message::Text(value.to_string().into()))
                .await
                .context("failed to write relay frame")?;
        }
        Ok::<_, anyhow::Error>(())
    }));

    outgoing_tx
        .send(agent_hello(config, identity, &probe)?)
        .await?;
    let (event_controller, mut kimi_event_rx, event_task) = start_kimi_events(kimi.clone());
    let _event_task = AbortOnDrop(event_task);
    let channels = Arc::new(Mutex::new(HashMap::<String, SecureChannel>::new()));
    let mut browser_tasks = JoinSet::new();
    let grant_verification_key = verifying_key_from_pem(&config.grant_verification_key)?;
    let mut heartbeat_watchdog = tokio::time::interval(Duration::from_secs(5));
    heartbeat_watchdog.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut authenticated = false;
    let mut compatible = false;
    let mut last_relay_activity = Instant::now();
    let (heartbeat_state_tx, heartbeat_state_rx) = watch::channel(false);
    let (heartbeat_tx, mut heartbeat_rx) = mpsc::channel::<Result<KimiHeartbeat, String>>(4);
    let heartbeat_client = kimi.clone();
    let _heartbeat_task = AbortOnDrop(tokio::spawn(async move {
        let mut heartbeat_state_rx = heartbeat_state_rx;
        let mut interval = tokio::time::interval(Duration::from_secs(20));
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            if !*heartbeat_state_rx.borrow() {
                if heartbeat_state_rx.changed().await.is_err() {
                    break;
                }
                continue;
            }
            interval.tick().await;
            let result = match timeout(Duration::from_secs(10), heartbeat_client.heartbeat()).await
            {
                Ok(Ok(status)) => Ok(status),
                Ok(Err(error)) => Err(error.to_string()),
                Err(_) => Err("Kimi heartbeat timed out".to_owned()),
            };
            if heartbeat_tx.send(result).await.is_err() {
                break;
            }
        }
    }));
    let (cache_state_tx, mut cache_state_rx) = watch::channel(false);
    let cache_outgoing = outgoing_tx.clone();
    let cache_config = config.clone();
    let cache_kimi = kimi.clone();
    let _cache_task = AbortOnDrop(tokio::spawn(async move {
        loop {
            if !*cache_state_rx.borrow() {
                if cache_state_rx.changed().await.is_err() {
                    break;
                }
                continue;
            }
            if let Err(error) =
                send_session_cache(&cache_outgoing, &cache_config, &cache_kimi).await
            {
                warn!(error = %error, "failed to refresh the redacted session cache");
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    }));

    loop {
        tokio::select! {
            writer_result = &mut writer.0 => {
                writer_result.context("relay writer task failed")??;
                bail!("relay writer ended unexpectedly");
            }
            inbound = websocket_stream.next() => {
                let Some(inbound) = inbound else { break };
                let message = inbound?;
                last_relay_activity = Instant::now();
                match message {
                    Message::Text(text) => {
                        if text.len() > MAX_RELAY_MESSAGE_BYTES {
                            bail!("relay frame exceeded the local limit");
                        }
                        let value: Value = serde_json::from_str(&text).context("invalid relay JSON")?;
                        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
                        match kind {
                            "server.hello" => {
                                authenticated = true;
                                let _ = heartbeat_state_tx.send(true);
                                compatible = value.get("compatible").and_then(Value::as_bool) == Some(true);
                                if compatible {
                                    info!(host_id = %config.host_id, "agent relay authenticated");
                                    let _ = cache_state_tx.send(true);
                                } else {
                                    warn!(host_id = %config.host_id, "Kimi protocol is unsupported; control operations remain blocked");
                                }
                            }
                            "browser.channel.open" if authenticated && compatible => {
                                let channel_id = string(&value, "channelId")?;
                                let channel_capacity = {
                                    let channels = channels.lock().await;
                                    channel_capacity_allows(channels.len(), channels.contains_key(channel_id))
                                };
                                if !channel_capacity {
                                    outgoing_tx.send(json!({
                                        "type": "agent.error",
                                        "requestId": value.get("requestId"),
                                        "hostId": config.host_id,
                                        "channelId": channel_id,
                                        "code": "channel_limit_reached",
                                        "message": "encrypted channel limit was reached"
                                    })).await?;
                                    continue;
                                }
                                let channel_kind = string(&value, "channel")?;
                                let subject = string(&value, "subject")?;
                                let accepted = SecureChannel::accept(
                                    channel_id.to_owned(),
                                    channel_kind.to_owned(),
                                    config.host_id.clone(),
                                    subject.to_owned(),
                                    string(&value, "browserEphemeralKey")?,
                                    string(&value, "grant")?.to_owned(),
                                    &grant_verification_key,
                                    identity.signing_key(),
                                );
                                let Ok(accepted) = accepted else {
                                    outgoing_tx.send(json!({
                                        "type": "agent.error",
                                        "requestId": value.get("requestId"),
                                        "hostId": config.host_id,
                                        "channelId": channel_id,
                                        "code": "channel_rejected",
                                        "message": "encrypted channel setup was rejected"
                                    })).await?;
                                    continue;
                                };
                                outgoing_tx.send(json!({
                                    "type": "agent.channel.accept",
                                    "requestId": value.get("requestId"),
                                    "hostId": config.host_id,
                                    "channelId": channel_id,
                                    "agentEphemeralKey": accepted.agent_ephemeral_key,
                                    "signature": accepted.signature
                                })).await?;
                                channels
                                    .lock()
                                    .await
                                    .insert(channel_id.to_owned(), accepted.channel);
                            }
                            "browser.frame" if authenticated && compatible => {
                                match prepare_browser_frame(&value, &channels).await {
                                    Ok(prepared) => {
                                        let config = config.clone();
                                        let kimi = kimi.clone();
                                        let channels = Arc::clone(&channels);
                                        let terminals = Arc::clone(&terminals);
                                        let events = event_controller.clone();
                                        let outgoing = outgoing_tx.clone();
                                        browser_tasks.spawn(async move {
                                            handle_browser_request(
                                                prepared,
                                                &config,
                                                &kimi,
                                                channels,
                                                terminals,
                                                &events,
                                                &outgoing,
                                            )
                                            .await;
                                        });
                                    }
                                    Err(error) => {
                                        warn!(error = %error, "rejected an encrypted browser frame");
                                        if let Some(channel_id) = value
                                            .pointer("/frame/channelId")
                                            .and_then(Value::as_str)
                                        {
                                            terminals.lock().await.disconnect_channel(channel_id);
                                            let _ = event_controller
                                                .unsubscribe_channel(channel_id.to_owned())
                                                .await;
                                            channels.lock().await.remove(channel_id);
                                        }
                                        outgoing_tx.send(json!({
                                            "type": "agent.error",
                                            "requestId": Value::Null,
                                            "hostId": config.host_id,
                                            "channelId": frame_channel_id(&value),
                                            "code": "channel_frame_rejected",
                                            "message": "encrypted channel frame was rejected"
                                        })).await?;
                                    }
                                }
                            }
                            "browser.channel.close" if authenticated && compatible => {
                                let channel_id = string(&value, "channelId")?;
                                terminals.lock().await.disconnect_channel(channel_id);
                                let _ = event_controller.unsubscribe_channel(channel_id.to_owned()).await;
                                channels.lock().await.remove(channel_id);
                            }
                            "server.heartbeat" => {}
                            "server.error" => warn!(code = ?value.get("code"), "control plane reported a relay error"),
                            _ => {}
                        }
                    }
                    Message::Ping(data) => outgoing_tx.send(json!({ "type": "agent.transport.pong", "size": data.len() })).await?,
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            output = terminal_rx.recv() => {
                if let Some(output) = output {
                    let (channel_id, exited) = {
                        let mut terminals = terminals.lock().await;
                        let channel_id = terminals.route_output(&output);
                        if output.exited {
                            terminals.finish(&output.terminal_id);
                        }
                        (channel_id, output.exited)
                    };
                    if let Some(channel_id) = channel_id {
                        let frames = {
                            let mut channels = channels.lock().await;
                            let Some(channel) = channels.get_mut(&channel_id) else {
                                continue;
                            };
                            let mut frames = Vec::with_capacity(2);
                            if !output.data.is_empty() {
                                frames.push(channel.encrypt(&json!({ "event": {
                                    "type": "terminal.output",
                                    "terminalId": output.terminal_id,
                                    "data": output.data
                                }}))?);
                            }
                            if exited {
                                frames.push(channel.encrypt(&json!({ "event": {
                                    "type": "terminal.exit",
                                    "terminalId": output.terminal_id,
                                    "reason": output.exit_reason.unwrap_or_else(|| "process_exited".to_owned()),
                                    "exitCode": output.exit_code
                                }}))?);
                            }
                            frames
                        };
                        for frame in frames {
                            outgoing_tx.send(json!({ "type": "agent.frame", "hostId": config.host_id, "frame": frame })).await?;
                        }
                    }
                }
            }
            event = kimi_event_rx.recv() => {
                if let Some(event) = event {
                    let frame = channels
                        .lock()
                        .await
                        .get_mut(&event.channel_id)
                        .map(|channel| channel.encrypt(&json!({ "event": event.value })))
                        .transpose()?;
                    if let Some(frame) = frame {
                        outgoing_tx.send(json!({ "type": "agent.frame", "hostId": config.host_id, "frame": frame })).await?;
                    }
                }
            }
            heartbeat_result = heartbeat_rx.recv() => {
                let Some(result) = heartbeat_result else {
                    bail!("Kimi heartbeat worker ended unexpectedly");
                };
                terminals.lock().await.reap_expired();
                match result {
                    Ok(status) => {
                        outgoing_tx.send(json!({
                            "type": "agent.heartbeat",
                            "hostId": config.host_id,
                            "sequence": unix_millis(),
                            "state": "online",
                            "kimiVersion": status.version,
                            "loginState": normalize_login_state(&status.login_state)
                        })).await?;
                    }
                    Err(error) => {
                        outgoing_tx.send(json!({
                            "type": "agent.heartbeat",
                            "hostId": config.host_id,
                            "sequence": unix_millis(),
                            "state": "degraded",
                            "kimiVersion": probe.version,
                            "loginState": "unknown"
                        })).await?;
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        bail!("Kimi heartbeat failed: {error}");
                    }
                }
            }
            _ = heartbeat_watchdog.tick() => {
                if authenticated && relay_silence_exceeded(last_relay_activity.elapsed()) {
                    bail!("relay heartbeat acknowledgement timed out");
                }
            }
            browser_task = browser_tasks.join_next(), if !browser_tasks.is_empty() => {
                if let Some(Err(error)) = browser_task {
                    warn!(error = %error, "browser operation worker failed");
                }
            }
        }
    }
    drop(outgoing_tx);
    Ok(())
}

fn relay_silence_exceeded(elapsed: Duration) -> bool {
    elapsed > MAX_RELAY_SILENCE
}

struct PreparedBrowserRequest {
    channel_id: String,
    request: Value,
}

async fn prepare_browser_frame(
    envelope: &Value,
    channels: &Arc<Mutex<HashMap<String, SecureChannel>>>,
) -> Result<PreparedBrowserRequest> {
    let frame: EncryptedFrame = serde_json::from_value(
        envelope
            .get("frame")
            .cloned()
            .context("relay frame omitted ciphertext")?,
    )?;
    let mut channels = channels.lock().await;
    let channel = channels
        .get_mut(&frame.channel_id)
        .context("unknown encrypted channel")?;
    if envelope.get("grant").and_then(Value::as_str) != Some(channel.grant_token.as_str()) {
        bail!("encrypted channel grant changed after opening");
    }
    let request = channel.decrypt(&frame)?;
    let operation = string(&request, "operation")?;
    if !channel.allows(operation) {
        bail!("operation is outside the capability grant");
    }
    Ok(PreparedBrowserRequest {
        channel_id: frame.channel_id,
        request,
    })
}

fn frame_channel_id(value: &Value) -> Value {
    value
        .pointer("/frame/channelId")
        .and_then(Value::as_str)
        .filter(|channel_id| Uuid::parse_str(channel_id).is_ok())
        .map(|channel_id| Value::String(channel_id.to_owned()))
        .unwrap_or(Value::Null)
}

async fn handle_browser_request(
    prepared: PreparedBrowserRequest,
    config: &AgentConfig,
    kimi: &KimiClient,
    channels: Arc<Mutex<HashMap<String, SecureChannel>>>,
    terminals: Arc<Mutex<TerminalManager>>,
    events: &KimiEventController,
    outgoing: &mpsc::Sender<Value>,
) {
    let channel_id = prepared.channel_id.clone();
    if let Err(error) = process_browser_request(
        prepared,
        config,
        kimi,
        channels.clone(),
        terminals.clone(),
        events,
        outgoing,
    )
    .await
    {
        warn!(error = %error, "rejected an encrypted browser frame");
        terminals.lock().await.disconnect_channel(&channel_id);
        let _ = events.unsubscribe_channel(channel_id.clone()).await;
        channels.lock().await.remove(&channel_id);
        let _ = outgoing
            .send(json!({
                "type": "agent.error",
                "requestId": Value::Null,
                "hostId": config.host_id,
                "channelId": channel_id,
                "code": "channel_frame_rejected",
                "message": "encrypted channel frame was rejected"
            }))
            .await;
    }
}

async fn process_browser_request(
    prepared: PreparedBrowserRequest,
    config: &AgentConfig,
    kimi: &KimiClient,
    channels: Arc<Mutex<HashMap<String, SecureChannel>>>,
    terminals: Arc<Mutex<TerminalManager>>,
    events: &KimiEventController,
    outgoing: &mpsc::Sender<Value>,
) -> Result<()> {
    let PreparedBrowserRequest {
        channel_id,
        mut request,
    } = prepared;
    let request_id = string(&request, "requestId")?.to_owned();
    let operation = string(&request, "operation")?.to_owned();
    let mut body = request
        .as_object_mut()
        .and_then(|object| object.remove("body"))
        .unwrap_or_else(|| json!({}));
    let subscribe_session = body
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if audited_operation(&operation) {
        outgoing
            .send(json!({
                "type": "agent.audit",
                "hostId": config.host_id,
                "channelId": channel_id,
                "requestId": request_id,
                "category": operation,
                "outcome": "started",
                "occurredAt": now_rfc3339()
            }))
            .await?;
    }
    let result = match operation.as_str() {
        "terminal.open" => terminals.lock().await.open(&channel_id, &mut body, false),
        "terminal.resume" => terminals.lock().await.resume(&channel_id, &body),
        "terminal.elevate.open" => terminals.lock().await.open(&channel_id, &mut body, true),
        "terminal.input" | "terminal.elevate.input" => {
            terminals.lock().await.input(&channel_id, &body)
        }
        "terminal.resize" => terminals.lock().await.resize(&channel_id, &body),
        "terminal.close" => terminals.lock().await.close_channel(&channel_id),
        _ => kimi.operation(&config.host_id, &operation, body).await,
    };
    let succeeded = result.is_ok();
    let subscription = if result.is_ok()
        && matches!(
            operation.as_str(),
            "sessions.snapshot"
                | "sessions.events"
                | "sessions.transcript.read"
                | "sessions.transcript.resume"
                | "sessions.transcript.subscribe"
        )
        && let Some(session_id) = subscribe_session
    {
        let sequence = if matches!(operation.as_str(), "sessions.snapshot" | "sessions.events") {
            result
                .as_ref()
                .ok()
                .and_then(|value| value.get("asOfSeq"))
                .and_then(Value::as_u64)
        } else {
            None
        };
        let transcript_sequence = if matches!(operation.as_str(), "sessions.transcript.read") {
            result
                .as_ref()
                .ok()
                .and_then(|value| value.get("seq"))
                .and_then(Value::as_u64)
        } else if matches!(operation.as_str(), "sessions.transcript.resume") {
            result
                .as_ref()
                .ok()
                .and_then(|value| value.get("latest_seq"))
                .and_then(Value::as_u64)
        } else {
            None
        };
        let epoch = result
            .as_ref()
            .ok()
            .and_then(|value| value.get("epoch"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        Some((session_id, sequence, epoch, transcript_sequence))
    } else {
        None
    };
    let response = match result {
        Ok(body) => json!({ "requestId": request_id, "ok": true, "body": body }),
        Err(error) => json!({ "requestId": request_id, "ok": false, "error": error.to_string() }),
    };
    let encrypted = channels
        .lock()
        .await
        .get_mut(&channel_id)
        .context("encrypted channel closed during operation")?
        .encrypt(&response)?;
    outgoing
        .send(json!({ "type": "agent.frame", "hostId": config.host_id, "frame": encrypted }))
        .await?;
    if audited_operation(&operation) {
        outgoing
            .send(json!({
                "type": "agent.audit",
                "hostId": config.host_id,
                "channelId": channel_id,
                "requestId": request_id,
                "category": operation,
                "outcome": if succeeded { "succeeded" } else { "failed" },
                "occurredAt": now_rfc3339()
            }))
            .await?;
    }
    if let Some((session_id, sequence, epoch, transcript_sequence)) = subscription {
        events
            .subscribe(channel_id, session_id, sequence, epoch, transcript_sequence)
            .await?;
    }
    Ok(())
}

fn audited_operation(operation: &str) -> bool {
    matches!(
        operation,
        "sessions.create"
            | "sessions.archive"
            | "sessions.restore"
            | "sessions.fork"
            | "sessions.prompt"
            | "sessions.prompts.steer"
            | "sessions.prompts.abort"
            | "sessions.interrupt"
            | "sessions.approvals.respond"
            | "sessions.questions.respond"
            | "sessions.questions.dismiss"
            | "sessions.permission.write"
            | "workspaces.ensure"
            | "oauth.device.start"
            | "terminal.open"
            | "terminal.close"
            | "terminal.elevate.open"
    )
}

const fn channel_capacity_allows(active: usize, duplicate: bool) -> bool {
    !duplicate && active < MAX_ACTIVE_CHANNELS
}

async fn send_session_cache(
    outgoing: &mpsc::Sender<Value>,
    config: &AgentConfig,
    kimi: &KimiClient,
) -> Result<()> {
    let sessions = kimi.session_cache(&config.host_id).await?;
    outgoing
        .send(json!({
            "type": "agent.session-cache",
            "hostId": config.host_id,
            "generatedAt": now_rfc3339(),
            "sessions": sessions
        }))
        .await?;
    Ok(())
}

fn agent_hello(config: &AgentConfig, identity: &HostIdentity, probe: &KimiProbe) -> Result<Value> {
    let timestamp = unix_millis();
    let mut nonce = [0_u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let nonce = URL_SAFE_NO_PAD.encode(nonce);
    let mut capabilities = probe.capabilities.clone();
    capabilities.extend(
        ["sessions", "terminal", "usage", "files"]
            .into_iter()
            .map(str::to_owned),
    );
    if elevation_available() {
        capabilities.push("elevation".to_owned());
    }
    capabilities.sort();
    capabilities.dedup();
    let capability_claim = capabilities.join(",");
    let canonical = [
        config.host_id.clone(),
        timestamp.to_string(),
        nonce.clone(),
        AGENT_VERSION.to_owned(),
        probe.version.clone(),
        probe.openapi_sha256.clone(),
        probe.asyncapi_sha256.clone(),
        capability_claim,
    ]
    .join("\n");
    let signature =
        URL_SAFE_NO_PAD.encode(identity.signing_key().sign(canonical.as_bytes()).to_bytes());
    Ok(json!({
        "type": "agent.hello",
        "requestId": Uuid::new_v4(),
        "hostId": config.host_id,
        "timestamp": timestamp,
        "nonce": nonce,
        "signature": signature,
        "agentVersion": AGENT_VERSION,
        "kimiVersion": probe.version,
        "openapiSha256": probe.openapi_sha256,
        "asyncapiSha256": probe.asyncapi_sha256,
        "capabilities": capabilities
    }))
}

#[cfg(windows)]
fn elevation_available() -> bool {
    ElevatedBrokerClient::is_available()
}

#[cfg(unix)]
fn elevation_available() -> bool {
    use std::process::{Command, Stdio};

    Command::new("sudo")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(not(any(windows, unix)))]
const fn elevation_available() -> bool {
    false
}

fn agent_websocket_url(server: &Url) -> Result<Url> {
    let mut url = server.clone();
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        _ => bail!("unsupported control-plane URL scheme"),
    };
    url.set_scheme(scheme)
        .map_err(|_| anyhow::anyhow!("invalid relay scheme"))?;
    url.set_path("/ws/v1/agent");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .with_context(|| format!("relay message omitted {key}"))
}

const fn platform_name() -> &'static str {
    if cfg!(windows) { "windows" } else { "linux" }
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

fn normalize_login_state(value: &str) -> &str {
    match value {
        "authenticated" => "authenticated",
        "unauthenticated" | "expired" | "revoked" => "unauthenticated",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_secure_agent_url() {
        assert_eq!(
            agent_websocket_url(&Url::parse("https://example.invalid/base").unwrap())
                .unwrap()
                .as_str(),
            "wss://example.invalid/ws/v1/agent"
        );
    }

    #[test]
    fn bounds_active_encrypted_channels() {
        assert!(channel_capacity_allows(0, false));
        assert!(channel_capacity_allows(MAX_ACTIVE_CHANNELS - 1, false));
        assert!(!channel_capacity_allows(MAX_ACTIVE_CHANNELS, false));
        assert!(!channel_capacity_allows(0, true));
    }

    #[test]
    fn expires_a_zombie_relay_connection() {
        assert!(!relay_silence_exceeded(Duration::from_secs(45)));
        assert!(relay_silence_exceeded(Duration::from_secs(46)));
    }
}
