use bottleship_lan_core::config::{GatewayConfig, Limits};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Origins {
    Any(String),
    List(Vec<String>),
}
impl Default for Origins {
    fn default() -> Self {
        Self::Any("*".into())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub allowed_origins: Origins,
    pub transports: Vec<String>,
    #[serde(flatten)]
    pub limits: Limits,
    pub gateway: GatewayConfig,
    /// Additional process-wide Rust resource limits, independent of per-room limits.
    pub max_connections: usize,
    pub max_native_participants: usize,
    pub max_dns_operations: usize,
    pub dns_timeout_ms: u64,
    /// Structured connection diagnostics; disabled on the normal packet path.
    pub log_connections: bool,
}
impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 9001,
            allowed_origins: Origins::default(),
            transports: vec!["polling".into(), "websocket".into()],
            limits: Limits::default(),
            gateway: GatewayConfig::default(),
            max_connections: 256,
            max_native_participants: 256,
            max_dns_operations: 64,
            dns_timeout_ms: 10000,
            log_connections: false,
        }
    }
}
impl ServerConfig {
    pub fn validate(&self) -> Result<(), String> {
        self.limits.validate().map_err(|e| e.to_string())?;
        self.gateway.validate().map_err(|e| e.to_string())?;
        if self.host.is_empty()
            || self.host.len() > 253
            || self.max_connections == 0
            || self.max_connections > 65536
            || self.max_native_participants == 0
            || self.max_native_participants > 65536
            || self.max_dns_operations == 0
            || self.max_dns_operations > 1024
            || !(1..=120000).contains(&self.dns_timeout_ms)
            || self.transports.is_empty()
            || self
                .transports
                .iter()
                .any(|t| t != "polling" && t != "websocket")
        {
            return Err("Invalid LAN server configuration".into());
        }
        match &self.allowed_origins {
            Origins::Any(value) if value != "*" => {
                Err("allowedOrigins must be * or an array".into())
            }
            Origins::List(values)
                if values.len() > 256 || values.iter().any(|v| v.is_empty() || v.len() > 2048) =>
            {
                Err("Invalid allowedOrigins".into())
            }
            _ => Ok(()),
        }
    }
    pub fn origins(&self) -> Vec<String> {
        match &self.allowed_origins {
            Origins::Any(value) => vec![value.clone()],
            Origins::List(values) => values.clone(),
        }
    }
}
