#[cfg(windows)]
mod broker_protocol;
mod config;
mod crypto;
#[cfg(windows)]
mod elevated_broker_client;
mod events;
mod identity;
mod kimi;
mod relay;
mod service;
mod terminal;

use anyhow::Result;
use clap::{Parser, Subcommand};
use serde_json::json;
use std::path::PathBuf;
use tracing_subscriber::EnvFilter;
use url::Url;

use crate::{
    config::{AgentConfig, HostMode},
    identity::HostIdentity,
    kimi::KimiClient,
};

#[derive(Parser)]
#[command(name = "aialra-kimi-agent", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Enroll this device with a single-use pairing code.
    Enroll {
        #[arg(long)]
        server: Url,
        #[arg(long)]
        code: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long, value_enum, default_value_t = HostMode::Remote)]
        mode: HostMode,
        #[arg(long, default_value = "kimi")]
        kimi_executable: String,
        #[arg(long, default_value_t = 58_627)]
        kimi_port: u16,
    },
    /// Run the outbound agent and supervise the local Kimi server.
    Run {
        #[arg(long, hide = true)]
        state_dir: Option<PathBuf>,
        #[arg(long, hide = true)]
        kimi_home: Option<PathBuf>,
        #[arg(long, hide = true)]
        startup_marker: Option<PathBuf>,
        #[arg(long, hide = true)]
        background: bool,
    },
    #[cfg(windows)]
    #[command(hide = true)]
    Watchdog {
        #[arg(long)]
        state_dir: PathBuf,
        #[arg(long)]
        kimi_home: PathBuf,
    },
    /// Print a local diagnostic summary without exposing credentials.
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Install and start the per-user background service.
    InstallService,
    /// Stop and remove the per-user background service.
    UninstallService,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stderr()))
        .init();
    match Cli::parse().command {
        Command::Enroll {
            server,
            code,
            name,
            mode,
            kimi_executable,
            kimi_port,
        } => {
            let display_name = name.unwrap_or_else(default_host_name);
            relay::enroll(
                server,
                code.to_ascii_uppercase(),
                display_name,
                mode,
                kimi_executable,
                kimi_port,
            )
            .await?;
            println!("Device enrollment completed");
        }
        Command::Run {
            state_dir,
            kimi_home,
            startup_marker,
            background,
        } => {
            write_startup_marker(startup_marker.as_deref(), "starting");
            if let Some(path) = state_dir {
                config::set_data_dir_override(path)?;
            }
            if let Some(path) = kimi_home {
                kimi::set_home_override(path)?;
            }
            let config = AgentConfig::load()?;
            write_startup_marker(startup_marker.as_deref(), "configuration loaded");
            let identity = HostIdentity::load()?;
            write_startup_marker(startup_marker.as_deref(), "runtime active");
            if background {
                relay::run_forever(config, identity).await?;
            } else {
                tokio::select! {
                    result = relay::run_forever(config, identity) => result?,
                    _ = tokio::signal::ctrl_c() => {}
                }
            }
        }
        #[cfg(windows)]
        Command::Watchdog {
            state_dir,
            kimi_home,
        } => service::run_watchdog(state_dir, kimi_home).await?,
        Command::Status { json } => status(json).await?,
        Command::InstallService => service::install()?,
        Command::UninstallService => service::uninstall()?,
    }
    Ok(())
}

fn write_startup_marker(path: Option<&std::path::Path>, state: &str) {
    if let Some(path) = path {
        let _ = std::fs::write(path, state);
    }
}

async fn status(as_json: bool) -> Result<()> {
    let config = AgentConfig::load()?;
    HostIdentity::load()?;
    let probe = match KimiClient::attach(config.kimi_port).await {
        Ok(client) => client.probe().await.ok(),
        Err(_) => None,
    };
    let value = json!({
        "hostId": config.host_id,
        "displayName": config.display_name,
        "mode": config.mode.to_string(),
        "identity": "available",
        "kimi": probe.as_ref().map(|probe| json!({
            "version": probe.version,
            "loginState": probe.login_state,
            "openapiSha256": probe.openapi_sha256,
            "asyncapiSha256": probe.asyncapi_sha256,
            "capabilities": probe.capabilities
        })),
        "relay": config.server_url.origin().ascii_serialization()
    });
    if as_json {
        println!("{}", serde_json::to_string_pretty(&value)?);
    } else {
        println!("Host: {} ({})", config.display_name, config.mode);
        println!("Identity: available");
        if let Some(probe) = probe {
            println!("Kimi: {} ({})", probe.version, probe.login_state);
        } else {
            println!("Kimi: not running on 127.0.0.1:{}", config.kimi_port);
        }
        println!(
            "Relay: {}",
            config.server_url.origin().ascii_serialization()
        );
    }
    Ok(())
}

fn default_host_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Kimi host".to_owned())
}
