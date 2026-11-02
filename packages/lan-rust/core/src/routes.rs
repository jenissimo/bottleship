//! Configured destinations only. Startup DNS answers are supplied by the native resolver, never looked up here.
use crate::{
    config::{ConfigError, GatewayConfig, RawMode, RouteProtocol},
    wire::{Datagram, Node, ResolveRequest, external_node},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV6},
};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NativeAddress {
    pub ip: IpAddr,
    pub scope_id: u32,
}
impl NativeAddress {
    pub fn parse(s: &str) -> Result<Self, ConfigError> {
        let (s, scope) = match s.rsplit_once('%') {
            Some((ip, scope)) => (
                ip,
                scope.parse::<u32>().map_err(|_| {
                    ConfigError("Native interface zone requires resolver snapshot".into())
                })?,
            ),
            None => (s, 0),
        };
        let ip = s
            .parse::<IpAddr>()
            .map_err(|_| ConfigError("Invalid numeric address".into()))?;
        if ip.is_ipv4() && scope != 0 {
            return Err(ConfigError("IPv4 has no scope".into()));
        }
        Ok(Self {
            ip,
            scope_id: scope,
        })
    }
    pub fn text(&self) -> String {
        if self.scope_id != 0 {
            format!("{}%{}", self.ip, self.scope_id)
        } else {
            self.ip.to_string()
        }
    }
    pub fn socket_addr(&self, port: u16) -> SocketAddr {
        match self.ip {
            IpAddr::V4(ip) => SocketAddr::new(ip.into(), port),
            IpAddr::V6(ip) => SocketAddr::V6(SocketAddrV6::new(ip, port, 0, self.scope_id)),
        }
    }
    pub fn canonical_policy_key(&self) -> String {
        match self.ip {
            IpAddr::V4(ip) => {
                if ip.is_unspecified() {
                    Ipv4Addr::LOCALHOST.to_string()
                } else {
                    ip.to_string()
                }
            }
            IpAddr::V6(ip) => {
                if let Some(v4) = ip.to_ipv4_mapped() {
                    v4.to_string()
                } else {
                    let ip = if ip.is_unspecified() {
                        Ipv6Addr::LOCALHOST
                    } else {
                        ip
                    };
                    if self.scope_id == 0 {
                        ip.to_string()
                    } else {
                        format!("{ip}%{}", self.scope_id)
                    }
                }
            }
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ResolveCode {
    #[serde(rename = "HOST_NOT_FOUND")]
    HostNotFound,
    #[serde(rename = "TRY_AGAIN")]
    TryAgain,
    #[serde(rename = "NO_RECOVERY")]
    NoRecovery,
    #[serde(rename = "NO_DATA")]
    NoData,
    #[serde(rename = "CANCELLED")]
    Cancelled,
    #[serde(rename = "NETWORK_DOWN")]
    NetworkDown,
    #[serde(rename = "ACCESS_DENIED")]
    AccessDenied,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolveError {
    pub code: ResolveCode,
    pub message: String,
}
impl ResolveError {
    pub fn new(code: ResolveCode, message: &str) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}
impl std::error::Error for ResolveError {}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAddress {
    pub address: String,
    pub family: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<Node>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<u32>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResult {
    pub canonical_name: String,
    pub addresses: Vec<ResolvedAddress>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub route_id: usize,
    pub address: NativeAddress,
    pub port: u16,
    pub canonical_policy_key: String,
    pub raw_mode: Option<RawMode>,
}
#[derive(Debug, Clone)]
struct PinnedRoute {
    native: Vec<NativeAddress>,
    guest: Vec<NativeAddress>,
    error: Option<ResolveError>,
}
#[derive(Debug, Clone)]
pub struct Routes {
    pub config: GatewayConfig,
    pinned: Vec<PinnedRoute>,
    v6: HashMap<NativeAddress, Node>,
    v6_reverse: HashMap<Node, NativeAddress>,
    next_v6: u32,
}
fn normalize_name(s: &str) -> String {
    s.strip_suffix('.').unwrap_or(s).to_lowercase()
}
impl Routes {
    pub fn new(config: GatewayConfig) -> Result<Self, ConfigError> {
        config.validate()?;
        let mut routes = Self {
            pinned: vec![
                PinnedRoute {
                    native: vec![],
                    guest: vec![],
                    error: Some(ResolveError::new(
                        ResolveCode::HostNotFound,
                        "Configured destination is not resolved"
                    ))
                };
                config.routes.len()
            ],
            config,
            v6: HashMap::new(),
            v6_reverse: HashMap::new(),
            next_v6: 1,
        };
        for id in 0..routes.config.routes.len() {
            if let Ok(address) = NativeAddress::parse(&routes.config.routes[id].host) {
                routes.pin(id, Ok(vec![address]))?;
            }
        }
        Ok(routes)
    }
    /// Replace one configured route's resolver snapshot. No arbitrary hostname enters this method.
    pub fn pin(
        &mut self,
        id: usize,
        result: Result<Vec<NativeAddress>, ResolveError>,
    ) -> Result<(), ConfigError> {
        let route = self
            .config
            .routes
            .get(id)
            .ok_or_else(|| ConfigError("Unknown configured route".into()))?;
        let native = match result {
            Ok(v) => v,
            Err(error) => {
                self.pinned[id].error = Some(error);
                return Ok(());
            }
        };
        let mut unique = Vec::new();
        for a in native {
            if unique.len() == 32 {
                break;
            }
            if a.ip.is_ipv4() && a.scope_id != 0 {
                return Err(ConfigError("Invalid IPv4 scope in snapshot".into()));
            }
            if !unique.contains(&a) {
                unique.push(a)
            }
        }
        if unique.is_empty() {
            self.pinned[id].error = Some(ResolveError::new(
                ResolveCode::NoData,
                "Configured destination has no addresses",
            ));
            return Ok(());
        }
        let mut guest = if let Some(address) = &route.address {
            vec![NativeAddress::parse(address)?]
        } else if let Ok(address) = NativeAddress::parse(&route.host) {
            vec![address]
        } else {
            unique.clone()
        };
        if let Some(scope) = route.scope_id {
            for a in &mut guest {
                if a.ip.is_ipv6() {
                    a.scope_id = scope
                }
            }
        }
        let missing = guest
            .iter()
            .filter(|a| a.ip.is_ipv6() && !self.v6.contains_key(a))
            .count();
        if self.v6.len() + missing > 4096 {
            return Err(ConfigError("Gateway IPv6 registry is full".into()));
        }
        for a in &guest {
            if a.ip.is_ipv6() && !self.v6.contains_key(a) {
                let id = self.next_v6;
                self.next_v6 = self
                    .next_v6
                    .checked_add(1)
                    .ok_or_else(|| ConfigError("IPv6 identity exhausted".into()))?;
                let b = id.to_be_bytes();
                let node = [2, 2, b[0], b[1], b[2], b[3]];
                self.v6.insert(*a, node);
                self.v6_reverse.insert(node, *a);
            }
        }
        self.pinned[id] = PinnedRoute {
            native: unique,
            guest,
            error: None,
        };
        Ok(())
    }
    pub fn address_for_node(&self, node: &Node) -> Option<NativeAddress> {
        if node[..2] == [2, 1] {
            Some(NativeAddress {
                ip: Ipv4Addr::new(node[2], node[3], node[4], node[5]).into(),
                scope_id: 0,
            })
        } else {
            self.v6_reverse.get(node).copied()
        }
    }
    pub fn target(&self, d: &Datagram) -> Result<Target, ResolveError> {
        if !external_node(&d.node) {
            return Err(ResolveError::new(
                ResolveCode::AccessDenied,
                "Not an external destination",
            ));
        }
        let guest = self.address_for_node(&d.node).ok_or_else(|| {
            ResolveError::new(
                ResolveCode::AccessDenied,
                "Unknown external gateway address",
            )
        })?;
        let protocol = match d.proto {
            1 | 4 => RouteProtocol::Udp,
            2 | 5 => RouteProtocol::Tcp,
            6 | 7 => RouteProtocol::Raw,
            _ => {
                return Err(ResolveError::new(
                    ResolveCode::AccessDenied,
                    "Protocol has no native gateway",
                ));
            }
        };
        for (id, r) in self.config.routes.iter().enumerate() {
            let p = &self.pinned[id];
            if !p.guest.contains(&guest) || !r.protocols.contains(&protocol) {
                continue;
            }
            if protocol == RouteProtocol::Raw {
                if d.payload.is_empty() || !r.ip_protocols.contains(&d.payload[0]) {
                    continue;
                }
            } else if !r.ports.contains(&d.dst_port) {
                continue;
            }
            let address = if r.address.is_none() && !r.host.contains('%') {
                guest
            } else {
                p.native
                    .iter()
                    .find(|a| a.ip.is_ipv4() == guest.ip.is_ipv4())
                    .or(p.native.first())
                    .copied()
                    .ok_or_else(|| {
                        ResolveError::new(
                            ResolveCode::NoData,
                            "Native destination has no resolved address",
                        )
                    })?
            };
            return Ok(Target {
                route_id: id,
                address,
                port: d.dst_port,
                canonical_policy_key: address.canonical_policy_key(),
                raw_mode: r.raw_mode,
            });
        }
        Err(ResolveError::new(
            ResolveCode::AccessDenied,
            "Destination is not a configured native route",
        ))
    }
    pub fn selected_route_ids(&self, request: &ResolveRequest) -> Result<Vec<usize>, ResolveError> {
        if request.host.is_empty()
            || request.host.encode_utf16().count() > 253
            || !matches!(request.family, 0 | 4 | 6)
        {
            return Err(ResolveError::new(
                ResolveCode::NoRecovery,
                "Invalid DNS request",
            ));
        }
        let numeric = NativeAddress::parse(&request.host).ok();
        let host = normalize_name(&request.host);
        let selected: Vec<usize> = self
            .config
            .routes
            .iter()
            .enumerate()
            .filter(|(id, r)| {
                normalize_name(&r.host) == host
                    || r.names.iter().any(|n| normalize_name(n) == host)
                    || numeric.is_some_and(|a| self.pinned[*id].guest.contains(&a))
            })
            .map(|(id, _)| id)
            .collect();
        if selected.is_empty() {
            return Err(ResolveError::new(
                ResolveCode::AccessDenied,
                "Name is not a configured gateway destination",
            ));
        }
        Ok(selected)
    }
    pub fn resolve(&self, request: &ResolveRequest) -> Result<ResolveResult, ResolveError> {
        let selected = self.selected_route_ids(request)?;
        let mut addresses = vec![];
        for id in &selected {
            let p = &self.pinned[*id];
            if let Some(error) = &p.error {
                return Err(error.clone());
            }
            for a in &p.guest {
                let family = if a.ip.is_ipv4() { 4 } else { 6 };
                if request.family != 0 && request.family != family {
                    continue;
                }
                let v = ResolvedAddress {
                    address: a.ip.to_string(),
                    family,
                    node: self.v6.get(a).copied(),
                    scope_id: (a.scope_id != 0).then_some(a.scope_id),
                };
                if !addresses.contains(&v) {
                    addresses.push(v)
                }
            }
        }
        if addresses.is_empty() {
            return Err(ResolveError::new(
                ResolveCode::NoData,
                "Configured gateway has no address in this family",
            ));
        }
        let route = &self.config.routes[selected[0]];
        Ok(ResolveResult {
            canonical_name: route.names.first().unwrap_or(&route.host).clone(),
            addresses,
        })
    }
    pub fn advertised_ipv4(&self) -> Vec<[u8; 4]> {
        let mut out = vec![];
        for p in &self.pinned {
            for a in &p.guest {
                if let IpAddr::V4(ip) = a.ip {
                    if !out.contains(&ip.octets()) {
                        out.push(ip.octets())
                    }
                }
            }
        }
        out
    }
    pub fn advertised_ipv6(&self) -> Vec<ResolvedAddress> {
        let mut out = vec![];
        for p in &self.pinned {
            for a in &p.guest {
                if a.ip.is_ipv6() {
                    let v = ResolvedAddress {
                        address: a.ip.to_string(),
                        family: 6,
                        node: self.v6.get(a).copied(),
                        scope_id: (a.scope_id != 0).then_some(a.scope_id),
                    };
                    if !out.contains(&v) {
                        out.push(v)
                    }
                }
            }
        }
        out
    }
}
