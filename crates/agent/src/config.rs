use std::{fs, path::PathBuf, sync::OnceLock};

use anyhow::{Context, Result, bail};
use clap::ValueEnum;
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum HostMode {
    Vps,
    Remote,
}

impl std::fmt::Display for HostMode {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Vps => "vps",
            Self::Remote => "remote",
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AgentConfig {
    pub server_url: Url,
    pub host_id: String,
    pub display_name: String,
    pub mode: HostMode,
    pub grant_verification_key: String,
    #[serde(default = "default_kimi_executable")]
    pub kimi_executable: String,
    #[serde(default = "default_kimi_port")]
    pub kimi_port: u16,
}

fn default_kimi_executable() -> String {
    "kimi".to_owned()
}

const fn default_kimi_port() -> u16 {
    58_627
}

static DATA_DIR_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

pub fn set_data_dir_override(path: PathBuf) -> Result<()> {
    DATA_DIR_OVERRIDE
        .set(path)
        .map_err(|_| anyhow::anyhow!("agent data directory was already configured"))
}

pub fn data_dir() -> Result<PathBuf> {
    if let Some(path) = DATA_DIR_OVERRIDE.get() {
        return Ok(path.clone());
    }
    if let Some(path) = std::env::var_os("AIALRA_KIMI_HOME") {
        return Ok(PathBuf::from(path));
    }
    let project = ProjectDirs::from("online", "AIALRA", "AIALRA-KIMI")
        .context("unable to resolve the per-user application data directory")?;
    Ok(project.data_local_dir().to_path_buf())
}

pub fn config_path() -> Result<PathBuf> {
    Ok(data_dir()?.join("agent.json"))
}

pub fn identity_path() -> Result<PathBuf> {
    Ok(data_dir()?.join("identity.bin"))
}

impl AgentConfig {
    pub fn load() -> Result<Self> {
        let path = config_path()?;
        let bytes = fs::read(&path)
            .with_context(|| format!("agent is not enrolled; missing {}", path.display()))?;
        let config: Self = serde_json::from_slice(&bytes).context("invalid agent configuration")?;
        config.validate()?;
        Ok(config)
    }

    pub fn save(&self) -> Result<()> {
        self.validate()?;
        let path = config_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).context("failed to create the agent data directory")?;
        }
        let temporary = path.with_extension("json.tmp");
        fs::write(&temporary, serde_json::to_vec_pretty(self)?)
            .context("failed to write the agent configuration")?;
        restrict_file(&temporary)?;
        fs::rename(&temporary, &path)
            .context("failed to atomically install agent configuration")?;
        Ok(())
    }

    fn validate(&self) -> Result<()> {
        validate_server_url(&self.server_url)?;
        if self.host_id.len() < 8 {
            bail!("invalid host identity");
        }
        Ok(())
    }
}

pub fn validate_server_url(server_url: &Url) -> Result<()> {
    if !matches!(server_url.scheme(), "https" | "http") {
        bail!("server URL must use HTTPS, or HTTP for loopback development");
    }
    if server_url.scheme() == "http"
        && !matches!(
            server_url.host_str(),
            Some("127.0.0.1" | "localhost" | "::1")
        )
    {
        bail!("unencrypted agent connections are limited to loopback development");
    }
    Ok(())
}

#[cfg(unix)]
pub fn restrict_file(path: &std::path::Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .context("failed to set private file permissions")
}

#[cfg(windows)]
pub fn restrict_file(_path: &std::path::Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_plaintext_non_loopback_server() {
        let config = AgentConfig {
            server_url: Url::parse("http://example.invalid").unwrap(),
            host_id: "host-test-one".to_owned(),
            display_name: "Test".to_owned(),
            mode: HostMode::Remote,
            grant_verification_key: "key".to_owned(),
            kimi_executable: "kimi".to_owned(),
            kimi_port: 58_627,
        };
        assert!(config.validate().is_err());
        assert!(validate_server_url(&config.server_url).is_err());
    }
}
