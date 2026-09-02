use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{sync::mpsc, task::JoinHandle};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        http::{HeaderValue, header::SEC_WEBSOCKET_PROTOCOL},
    },
};
use tracing::warn;
use uuid::Uuid;

use crate::kimi::KimiClient;

#[derive(Clone)]
pub struct KimiEventController {
    commands: mpsc::Sender<EventCommand>,
}

pub struct KimiEvent {
    pub channel_id: String,
    pub value: Value,
}

enum EventCommand {
    Subscribe {
        channel_id: String,
        session_id: String,
        cursor: Option<Cursor>,
    },
    UnsubscribeChannel {
        channel_id: String,
    },
}

#[derive(Clone, Default)]
struct Cursor {
    sequence: Option<u64>,
    epoch: Option<String>,
    transcript_sequence: Option<u64>,
}

pub fn start(
    client: KimiClient,
) -> (
    KimiEventController,
    mpsc::Receiver<KimiEvent>,
    JoinHandle<()>,
) {
    let (command_tx, command_rx) = mpsc::channel(128);
    let (event_tx, event_rx) = mpsc::channel(512);
    let task = tokio::spawn(async move {
        event_loop(client, command_rx, event_tx).await;
    });
    (
        KimiEventController {
            commands: command_tx,
        },
        event_rx,
        task,
    )
}

impl KimiEventController {
    pub async fn subscribe(
        &self,
        channel_id: String,
        session_id: String,
        sequence: Option<u64>,
        epoch: Option<String>,
        transcript_sequence: Option<u64>,
    ) -> Result<()> {
        self.commands
            .send(EventCommand::Subscribe {
                channel_id,
                session_id,
                cursor: sequence
                    .map(|sequence| Cursor {
                        sequence: Some(sequence),
                        epoch: epoch.clone(),
                        transcript_sequence,
                    })
                    .or_else(|| {
                        transcript_sequence.map(|transcript_sequence| Cursor {
                            sequence: None,
                            epoch,
                            transcript_sequence: Some(transcript_sequence),
                        })
                    }),
            })
            .await
            .context("Kimi event bridge stopped")
    }

    pub async fn unsubscribe_channel(&self, channel_id: String) -> Result<()> {
        self.commands
            .send(EventCommand::UnsubscribeChannel { channel_id })
            .await
            .context("Kimi event bridge stopped")
    }
}

async fn event_loop(
    client: KimiClient,
    mut commands: mpsc::Receiver<EventCommand>,
    output: mpsc::Sender<KimiEvent>,
) {
    let mut subscriptions: HashMap<String, HashSet<String>> = HashMap::new();
    let mut cursors: HashMap<String, Cursor> = HashMap::new();
    let mut backoff = Duration::from_secs(1);
    loop {
        let connection = connect(&client).await;
        let Ok((socket, _)) = connection else {
            warn!("Kimi event WebSocket is unavailable");
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(15));
            drain_commands(&mut commands, &mut subscriptions, &mut cursors);
            continue;
        };
        let (mut sink, mut stream) = socket.split();
        if sink
            .send(Message::Text(
                client_hello_frame(&subscriptions).to_string().into(),
            ))
            .await
            .is_err()
            || send_subscription_frames(&mut sink, &subscriptions, &cursors)
                .await
                .is_err()
        {
            // A WebSocket can accept the TCP handshake and still reject the
            // protocol hello while Kimi is starting.  Treat that as a
            // reconnectable failure instead of spinning a tight loop.
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(15));
            drain_commands(&mut commands, &mut subscriptions, &mut cursors);
            continue;
        }
        let connected_at = Instant::now();
        loop {
            tokio::select! {
                command = commands.recv() => {
                    let Some(command) = command else { return };
                    apply_command(command, &mut subscriptions, &mut cursors);
                    if send_subscription_frames(&mut sink, &subscriptions, &cursors).await.is_err() {
                        break;
                    }
                }
                message = stream.next() => {
                    let Some(message) = message else { break };
                    let Ok(message) = message else { break };
                    let text = match message {
                        Message::Text(text) => text,
                        Message::Ping(payload) => {
                            if sink.send(Message::Pong(payload)).await.is_err() {
                                break;
                            }
                            continue;
                        }
                        Message::Close(_) => break,
                        _ => continue,
                    };
                    let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                    if value.get("type").and_then(Value::as_str) == Some("ping") {
                        let Some(nonce) = value.pointer("/payload/nonce").and_then(Value::as_str) else {
                            continue;
                        };
                        if sink
                            .send(Message::Text(json!({
                                "type": "pong",
                                "payload": { "nonce": nonce }
                            }).to_string().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        continue;
                    }
                    if matches!(
                        value.get("type").and_then(Value::as_str),
                        Some("ack" | "server_hello")
                    ) {
                        continue;
                    }
                    let session_id = value
                        .get("session_id")
                        .and_then(Value::as_str)
                        .or_else(|| value.pointer("/payload/sessionId").and_then(Value::as_str))
                        .or_else(|| value.pointer("/payload/session_id").and_then(Value::as_str));
                    if let Some(session_id) = session_id {
                        let is_transcript = matches!(
                            value.get("type").and_then(Value::as_str),
                            Some("transcript.ops" | "transcript.reset")
                        );
                        if is_transcript {
                            if let Some(sequence) = value
                                .pointer("/payload/seq")
                                .and_then(Value::as_u64)
                            {
                                merge_cursor(
                                    cursors.entry(session_id.to_owned()).or_default(),
                                    Cursor {
                                        sequence: None,
                                        epoch: None,
                                        transcript_sequence: Some(sequence),
                                    },
                                );
                            }
                        } else if let Some(sequence) = value.get("seq").and_then(Value::as_u64) {
                            merge_cursor(
                                cursors.entry(session_id.to_owned()).or_default(),
                                Cursor {
                                    sequence: Some(sequence),
                                    epoch: value
                                        .get("epoch")
                                        .and_then(Value::as_str)
                                        .map(str::to_owned),
                                    transcript_sequence: None,
                                },
                            );
                        }
                        if let Some(channels) = subscriptions.get(session_id) {
                            for channel_id in channels {
                                if output
                                    .send(KimiEvent {
                                        channel_id: channel_id.clone(),
                                        value: value.clone(),
                                    })
                                    .await
                                    .is_err()
                                {
                                    return;
                                }
                            }
                        }
                    } else {
                        let channel_ids = subscriptions
                            .values()
                            .flatten()
                            .cloned()
                            .collect::<HashSet<_>>();
                        for channel_id in channel_ids {
                            if output
                                .send(KimiEvent {
                                    channel_id,
                                    value: value.clone(),
                                })
                                .await
                                .is_err()
                            {
                                return;
                            }
                        }
                    }
                }
            }
        }
        // A socket that closes immediately after accepting the protocol must
        // not create a tight reconnect loop while Kimi is still starting.
        // Reset the delay only after a connection stayed healthy briefly,
        // then apply the same capped exponential backoff as connection errors.
        if connected_at.elapsed() >= Duration::from_secs(5) {
            backoff = Duration::from_secs(1);
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(15));
        drain_commands(&mut commands, &mut subscriptions, &mut cursors);
    }
}

async fn connect(
    client: &KimiClient,
) -> Result<(
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    tokio_tungstenite::tungstenite::handshake::client::Response,
)> {
    let mut request = client.websocket_url().into_client_request()?;
    request.headers_mut().insert(
        SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_str(&client.websocket_protocol())?,
    );
    connect_async(request)
        .await
        .context("Kimi event WebSocket connection failed")
}

fn subscribe_frame(
    subscriptions: &HashMap<String, HashSet<String>>,
    cursors: &HashMap<String, Cursor>,
) -> Value {
    let session_ids = subscriptions.keys().cloned().collect::<Vec<_>>();
    let cursor_values = cursors
        .iter()
        .filter(|(session_id, _)| subscriptions.contains_key(*session_id))
        .map(|(session_id, cursor)| {
            let mut value = serde_json::Map::new();
            if let Some(sequence) = cursor.sequence {
                value.insert("seq".to_owned(), json!(sequence));
            }
            if let Some(epoch) = &cursor.epoch {
                value.insert("epoch".to_owned(), json!(epoch));
            }
            (session_id.clone(), Value::Object(value))
        })
        .collect::<serde_json::Map<_, _>>();
    json!({
        "type": "subscribe",
        "id": Uuid::new_v4(),
        "payload": { "session_ids": session_ids, "cursors": cursor_values }
    })
}

fn client_hello_frame(subscriptions: &HashMap<String, HashSet<String>>) -> Value {
    json!({
        "type": "client_hello",
        "id": Uuid::new_v4(),
        "payload": {
            "client_id": "aialra-kimi-agent",
            "subscriptions": subscriptions.keys().cloned().collect::<Vec<_>>()
        }
    })
}

fn transcript_subscribe_frame(session_id: &str, cursor: Option<&Cursor>) -> Value {
    let since = cursor
        .and_then(|cursor| cursor.transcript_sequence)
        .map(|sequence| json!({ "main": sequence }));
    json!({
        "type": "subscribe_v2",
        "id": Uuid::new_v4(),
        "payload": {
            "session_id": session_id,
            "transcript": { "*": "delta" },
            "transcript_since": since
        }
    })
}

async fn send_subscription_frames<S>(
    sink: &mut S,
    subscriptions: &HashMap<String, HashSet<String>>,
    cursors: &HashMap<String, Cursor>,
) -> Result<()>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    sink.send(Message::Text(
        subscribe_frame(subscriptions, cursors).to_string().into(),
    ))
    .await?;
    for session_id in subscriptions.keys() {
        sink.send(Message::Text(
            transcript_subscribe_frame(session_id, cursors.get(session_id))
                .to_string()
                .into(),
        ))
        .await?;
    }
    Ok(())
}

fn apply_command(
    command: EventCommand,
    subscriptions: &mut HashMap<String, HashSet<String>>,
    cursors: &mut HashMap<String, Cursor>,
) {
    match command {
        EventCommand::Subscribe {
            channel_id,
            session_id,
            cursor,
        } => {
            if let Some(cursor) = cursor {
                merge_cursor(cursors.entry(session_id.clone()).or_default(), cursor);
            }
            subscriptions
                .entry(session_id)
                .or_default()
                .insert(channel_id);
        }
        EventCommand::UnsubscribeChannel { channel_id } => {
            subscriptions.retain(|_, channels| {
                channels.remove(&channel_id);
                !channels.is_empty()
            });
        }
    }
}

fn merge_cursor(existing: &mut Cursor, incoming: Cursor) {
    let epoch_changed = matches!(
        (&existing.epoch, &incoming.epoch),
        (Some(current), Some(next)) if current != next
    );

    if epoch_changed || (existing.sequence.is_none() && incoming.sequence.is_some()) {
        existing.sequence = incoming.sequence;
        if incoming.epoch.is_some() {
            existing.epoch = incoming.epoch;
        }
    } else if let Some(incoming_sequence) = incoming.sequence {
        if existing
            .sequence
            .is_none_or(|current| incoming_sequence > current)
        {
            existing.sequence = Some(incoming_sequence);
        }
        if existing.epoch.is_none() {
            existing.epoch = incoming.epoch;
        }
    } else if existing.epoch.is_none() && incoming.epoch.is_some() {
        existing.epoch = incoming.epoch;
    }

    if incoming.transcript_sequence.is_some_and(|sequence| {
        existing
            .transcript_sequence
            .is_none_or(|current| sequence > current)
    }) {
        existing.transcript_sequence = incoming.transcript_sequence;
    }
}

fn drain_commands(
    commands: &mut mpsc::Receiver<EventCommand>,
    subscriptions: &mut HashMap<String, HashSet<String>>,
    cursors: &mut HashMap<String, Cursor>,
) {
    while let Ok(command) = commands.try_recv() {
        apply_command(command, subscriptions, cursors);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removing_channel_removes_empty_session_subscription() {
        let mut subscriptions = HashMap::new();
        let mut cursors = HashMap::new();
        apply_command(
            EventCommand::Subscribe {
                channel_id: "channel-one".to_owned(),
                session_id: "session-one".to_owned(),
                cursor: None,
            },
            &mut subscriptions,
            &mut cursors,
        );
        apply_command(
            EventCommand::UnsubscribeChannel {
                channel_id: "channel-one".to_owned(),
            },
            &mut subscriptions,
            &mut cursors,
        );
        assert!(subscriptions.is_empty());
    }

    #[test]
    fn snapshot_cursor_is_included_in_subscription_frame() {
        let mut subscriptions = HashMap::new();
        let mut cursors = HashMap::new();
        apply_command(
            EventCommand::Subscribe {
                channel_id: "channel-one".to_owned(),
                session_id: "session-one".to_owned(),
                cursor: Some(Cursor {
                    sequence: Some(42),
                    epoch: Some("epoch-one".to_owned()),
                    transcript_sequence: Some(7),
                }),
            },
            &mut subscriptions,
            &mut cursors,
        );

        let frame = subscribe_frame(&subscriptions, &cursors);
        assert_eq!(
            frame.pointer("/payload/cursors/session-one/seq"),
            Some(&json!(42))
        );
        assert_eq!(
            transcript_subscribe_frame("session-one", cursors.get("session-one"))
                .pointer("/payload/transcript_since/main"),
            Some(&json!(7))
        );
        assert_eq!(
            frame.pointer("/payload/cursors/session-one/epoch"),
            Some(&json!("epoch-one"))
        );
    }

    #[test]
    fn transcript_cursor_never_invents_an_ordinary_zero_cursor() {
        let mut subscriptions = HashMap::new();
        let mut cursors = HashMap::new();
        apply_command(
            EventCommand::Subscribe {
                channel_id: "channel-one".to_owned(),
                session_id: "session-one".to_owned(),
                cursor: Some(Cursor {
                    sequence: None,
                    epoch: None,
                    transcript_sequence: Some(7),
                }),
            },
            &mut subscriptions,
            &mut cursors,
        );

        let frame = subscribe_frame(&subscriptions, &cursors);
        assert_eq!(
            frame.pointer("/payload/cursors/session-one"),
            Some(&json!({}))
        );
        assert_eq!(
            transcript_subscribe_frame("session-one", cursors.get("session-one"))
                .pointer("/payload/transcript_since/main"),
            Some(&json!(7))
        );
    }

    #[test]
    fn ordinary_and_transcript_cursors_merge_independently() {
        let mut cursor = Cursor {
            sequence: Some(12),
            epoch: Some("epoch-one".to_owned()),
            transcript_sequence: Some(4),
        };
        merge_cursor(
            &mut cursor,
            Cursor {
                sequence: None,
                epoch: None,
                transcript_sequence: Some(9),
            },
        );
        assert_eq!(cursor.sequence, Some(12));
        assert_eq!(cursor.transcript_sequence, Some(9));

        merge_cursor(
            &mut cursor,
            Cursor {
                sequence: Some(3),
                epoch: Some("epoch-two".to_owned()),
                transcript_sequence: None,
            },
        );
        assert_eq!(cursor.sequence, Some(3));
        assert_eq!(cursor.epoch.as_deref(), Some("epoch-two"));
        assert_eq!(cursor.transcript_sequence, Some(9));
    }
}
