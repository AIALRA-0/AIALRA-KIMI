use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpStream},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use serde_json::Value;
use uuid::Uuid;

use crate::broker_protocol::{
    BROKER_MAX_FRAME_BYTES, BrokerCommand, BrokerConfig, BrokerRequest, BrokerResponse, open, seal,
};

#[derive(Clone)]
pub struct ElevatedBrokerClient {
    config: BrokerConfig,
}

impl ElevatedBrokerClient {
    pub fn is_available() -> bool {
        let Ok(config) = BrokerConfig::load() else {
            return false;
        };
        TcpStream::connect_timeout(
            &SocketAddrV4::new(Ipv4Addr::LOCALHOST, config.port).into(),
            Duration::from_millis(150),
        )
        .is_ok()
    }

    pub fn load() -> Result<Self> {
        Ok(Self {
            config: BrokerConfig::load()?,
        })
    }

    pub fn call(&self, command: BrokerCommand) -> Result<Value> {
        let request_id = Uuid::new_v4().to_string();
        let request = BrokerRequest {
            request_id: request_id.clone(),
            timestamp_ms: unix_millis(),
            command,
        };
        let key = self.config.key_bytes()?;
        let frame = seal(&key, &request)?;
        let mut stream = TcpStream::connect_timeout(
            &SocketAddrV4::new(Ipv4Addr::LOCALHOST, self.config.port).into(),
            Duration::from_secs(2),
        )
        .context("the Windows elevated broker is unavailable")?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        stream.write_all(frame.as_bytes())?;
        stream.write_all(b"\n")?;
        stream.flush()?;
        let mut reader = BufReader::new(stream);
        let mut response = String::new();
        reader
            .by_ref()
            .take((BROKER_MAX_FRAME_BYTES + 1) as u64)
            .read_line(&mut response)?;
        if response.len() > BROKER_MAX_FRAME_BYTES {
            bail!("elevated broker response exceeded the limit");
        }
        let response: BrokerResponse = open(&key, response.trim_end())?;
        if response.request_id != request_id {
            bail!("elevated broker response identity mismatch");
        }
        if !response.ok {
            bail!(
                "{}",
                response
                    .error
                    .unwrap_or_else(|| "elevated broker rejected the request".to_owned())
            );
        }
        Ok(response.body)
    }
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
