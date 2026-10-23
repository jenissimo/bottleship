use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError(pub String);
impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ConfigError {}
fn err(message: &str) -> ConfigError {
    ConfigError(message.into())
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Limits {
    pub max_rooms: usize,
    pub max_peers_per_room: usize,
    pub max_buffered_frames: usize,
    pub max_buffered_bytes: usize,
    pub max_frames_per_second: u32,
    pub max_bytes_per_second: usize,
    pub reconnect_grace_ms: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_rooms: 128,
            max_peers_per_room: 64,
            max_buffered_frames: 64,
            max_buffered_bytes: 1048576,
            max_frames_per_second: 2000,
            max_bytes_per_second: 4194304,
            reconnect_grace_ms: 60000,
        }
    }
}
impl Limits {
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.max_rooms == 0
            || self.max_rooms > 65536
            || self.max_peers_per_room == 0
            || self.max_peers_per_room > 4096
            || self.max_buffered_frames == 0
            || self.max_buffered_frames > 65536
            || self.max_buffered_bytes == 0
            || self.max_buffered_bytes > 1073741824
            || self.max_frames_per_second == 0
            || self.max_bytes_per_second == 0
            || self.reconnect_grace_ms > 86400000
        {
            return Err(err("Invalid LAN limit"));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RouteProtocol {
    Udp,
    Tcp,
    Raw,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RawMode {
    Exclusive,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteConfig {
    pub host: String,
    #[serde(default)]
    pub address: Option<String>,
    #[serde(default)]
    pub scope_id: Option<u32>,
    #[serde(default)]
    pub names: Vec<String>,
    #[serde(default)]
    pub ports: Vec<u16>,
    pub protocols: Vec<RouteProtocol>,
    #[serde(default)]
    pub ip_protocols: Vec<u8>,
    #[serde(default)]
    pub raw_mode: Option<RawMode>,
}
impl RouteConfig {
    pub fn validate(&self) -> Result<(), ConfigError> {
        let len = |s: &str| s.encode_utf16().count();
        if self.host.is_empty()
            || len(&self.host) > 253
            || self.protocols.is_empty()
            || self.ports.len() > 256
            || self.ports.contains(&0)
            || self.ip_protocols.len() > 256
            || self.names.len() > 32
            || self.names.iter().any(|s| s.is_empty() || len(s) > 253)
            || (self
                .protocols
                .iter()
                .any(|p| matches!(p, RouteProtocol::Udp | RouteProtocol::Tcp))
                && self.ports.is_empty())
            || (self.protocols.contains(&RouteProtocol::Raw) && self.ip_protocols.is_empty())
        {
            return Err(err("Invalid native game-server gateway route"));
        }
        if let Some(address) = &self.address {
            crate::routes::NativeAddress::parse(address)
                .map_err(|_| err("Invalid guest gateway address"))?;
        }
        Ok(())
    }
}
fn one_owner() -> usize {
    1
}
fn listener_peers() -> usize {
    64
}
fn listener_idle() -> u64 {
    60000
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UdpListenerConfig {
    pub id: String,
    pub bind_host: String,
    pub advertised_host: String,
    pub port: u16,
    pub allowed_hosts: Vec<String>,
    #[serde(default = "one_owner")]
    pub max_owners: usize,
    #[serde(default = "listener_peers")]
    pub max_peers: usize,
    #[serde(default = "listener_idle")]
    pub idle_timeout_ms: u64,
}
impl UdpListenerConfig {
    pub fn unicast(ip: std::net::Ipv4Addr) -> bool {
        let b = ip.octets();
        b[0] != 0 && b[0] < 224 && b != [255; 4]
    }
    pub fn validate(&self) -> Result<(), ConfigError> {
        let parse = |s: &str| {
            s.parse::<std::net::Ipv4Addr>()
                .map_err(|_| err("UDP listener requires numeric IPv4"))
        };
        if self.id.is_empty()
            || self.id.len() > 64
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || !(1..=64).contains(&self.max_owners)
            || !(1..=128).contains(&self.max_peers)
            || !(1..=3600000).contains(&self.idle_timeout_ms)
            || self.allowed_hosts.is_empty()
            || self.allowed_hosts.len() > 32
        {
            return Err(err("Invalid UDP listener policy"));
        }
        let bind = parse(&self.bind_host)?;
        if !bind.is_unspecified() && !Self::unicast(bind) {
            return Err(err("Invalid UDP bind interface"));
        }
        if !Self::unicast(parse(&self.advertised_host)?) {
            return Err(err("Invalid advertised UDP endpoint"));
        }
        let mut hosts = std::collections::HashSet::new();
        for host in &self.allowed_hosts {
            let ip = parse(host)?;
            if !Self::unicast(ip) || !hosts.insert(ip) {
                return Err(err("Invalid UDP ingress ACL"));
            }
        }
        Ok(())
    }
    pub fn advertised_node(&self) -> crate::wire::Node {
        let b = self
            .advertised_host
            .parse::<std::net::Ipv4Addr>()
            .expect("validated listener")
            .octets();
        [2, 1, b[0], b[1], b[2], b[3]]
    }
    pub fn allowed_nodes(&self) -> Vec<crate::wire::Node> {
        self.allowed_hosts
            .iter()
            .map(|s| {
                let b = s
                    .parse::<std::net::Ipv4Addr>()
                    .expect("validated ACL")
                    .octets();
                [2, 1, b[0], b[1], b[2], b[3]]
            })
            .collect()
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GatewayConfig {
    pub routes: Vec<RouteConfig>,
    pub udp_listeners: Vec<UdpListenerConfig>,
    pub max_tcp_connections: usize,
    pub max_udp_flows: usize,
    pub max_raw_flows: usize,
    pub connect_timeout_ms: u64,
    pub udp_idle_timeout_ms: u64,
    pub native_helper_path: Option<String>,
    pub native_udp_helper_path: Option<String>,
}
impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            routes: vec![],
            udp_listeners: vec![],
            max_tcp_connections: 128,
            max_udp_flows: 128,
            max_raw_flows: 64,
            connect_timeout_ms: 10000,
            udp_idle_timeout_ms: 60000,
            native_helper_path: None,
            native_udp_helper_path: None,
        }
    }
}
impl GatewayConfig {
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.routes.len() > 128
            || self.udp_listeners.len() > 32
            || [
                self.max_tcp_connections,
                self.max_udp_flows,
                self.max_raw_flows,
            ]
            .iter()
            .any(|n| *n == 0 || *n > 4096)
            || !(1..=120000).contains(&self.connect_timeout_ms)
            || !(1..=3600000).contains(&self.udp_idle_timeout_ms)
            || [&self.native_helper_path, &self.native_udp_helper_path]
                .iter()
                .any(|p| {
                    p.as_ref()
                        .is_some_and(|p| p.is_empty() || p.encode_utf16().count() > 4096)
                })
        {
            return Err(err("Invalid gateway limits"));
        }
        for r in &self.routes {
            r.validate()?
        }
        let mut ids = std::collections::HashSet::new();
        for listener in &self.udp_listeners {
            listener.validate()?;
            if !ids.insert(&listener.id) {
                return Err(err("Duplicate UDP listener identity"));
            }
        }
        Ok(())
    }
}
