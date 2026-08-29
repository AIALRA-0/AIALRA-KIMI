use std::{fs, path::PathBuf};

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chacha20poly1305::{
    KeyInit, XChaCha20Poly1305, XNonce,
    aead::{Aead, Payload},
};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use zeroize::Zeroizing;

#[allow(dead_code)]
pub const BROKER_SERVICE_NAME: &str = "AIALRAKimiElevatedBroker";
#[allow(dead_code)]
pub const BROKER_DEFAULT_PORT: u16 = 58_799;
pub const BROKER_MAX_FRAME_BYTES: usize = 1024 * 1024;
const BROKER_AAD: &[u8] = b"aialra-kimi-elevated-broker-v1";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BrokerConfig {
    pub port: u16,
    pub key: Zeroizing<String>,
}

impl BrokerConfig {
    #[allow(dead_code)]
    pub fn generate() -> Self {
        let mut key = [0_u8; 32];
        OsRng.fill_bytes(&mut key);
        Self {
            port: BROKER_DEFAULT_PORT,
            key: Zeroizing::new(URL_SAFE_NO_PAD.encode(key)),
        }
    }

    pub fn load() -> Result<Self> {
        let bytes = Zeroizing::new(
            fs::read(config_path()?).context("elevated broker configuration is unavailable")?,
        );
        let config: Self =
            serde_json::from_slice(&bytes).context("invalid elevated broker configuration")?;
        config.key_bytes()?;
        Ok(config)
    }

    pub fn key_bytes(&self) -> Result<Zeroizing<[u8; 32]>> {
        let decoded = Zeroizing::new(URL_SAFE_NO_PAD.decode(self.key.as_bytes())?);
        let key: [u8; 32] = decoded
            .as_slice()
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid elevated broker key"))?;
        Ok(Zeroizing::new(key))
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BrokerRequest {
    pub request_id: String,
    pub timestamp_ms: u64,
    pub command: BrokerCommand,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "operation", content = "body", rename_all = "snake_case")]
pub enum BrokerCommand {
    Open {
        username: String,
        password: Zeroizing<String>,
        shell: String,
        columns: u16,
        rows: u16,
    },
    Input {
        terminal_id: String,
        data: String,
    },
    Resize {
        terminal_id: String,
        columns: u16,
        rows: u16,
    },
    Read {
        terminal_id: String,
        cursor: u64,
    },
    Close {
        terminal_id: String,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BrokerResponse {
    pub request_id: String,
    pub ok: bool,
    pub body: Value,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct BrokerFrame {
    nonce: String,
    ciphertext: String,
    tag: String,
}

pub fn seal<T: Serialize>(key: &[u8; 32], value: &T) -> Result<String> {
    let mut nonce = [0_u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let plaintext = Zeroizing::new(serde_json::to_vec(value)?);
    let cipher = XChaCha20Poly1305::new(key.into());
    let sealed = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: BROKER_AAD,
            },
        )
        .map_err(|_| anyhow::anyhow!("failed to encrypt elevated broker frame"))?;
    let split = sealed
        .len()
        .checked_sub(16)
        .context("invalid elevated broker ciphertext")?;
    Ok(serde_json::to_string(&BrokerFrame {
        nonce: URL_SAFE_NO_PAD.encode(nonce),
        ciphertext: URL_SAFE_NO_PAD.encode(&sealed[..split]),
        tag: URL_SAFE_NO_PAD.encode(&sealed[split..]),
    })?)
}

pub fn open<T: DeserializeOwned>(key: &[u8; 32], frame: &str) -> Result<T> {
    if frame.len() > BROKER_MAX_FRAME_BYTES {
        bail!("elevated broker frame is too large");
    }
    let frame: BrokerFrame = serde_json::from_str(frame)?;
    let nonce: [u8; 24] = URL_SAFE_NO_PAD
        .decode(frame.nonce)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid elevated broker nonce"))?;
    let mut sealed = URL_SAFE_NO_PAD.decode(frame.ciphertext)?;
    sealed.extend_from_slice(&URL_SAFE_NO_PAD.decode(frame.tag)?);
    let cipher = XChaCha20Poly1305::new(key.into());
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &sealed,
                    aad: BROKER_AAD,
                },
            )
            .map_err(|_| anyhow::anyhow!("elevated broker frame authentication failed"))?,
    );
    serde_json::from_slice(&plaintext).context("invalid elevated broker payload")
}

pub fn config_path() -> Result<PathBuf> {
    let program_data = std::env::var_os("PROGRAMDATA")
        .map(PathBuf::from)
        .context("PROGRAMDATA is unavailable")?;
    Ok(program_data.join("AIALRA/AIALRA-KIMI/elevated-broker.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broker_frames_round_trip() {
        let key = [7_u8; 32];
        let response = BrokerResponse {
            request_id: "request-one".to_owned(),
            ok: true,
            body: serde_json::json!({ "accepted": true }),
            error: None,
        };
        let encoded = seal(&key, &response).unwrap();
        let decoded: BrokerResponse = open(&key, &encoded).unwrap();
        assert!(decoded.ok);
        assert_eq!(decoded.request_id, "request-one");
    }
}
