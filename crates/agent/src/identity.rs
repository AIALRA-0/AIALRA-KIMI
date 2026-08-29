use std::fs;

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use zeroize::Zeroizing;

use crate::config::{identity_path, restrict_file};

pub struct HostIdentity {
    signing_key: SigningKey,
}

impl HostIdentity {
    pub fn generate() -> Self {
        Self {
            signing_key: SigningKey::generate(&mut OsRng),
        }
    }

    pub fn load() -> Result<Self> {
        let encrypted =
            fs::read(identity_path()?).context("agent identity is missing; enroll again")?;
        let secret = Zeroizing::new(unprotect(&encrypted)?);
        let bytes: [u8; 32] = secret
            .as_slice()
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid identity length"))?;
        Ok(Self {
            signing_key: SigningKey::from_bytes(&bytes),
        })
    }

    pub fn save(&self) -> Result<()> {
        let path = identity_path()?;
        if path.exists() {
            bail!("an agent identity already exists; explicit re-enrollment is required");
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).context("failed to create the identity directory")?;
        }
        let protected = protect(self.signing_key.as_bytes())?;
        let temporary = path.with_extension("bin.tmp");
        fs::write(&temporary, protected).context("failed to write the protected identity")?;
        restrict_file(&temporary)?;
        fs::rename(&temporary, &path).context("failed to atomically install the identity")?;
        Ok(())
    }

    pub const fn signing_key(&self) -> &SigningKey {
        &self.signing_key
    }

    pub fn public_key_pem(&self) -> String {
        public_key_pem(&self.signing_key.verifying_key())
    }
}

pub fn public_key_pem(key: &VerifyingKey) -> String {
    const SPKI_PREFIX: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    let mut der = Vec::with_capacity(44);
    der.extend_from_slice(&SPKI_PREFIX);
    der.extend_from_slice(key.as_bytes());
    let encoded = STANDARD.encode(der);
    format!("-----BEGIN PUBLIC KEY-----\n{encoded}\n-----END PUBLIC KEY-----\n")
}

pub fn verifying_key_from_pem(pem: &str) -> Result<VerifyingKey> {
    let encoded: String = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    let der = STANDARD
        .decode(encoded)
        .context("invalid public key encoding")?;
    const PREFIX: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    if der.len() != 44 || der[..12] != PREFIX {
        bail!("unsupported public key format");
    }
    let raw: [u8; 32] = der[12..].try_into().expect("length checked");
    VerifyingKey::from_bytes(&raw).context("invalid Ed25519 public key")
}

#[cfg(not(windows))]
fn protect(value: &[u8]) -> Result<Vec<u8>> {
    Ok(value.to_vec())
}

#[cfg(not(windows))]
fn unprotect(value: &[u8]) -> Result<Vec<u8>> {
    Ok(value.to_vec())
}

#[cfg(windows)]
fn protect(value: &[u8]) -> Result<Vec<u8>> {
    use std::ptr::null_mut;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData},
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: value.len().try_into().context("identity is too large")?,
        pbData: value.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    // SAFETY: input points to `value` for the call and DPAPI allocates output with LocalAlloc.
    let result = unsafe {
        CryptProtectData(
            &input,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if result == 0 {
        bail!("Windows DPAPI failed to protect the identity");
    }
    // SAFETY: DPAPI returned exactly `output.cbData` initialized bytes.
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    // SAFETY: DPAPI allocated the buffer and requires LocalFree.
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(bytes)
}

#[cfg(windows)]
fn unprotect(value: &[u8]) -> Result<Vec<u8>> {
    use std::ptr::null_mut;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
        },
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: value.len().try_into().context("identity is too large")?,
        pbData: value.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    // SAFETY: input points to `value`; DPAPI validates and allocates output.
    let result = unsafe {
        CryptUnprotectData(
            &input,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if result == 0 {
        bail!("Windows DPAPI could not unlock the identity for this user");
    }
    // SAFETY: DPAPI returned exactly `output.cbData` initialized bytes.
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    // SAFETY: DPAPI allocated the buffer and requires LocalFree.
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_key_pem_round_trips() {
        let identity = HostIdentity::generate();
        let parsed = verifying_key_from_pem(&identity.public_key_pem()).unwrap();
        assert_eq!(parsed, identity.signing_key().verifying_key());
    }
}
