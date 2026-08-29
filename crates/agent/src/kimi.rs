use std::{path::PathBuf, process::Stdio, sync::OnceLock, time::Duration};

use anyhow::{Context, Result, bail};
use reqwest::{Client, Method};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::{process::Child, time::sleep};

use crate::config::AgentConfig;

#[derive(Clone, Debug)]
pub struct KimiProbe {
    pub version: String,
    pub openapi_sha256: String,
    pub asyncapi_sha256: String,
    pub login_state: String,
    pub capabilities: Vec<String>,
}

pub struct KimiHeartbeat {
    pub version: String,
    pub login_state: String,
}

pub struct KimiRuntime {
    client: KimiClient,
    _child: Option<Child>,
}

static KIMI_HOME_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

pub fn set_home_override(path: PathBuf) -> Result<()> {
    KIMI_HOME_OVERRIDE
        .set(path)
        .map_err(|_| anyhow::anyhow!("Kimi home directory was already configured"))
}

impl KimiRuntime {
    pub async fn ensure(config: &AgentConfig) -> Result<Self> {
        let base_url = format!("http://127.0.0.1:{}", config.kimi_port);
        if let Ok(client) = KimiClient::from_running(base_url.clone()).await {
            return Ok(Self {
                client,
                _child: None,
            });
        }

        let mut child = tokio::process::Command::new(&config.kimi_executable)
            .args([
                "web",
                "--no-open",
                "--host",
                "127.0.0.1",
                "--port",
                &config.kimi_port.to_string(),
                "--log-level",
                "warn",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("failed to start {}", config.kimi_executable))?;

        for _ in 0..40 {
            if let Some(status) = child.try_wait().context("failed to inspect Kimi process")? {
                bail!("Kimi server exited during startup with {status}");
            }
            if let Ok(client) = KimiClient::from_running(base_url.clone()).await {
                return Ok(Self {
                    client,
                    _child: Some(child),
                });
            }
            sleep(Duration::from_millis(250)).await;
        }
        let _ = child.kill().await;
        bail!("Kimi server did not become ready on the configured loopback port")
    }

    pub const fn client(&self) -> &KimiClient {
        &self.client
    }
}

#[derive(Clone)]
pub struct KimiClient {
    http: Client,
    base_url: String,
    token: String,
}

impl KimiClient {
    pub async fn attach(port: u16) -> Result<Self> {
        Self::from_running(format!("http://127.0.0.1:{port}")).await
    }

    async fn from_running(base_url: String) -> Result<Self> {
        let token = tokio::fs::read_to_string(kimi_token_path()?)
            .await
            .context("Kimi server token is unavailable")?;
        let client = Self {
            http: Client::builder()
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(30))
                .no_proxy()
                .build()?,
            base_url,
            token: token.trim().to_owned(),
        };
        client.request(Method::GET, "/api/v1/healthz", None).await?;
        Ok(client)
    }

    pub async fn probe(&self) -> Result<KimiProbe> {
        let (meta, auth, openapi, asyncapi) = tokio::try_join!(
            self.data(Method::GET, "/api/v1/meta", None),
            self.data(Method::GET, "/api/v1/auth", None),
            self.bytes("/openapi.json"),
            self.bytes("/asyncapi.json"),
        )?;
        let version = meta
            .get("server_version")
            .and_then(Value::as_str)
            .context("Kimi meta response omitted server_version")?
            .to_owned();
        let login_state = auth
            .pointer("/managed_provider/status")
            .and_then(Value::as_str)
            .unwrap_or("unauthenticated")
            .to_owned();
        let capabilities = meta
            .get("capabilities")
            .and_then(Value::as_object)
            .map(|values| {
                values
                    .iter()
                    .filter_map(|(name, enabled)| {
                        enabled
                            .as_bool()
                            .filter(|value| *value)
                            .map(|_| name.clone())
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(KimiProbe {
            version,
            openapi_sha256: hex_sha256(&openapi),
            asyncapi_sha256: hex_sha256(&asyncapi),
            login_state,
            capabilities,
        })
    }

    pub async fn heartbeat(&self) -> Result<KimiHeartbeat> {
        let (meta, auth) = tokio::try_join!(
            self.data(Method::GET, "/api/v1/meta", None),
            self.data(Method::GET, "/api/v1/auth", None),
        )?;
        Ok(KimiHeartbeat {
            version: meta
                .get("server_version")
                .and_then(Value::as_str)
                .context("Kimi meta response omitted server_version")?
                .to_owned(),
            login_state: auth
                .pointer("/managed_provider/status")
                .and_then(Value::as_str)
                .unwrap_or("unauthenticated")
                .to_owned(),
        })
    }

    pub fn websocket_url(&self) -> String {
        format!("ws://127.0.0.1:{}/api/v1/ws", self.port())
    }

    pub fn websocket_protocol(&self) -> String {
        format!("kimi-code.bearer.{}", self.token)
    }

    pub async fn operation(&self, host_id: &str, operation: &str, body: Value) -> Result<Value> {
        match operation {
            "meta.read" => self.data(Method::GET, "/api/v1/meta", None).await,
            "sessions.list" => self.list_sessions(host_id).await,
            "sessions.create" => self.create_session(host_id, body).await,
            "sessions.read" => {
                let id = required_path_segment(&body, "sessionId")?;
                self.data(Method::GET, &format!("/api/v1/sessions/{id}"), None)
                    .await
            }
            "sessions.archive" => self.session_action(&body, "archive").await,
            "sessions.fork" => {
                let data = self.session_action(&body, "fork").await?;
                Ok(json!({ "session": normalize_session(host_id, &data) }))
            }
            "sessions.prompt" => self.prompt(body).await,
            "sessions.interrupt" => self.session_action(&body, "abort").await,
            "sessions.snapshot" => self.snapshot(body).await,
            "sessions.events" => {
                required_path_segment(&body, "sessionId")?;
                Ok(json!({ "subscribed": true }))
            }
            "sessions.approvals.respond" => self.interaction(body, "approvals").await,
            "sessions.questions.respond" => self.interaction(body, "questions").await,
            "sessions.questions.dismiss" => self.dismiss_question(body).await,
            "sessions.tasks.list" => {
                let id = required_path_segment(&body, "sessionId")?;
                self.data(Method::GET, &format!("/api/v1/sessions/{id}/tasks"), None)
                    .await
            }
            "sessions.files.search" => self.search_files(body).await,
            "sessions.files.read" => self.read_file(body).await,
            "sessions.files.status" => self.file_status(body).await,
            "sessions.permission.read" => self.permission(body).await,
            "sessions.permission.write" => self.set_permission(body).await,
            "oauth.userinfo" => self.data(Method::GET, "/api/v1/oauth/userinfo", None).await,
            "oauth.usage" => self.usage().await,
            "oauth.device.start" => {
                self.data(Method::POST, "/api/v1/oauth/login", Some(json!({})))
                    .await
            }
            "oauth.device.poll" => self.data(Method::GET, "/api/v1/oauth/login", None).await,
            _ => bail!("operation is not allowed by the Kimi adapter"),
        }
    }

    pub async fn session_cache(&self, host_id: &str) -> Result<Vec<Value>> {
        let list = self.list_sessions(host_id).await?;
        Ok(list
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|mut item| {
                if let Some(object) = item.as_object_mut() {
                    object.remove("permissionMode");
                    object.remove("unread");
                }
                item
            })
            .collect())
    }

    async fn list_sessions(&self, host_id: &str) -> Result<Value> {
        let data = self
            .data(Method::GET, "/api/v1/sessions?exclude_empty=false", None)
            .await?;
        let sessions = data
            .get("items")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| normalize_session(host_id, item))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(json!({ "sessions": sessions }))
    }

    async fn create_session(&self, host_id: &str, body: Value) -> Result<Value> {
        let workspace = body
            .pointer("/metadata/cwd")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 4096 && !value.contains('\0'))
            .context("session workspace is required and must be at most 4096 bytes")?;
        let title = body
            .get("title")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 240);
        if body.get("title").is_some() && title.is_none() {
            bail!("session title must be between 1 and 240 bytes");
        }
        let mut payload = json!({ "metadata": { "cwd": workspace } });
        if let Some(title) = title {
            payload["title"] = json!(title);
        }
        let data = self
            .data(Method::POST, "/api/v1/sessions", Some(payload))
            .await?;
        Ok(json!({ "session": normalize_session(host_id, &data) }))
    }

    async fn snapshot(&self, body: Value) -> Result<Value> {
        let id = required_path_segment(&body, "sessionId")?;
        let snapshot_path = format!("/api/v1/sessions/{id}/snapshot");
        let status_path = format!("/api/v1/sessions/{id}/status");
        let tasks_path = format!("/api/v1/sessions/{id}/tasks");
        let (snapshot, status, tasks) = tokio::try_join!(
            self.data(Method::GET, &snapshot_path, None),
            self.data(Method::GET, &status_path, None),
            self.data(Method::GET, &tasks_path, None),
        )?;
        let messages = snapshot
            .pointer("/messages/items")
            .and_then(Value::as_array)
            .map(|items| items.iter().flat_map(normalize_message).collect::<Vec<_>>())
            .unwrap_or_default();
        let mut in_flight = snapshot
            .get("in_flight_turn")
            .cloned()
            .unwrap_or(Value::Null);
        if let Some(turn) = in_flight.as_object_mut() {
            turn.remove("thinking_text");
        }
        Ok(json!({
            "messages": messages,
            "permissionMode": status.get("permission").and_then(Value::as_str).unwrap_or("manual"),
            "asOfSeq": snapshot.get("as_of_seq"),
            "epoch": snapshot.get("epoch"),
            "pendingApprovals": snapshot.get("pending_approvals"),
            "pendingQuestions": snapshot.get("pending_questions"),
            "inFlightTurn": in_flight,
            "tasks": tasks.get("items").cloned().unwrap_or_else(|| json!([])),
            "status": {
                "busy": status.get("busy").and_then(Value::as_bool).unwrap_or(false),
                "contextTokens": status.get("context_tokens").and_then(Value::as_u64).unwrap_or(0),
                "maxContextTokens": status.get("max_context_tokens").and_then(Value::as_u64),
                "contextUsage": status.get("context_usage").and_then(Value::as_f64),
                "model": status.get("model").and_then(Value::as_str),
                "thinkingLevel": status.get("thinking_level").and_then(Value::as_str).unwrap_or("")
            }
        }))
    }

    async fn prompt(&self, mut body: Value) -> Result<Value> {
        let id = take_required_path_segment(&mut body, "sessionId")?;
        let content = body
            .get("content")
            .and_then(Value::as_array)
            .filter(|items| !items.is_empty() && items.len() <= 32)
            .context("prompt content must contain between 1 and 32 text items")?;
        let mut total_bytes = 0_usize;
        let mut text_content = Vec::with_capacity(content.len());
        for item in content {
            if item.get("type").and_then(Value::as_str) != Some("text") {
                bail!("remote prompts currently accept text content only");
            }
            let text = item
                .get("text")
                .and_then(Value::as_str)
                .context("prompt text is required")?;
            total_bytes = total_bytes.saturating_add(text.len());
            text_content.push(json!({ "type": "text", "text": text }));
        }
        if total_bytes > 512 * 1024 {
            bail!("prompt text exceeded the 512 KiB limit");
        }
        let mode = body
            .get("permissionMode")
            .and_then(Value::as_str)
            .unwrap_or("manual");
        if !matches!(mode, "manual" | "auto" | "yolo") {
            bail!("invalid permission mode");
        }
        self.data(
            Method::POST,
            &format!("/api/v1/sessions/{id}/prompts"),
            Some(json!({
                "content": text_content,
                "permission_mode": mode
            })),
        )
        .await
    }

    async fn session_action(&self, body: &Value, action: &str) -> Result<Value> {
        let id = required_path_segment(body, "sessionId")?;
        self.data(
            Method::POST,
            &format!("/api/v1/sessions/{id}:{action}"),
            Some(json!({})),
        )
        .await
    }

    async fn interaction(&self, mut body: Value, kind: &str) -> Result<Value> {
        let session = take_required_path_segment(&mut body, "sessionId")?;
        let interaction = take_required_path_segment(&mut body, "interactionId")?;
        self.data(
            Method::POST,
            &format!("/api/v1/sessions/{session}/{kind}/{interaction}"),
            Some(body),
        )
        .await
    }

    async fn dismiss_question(&self, mut body: Value) -> Result<Value> {
        let session = take_required_path_segment(&mut body, "sessionId")?;
        let interaction = take_required_path_segment(&mut body, "interactionId")?;
        self.data_accepting(
            Method::POST,
            &format!("/api/v1/sessions/{session}/questions/{interaction}:dismiss"),
            Some(json!({})),
            &[0, 40909],
        )
        .await
    }

    async fn permission(&self, body: Value) -> Result<Value> {
        let id = required_path_segment(&body, "sessionId")?;
        let status = self
            .data(Method::GET, &format!("/api/v1/sessions/{id}/status"), None)
            .await?;
        Ok(
            json!({ "permissionMode": status.get("permission").and_then(Value::as_str).unwrap_or("manual") }),
        )
    }

    async fn set_permission(&self, body: Value) -> Result<Value> {
        let id = required_path_segment(&body, "sessionId")?;
        let mode = required_string(&body, "permissionMode")?;
        if !matches!(mode, "manual" | "auto" | "yolo") {
            bail!("invalid permission mode");
        }
        self.data(
            Method::POST,
            &format!("/api/v1/sessions/{id}/profile"),
            Some(json!({ "agent_config": { "permission_mode": mode } })),
        )
        .await?;
        let actual = self.permission(json!({ "sessionId": id })).await?;
        Ok(actual)
    }

    async fn search_files(&self, body: Value) -> Result<Value> {
        let id = required_path_segment(&body, "sessionId")?;
        let query = body.get("query").and_then(Value::as_str).unwrap_or("");
        self.data(
            Method::POST,
            &format!("/api/v1/sessions/{id}/fs:search"),
            Some(json!({ "query": query })),
        )
        .await
    }

    async fn read_file(&self, body: Value) -> Result<Value> {
        let id = required_path_segment(&body, "sessionId")?;
        let path = required_string(&body, "path")?;
        let path_value = std::path::Path::new(path);
        if path_value.is_absolute()
            || path_value
                .components()
                .any(|component| component == std::path::Component::ParentDir)
        {
            bail!("file path must remain relative to the session workspace");
        }
        self.data(
            Method::POST,
            &format!("/api/v1/sessions/{id}/fs:read"),
            Some(json!({ "path": path })),
        )
        .await
    }

    async fn file_status(&self, body: Value) -> Result<Value> {
        let id = required_path_segment(&body, "sessionId")?;
        self.data(
            Method::POST,
            &format!("/api/v1/sessions/{id}/fs:git_status"),
            Some(json!({})),
        )
        .await
    }

    async fn usage(&self) -> Result<Value> {
        let (usage, user) = tokio::try_join!(
            self.data(Method::GET, "/api/v1/oauth/usage", None),
            self.data(Method::GET, "/api/v1/oauth/userinfo", None),
        )?;
        let account_label = user
            .pointer("/userInfo/email")
            .or_else(|| user.pointer("/userInfo/username"))
            .or_else(|| user.pointer("/userInfo/nickname"))
            .and_then(Value::as_str)
            .unwrap_or("Kimi account");
        if usage.get("kind").and_then(Value::as_str) == Some("error") {
            return Ok(json!({
                "accountLabel": account_label,
                "planLabel": null,
                "windows": [],
                "extraUsage": null,
                "capturedAt": now_iso_fallback(),
                "upstreamError": usage.get("message").and_then(Value::as_str).unwrap_or("Usage unavailable")
            }));
        }
        let mut rows = Vec::new();
        if let Some(summary) = usage.get("summary").filter(|value| !value.is_null()) {
            rows.push(summary.clone());
        }
        if let Some(limits) = usage.get("limits").and_then(Value::as_array) {
            rows.extend(limits.iter().cloned());
        }
        let windows = rows
            .iter()
            .map(|row| {
                let label = row
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| {
                        let duration = row.pointer("/window/duration")?.as_u64()?;
                        let unit = row.pointer("/window/unit")?.as_str()?;
                        Some(format!("{duration} {unit}"))
                    })
                    .unwrap_or_else(|| "Usage window".to_owned());
                json!({
                    "label": label,
                    "used": row.get("used").and_then(Value::as_f64).unwrap_or(0.0),
                    "limit": row.get("limit").and_then(Value::as_f64),
                    "resetAt": row.get("reset_at").and_then(Value::as_str),
                    "unit": "requests"
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "accountLabel": account_label,
            "planLabel": user.pointer("/userInfo/userLevelName").and_then(Value::as_str),
            "windows": windows,
            "extraUsage": usage.pointer("/extra_usage/monthly_used_cents").and_then(Value::as_f64),
            "capturedAt": now_iso_fallback(),
            "upstreamError": null
        }))
    }

    async fn data(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value> {
        self.data_accepting(method, path, body, &[0]).await
    }

    async fn data_accepting(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        accepted_codes: &[i64],
    ) -> Result<Value> {
        let envelope = self.request(method, path, body).await?;
        let code = envelope.get("code").and_then(Value::as_i64).unwrap_or(-1);
        if !accepted_codes.contains(&code) {
            bail!(
                "Kimi request failed with code {code}: {}",
                envelope
                    .get("msg")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error")
            );
        }
        Ok(envelope.get("data").cloned().unwrap_or(Value::Null))
    }

    async fn request(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value> {
        let mut request = self
            .http
            .request(method, format!("{}{}", self.base_url, path))
            .bearer_auth(&self.token)
            .header("x-request-id", uuid::Uuid::new_v4().to_string());
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.context("Kimi server request failed")?;
        if !response.status().is_success() {
            bail!("Kimi server returned HTTP {}", response.status());
        }
        response
            .json()
            .await
            .context("invalid Kimi server response")
    }

    async fn bytes(&self, path: &str) -> Result<Vec<u8>> {
        let response = self
            .http
            .get(format!("{}{}", self.base_url, path))
            .bearer_auth(&self.token)
            .send()
            .await?;
        if !response.status().is_success() {
            bail!("Kimi contract endpoint returned HTTP {}", response.status());
        }
        Ok(response.bytes().await?.to_vec())
    }

    fn port(&self) -> u16 {
        self.base_url
            .rsplit_once(':')
            .and_then(|(_, port)| port.parse().ok())
            .unwrap_or(58_627)
    }
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .with_context(|| format!("{key} is required"))
}

fn take_required_string(value: &mut Value, key: &str) -> Result<String> {
    value
        .as_object_mut()
        .and_then(|object| object.remove(key))
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|value| !value.is_empty())
        .with_context(|| format!("{key} is required"))
}

fn required_path_segment<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    let segment = required_string(value, key)?;
    validate_path_segment(segment, key)?;
    Ok(segment)
}

fn take_required_path_segment(value: &mut Value, key: &str) -> Result<String> {
    let segment = take_required_string(value, key)?;
    validate_path_segment(&segment, key)?;
    Ok(segment)
}

fn validate_path_segment(segment: &str, key: &str) -> Result<()> {
    if segment.len() > 512
        || !segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        || matches!(segment, "." | "..")
    {
        bail!("{key} contains characters that are unsafe in an upstream path");
    }
    Ok(())
}

fn normalize_session(host_id: &str, value: &Value) -> Value {
    let state = if value.get("busy").and_then(Value::as_bool).unwrap_or(false) {
        "running"
    } else if value.get("pending_interaction").and_then(Value::as_str) != Some("none") {
        "waiting"
    } else if value.get("last_turn_reason").and_then(Value::as_str) == Some("failed") {
        "error"
    } else {
        "idle"
    };
    let id = value.get("id").and_then(Value::as_str).unwrap_or("unknown");
    let title = value
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())
        .unwrap_or("Untitled session");
    let workspace = value
        .pointer("/metadata/cwd")
        .and_then(Value::as_str)
        .map(workspace_alias)
        .unwrap_or_else(|| "workspace".to_owned());
    json!({
        "hostId": host_id,
        "upstreamSessionId": id,
        "title": title,
        "workspaceAlias": workspace,
        "updatedAt": value.get("updated_at").and_then(Value::as_str).unwrap_or("1970-01-01T00:00:00.000Z"),
        "state": state,
        "permissionMode": "manual"
    })
}

fn normalize_message(value: &Value) -> Vec<Value> {
    let role = value
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("system");
    let message_id = value.get("id").and_then(Value::as_str).unwrap_or("unknown");
    let time = value
        .get("created_at")
        .and_then(Value::as_str)
        .unwrap_or("");
    let Some(parts) = value.get("content").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut normalized = Vec::new();
    let text = parts
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    if !text.is_empty() && matches!(role, "user" | "assistant") {
        normalized.push(json!({
            "id": message_id,
            "role": role,
            "text": text,
            "time": time
        }));
    }
    for (index, part) in parts.iter().enumerate() {
        match part.get("type").and_then(Value::as_str) {
            Some("tool_use") => normalized.push(json!({
                "id": format!("{message_id}:tool:{index}"),
                "role": "tool",
                "toolCallId": part.get("tool_call_id").and_then(Value::as_str),
                "toolName": part.get("tool_name").and_then(Value::as_str).unwrap_or("tool"),
                "text": compact_json(part.get("input")),
                "time": time
            })),
            Some("tool_result") => normalized.push(json!({
                "id": format!("{message_id}:result:{index}"),
                "role": "tool",
                "toolCallId": part.get("tool_call_id").and_then(Value::as_str),
                "toolName": "result",
                "text": compact_json(part.get("output")),
                "isError": part.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                "time": time
            })),
            _ => {}
        }
    }
    normalized
}

fn compact_json(value: Option<&Value>) -> String {
    let rendered = match value {
        Some(Value::String(value)) => value.clone(),
        Some(value) => value.to_string(),
        None => String::new(),
    };
    const LIMIT: usize = 12_000;
    if rendered.chars().count() <= LIMIT {
        rendered
    } else {
        format!("{}…", rendered.chars().take(LIMIT).collect::<String>())
    }
}

fn workspace_alias(path: &str) -> String {
    let candidate = path
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .find(|segment| !segment.is_empty())
        .unwrap_or_default();
    if candidate.is_empty() || matches!(candidate, "." | "..") || candidate.ends_with(':') {
        return "workspace".to_owned();
    }
    let alias = candidate
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect::<String>();
    if alias.is_empty() {
        "workspace".to_owned()
    } else {
        alias
    }
}

fn kimi_token_path() -> Result<PathBuf> {
    if let Some(home) = KIMI_HOME_OVERRIDE.get() {
        return Ok(home.join("server.token"));
    }
    if let Some(home) = std::env::var_os("KIMI_CODE_HOME") {
        return Ok(PathBuf::from(home).join("server.token"));
    }
    let home = directories::BaseDirs::new().context("unable to resolve the home directory")?;
    Ok(home.home_dir().join(".kimi-code").join("server.token"))
}

fn hex_sha256(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn now_iso_fallback() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_absolute_workspace_path_to_alias() {
        let session = normalize_session(
            "host-test-one",
            &json!({
                "id": "session-one",
                "title": "Test",
                "updated_at": "2026-08-29T00:00:00.000Z",
                "metadata": { "cwd": "C:\\private\\example-project" },
                "busy": false,
                "pending_interaction": "none"
            }),
        );
        assert_eq!(session["workspaceAlias"], "example-project");
        assert!(!session.to_string().contains("private"));
    }

    #[test]
    fn strips_unix_workspace_path_and_hides_roots() {
        assert_eq!(
            workspace_alias("/srv/private/example-project/"),
            "example-project"
        );
        assert_eq!(workspace_alias("/"), "workspace");
        assert_eq!(workspace_alias("C:\\"), "workspace");
    }

    #[test]
    fn rejects_parent_file_path() {
        let path = std::path::Path::new("../secret");
        assert!(
            path.components()
                .any(|part| part == std::path::Component::ParentDir)
        );
    }

    #[test]
    fn rejects_upstream_path_segment_injection() {
        assert!(validate_path_segment("session_abc-123", "sessionId").is_ok());
        assert!(validate_path_segment("../oauth/usage", "sessionId").is_err());
        assert!(validate_path_segment("session%2Fadmin", "sessionId").is_err());
    }
}
