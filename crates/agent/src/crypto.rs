use std::collections::HashSet;

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chacha20poly1305::{
    KeyInit, XChaCha20Poly1305, XNonce,
    aead::{Aead, Payload},
};
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityGrant {
    pub grant_id: String,
    pub subject: String,
    pub host_id: String,
    pub scopes: HashSet<String>,
    pub issued_at: u64,
    pub expires_at: u64,
    pub nonce: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedFrame {
    pub channel_id: String,
    pub channel: String,
    pub sequence: u64,
    pub nonce: String,
    pub ciphertext: String,
    pub tag: String,
}

pub struct SecureChannel {
    pub id: String,
    pub kind: String,
    pub grant_token: String,
    pub grant: CapabilityGrant,
    cipher: XChaCha20Poly1305,
    expected_inbound_sequence: u64,
    outbound_sequence: u64,
}

pub struct ChannelAccept {
    pub channel: SecureChannel,
    pub agent_ephemeral_key: String,
    pub signature: String,
}

pub fn decode_grant(token: &str, verification_key: &VerifyingKey) -> Result<CapabilityGrant> {
    let (payload, signature) = token
        .split_once('.')
        .context("malformed capability grant")?;
    let signature = ed25519_dalek::Signature::from_slice(&URL_SAFE_NO_PAD.decode(signature)?)?;
    verification_key
        .verify(payload.as_bytes(), &signature)
        .context("invalid capability grant signature")?;
    let grant: CapabilityGrant = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload)?)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    if grant.issued_at > now + 15 || grant.expires_at <= now {
        bail!("capability grant expired or is not yet valid");
    }
    if grant.grant_id.is_empty() || grant.nonce.len() < 16 {
        bail!("capability grant identity is invalid");
    }
    Ok(grant)
}

impl SecureChannel {
    #[allow(clippy::too_many_arguments)]
    pub fn accept(
        channel_id: String,
        kind: String,
        host_id: String,
        subject: String,
        browser_key: &str,
        grant_token: String,
        verification_key: &VerifyingKey,
        signing_key: &SigningKey,
    ) -> Result<ChannelAccept> {
        let grant = decode_grant(&grant_token, verification_key)?;
        if grant.host_id != host_id || grant.subject != subject {
            bail!("capability grant binding mismatch");
        }
        let browser_raw: [u8; 32] = URL_SAFE_NO_PAD
            .decode(browser_key)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid browser X25519 key"))?;
        let browser_public = PublicKey::from(browser_raw);
        let agent_secret = StaticSecret::random_from_rng(OsRng);
        let agent_public = PublicKey::from(&agent_secret);
        let shared = agent_secret.diffie_hellman(&browser_public);
        let mut key = [0_u8; 32];
        Hkdf::<Sha256>::new(Some(channel_id.as_bytes()), shared.as_bytes())
            .expand(b"aialra-kimi-e2e-v1", &mut key)
            .map_err(|_| anyhow::anyhow!("failed to derive channel key"))?;
        let agent_ephemeral_key = URL_SAFE_NO_PAD.encode(agent_public.as_bytes());
        let grant_hash = URL_SAFE_NO_PAD.encode(Sha256::digest(grant_token.as_bytes()));
        let canonical = format!("{channel_id}\n{browser_key}\n{agent_ephemeral_key}\n{grant_hash}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key.sign(canonical.as_bytes()).to_bytes());
        Ok(ChannelAccept {
            channel: Self {
                id: channel_id,
                kind,
                grant_token,
                grant,
                cipher: XChaCha20Poly1305::new((&key).into()),
                expected_inbound_sequence: 0,
                outbound_sequence: 0,
            },
            agent_ephemeral_key,
            signature,
        })
    }

    pub fn decrypt(&mut self, frame: &EncryptedFrame) -> Result<Value> {
        if frame.channel_id != self.id || frame.channel != self.kind {
            bail!("encrypted frame channel mismatch");
        }
        if frame.sequence != self.expected_inbound_sequence {
            bail!("replayed or out-of-order encrypted frame");
        }
        let nonce: [u8; 24] = URL_SAFE_NO_PAD
            .decode(&frame.nonce)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid XChaCha20 nonce"))?;
        let mut sealed = URL_SAFE_NO_PAD.decode(&frame.ciphertext)?;
        sealed.extend_from_slice(&URL_SAFE_NO_PAD.decode(&frame.tag)?);
        let aad = format!("{}\n{}\n{}", self.id, self.kind, frame.sequence);
        let plaintext = Zeroizing::new(
            self.cipher
                .decrypt(
                    XNonce::from_slice(&nonce),
                    Payload {
                        msg: &sealed,
                        aad: aad.as_bytes(),
                    },
                )
                .map_err(|_| anyhow::anyhow!("encrypted frame authentication failed"))?,
        );
        let value =
            serde_json::from_slice(&plaintext).context("invalid encrypted request payload")?;
        self.expected_inbound_sequence = self
            .expected_inbound_sequence
            .checked_add(1)
            .context("channel sequence exhausted")?;
        Ok(value)
    }

    pub fn encrypt(&mut self, value: &Value) -> Result<EncryptedFrame> {
        let sequence = self.outbound_sequence;
        self.outbound_sequence = self
            .outbound_sequence
            .checked_add(1)
            .context("channel sequence exhausted")?;
        let mut nonce = [0_u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let aad = format!("{}\n{}\n{}", self.id, self.kind, sequence);
        let sealed = self
            .cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &serde_json::to_vec(value)?,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| anyhow::anyhow!("failed to encrypt channel frame"))?;
        let split = sealed
            .len()
            .checked_sub(16)
            .context("invalid encrypted output")?;
        Ok(EncryptedFrame {
            channel_id: self.id.clone(),
            channel: self.kind.clone(),
            sequence,
            nonce: URL_SAFE_NO_PAD.encode(nonce),
            ciphertext: URL_SAFE_NO_PAD.encode(&sealed[..split]),
            tag: URL_SAFE_NO_PAD.encode(&sealed[split..]),
        })
    }

    pub fn allows(&self, operation: &str) -> bool {
        self.grant.scopes.contains(operation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_host_bound_signed_grant() {
        let signing = SigningKey::generate(&mut OsRng);
        let browser_secret = StaticSecret::random_from_rng(OsRng);
        let browser_public = URL_SAFE_NO_PAD.encode(PublicKey::from(&browser_secret).as_bytes());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let payload = serde_json::json!({
            "grantId": "grant-one",
            "subject": "owner",
            "hostId": "host-test-one",
            "scopes": ["sessions.list"],
            "issuedAt": now,
            "expiresAt": now + 60,
            "nonce": "nonce-one-with-enough-bytes"
        });
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let token = format!(
            "{}.{}",
            encoded,
            URL_SAFE_NO_PAD.encode(signing.sign(encoded.as_bytes()).to_bytes())
        );
        let accepted = SecureChannel::accept(
            "00000000-0000-4000-8000-000000000001".to_owned(),
            "kimi".to_owned(),
            "host-test-one".to_owned(),
            "owner".to_owned(),
            &browser_public,
            token,
            &signing.verifying_key(),
            &signing,
        )
        .unwrap();
        assert!(accepted.channel.allows("sessions.list"));
    }

    #[test]
    fn decrypt_requires_the_next_inbound_sequence() {
        let signing = SigningKey::generate(&mut OsRng);
        let browser_secret = StaticSecret::random_from_rng(OsRng);
        let browser_public = URL_SAFE_NO_PAD.encode(PublicKey::from(&browser_secret).as_bytes());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let payload = serde_json::json!({
            "grantId": "grant-two",
            "subject": "owner",
            "hostId": "host-test-two",
            "scopes": ["sessions.list"],
            "issuedAt": now,
            "expiresAt": now + 60,
            "nonce": "nonce-two-with-enough-bytes"
        });
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let token = format!(
            "{}.{}",
            encoded,
            URL_SAFE_NO_PAD.encode(signing.sign(encoded.as_bytes()).to_bytes())
        );
        let accepted = SecureChannel::accept(
            "00000000-0000-4000-8000-000000000002".to_owned(),
            "kimi".to_owned(),
            "host-test-two".to_owned(),
            "owner".to_owned(),
            &browser_public,
            token,
            &signing.verifying_key(),
            &signing,
        )
        .unwrap();
        let mut channel = accepted.channel;
        let frame = channel
            .encrypt(&serde_json::json!({ "request": true }))
            .unwrap();
        let mut gap = frame.clone();
        gap.sequence = 1;
        assert!(channel.decrypt(&gap).is_err());
        assert_eq!(
            channel.decrypt(&frame).unwrap(),
            serde_json::json!({ "request": true })
        );
        assert!(channel.decrypt(&frame).is_err());
    }
}
