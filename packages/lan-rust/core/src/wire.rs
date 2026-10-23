//! Protocol derived from the Apache-2.0 BottleShip LAN reference; see the package NOTICE.
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
pub const VERSION: u8 = 1;
pub const SOCKET_PATH: &str = "/socket.io";
pub const MAX_FRAME_SIZE: usize = 65552;
pub const TCP_HEADER: usize = 20;
pub const TCP_WINDOW: u32 = 262144;
pub const TCP_SEGMENT: usize = 16384;
pub type Node = [u8; 6];
mod multicast4;
pub use multicast4::*;

#[derive(Debug, Clone, PartialEq)]
pub enum Arg {
    Json(Value),
    Binary(Bytes),
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireError(pub &'static str);
impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for WireError {}
pub fn number(value: &Value, max: u32) -> Option<u32> {
    let n = value.as_f64()?;
    if n.is_finite() && n >= 0.0 && n <= max as f64 && n.fract() == 0.0 {
        Some(n as u32)
    } else {
        None
    }
}
pub fn positive(value: &Value, max: u32) -> Option<u32> {
    number(value, max).filter(|n| *n > 0)
}
pub fn node(value: &Value) -> Option<Node> {
    let a = value.as_array()?;
    if a.len() != 6 {
        return None;
    }
    let mut n = [0; 6];
    for (i, v) in a.iter().enumerate() {
        n[i] = number(v, 255)? as u8;
    }
    Some(n)
}
pub fn lan_node(n: &Node) -> bool {
    n[0..3] == [2, 0, 0] && n[3..].iter().any(|v| *v != 0) && n[3..].iter().any(|v| *v != 255)
}
pub fn external_node(n: &Node) -> bool {
    n[0] == 2 && (n[1] == 1 || n[1] == 2)
}
pub fn broadcast(n: &Node) -> bool {
    *n == [255; 6]
}
pub fn tcp(proto: u8) -> bool {
    proto == 2 || proto == 5
}
pub fn raw(proto: u8) -> bool {
    proto == 6 || proto == 7
}
pub fn unreliable(proto: u8) -> bool {
    matches!(proto, 0 | 1 | 4 | 6 | 7)
}
pub fn max_payload(proto: u8) -> usize {
    match proto {
        0 => 548,
        4 => 65527,
        6 | 7 => 65540,
        _ => 65507,
    }
}
pub fn node_ipv4(n: &Node) -> [u8; 4] {
    if n[..2] == [2, 1] {
        [n[2], n[3], n[4], n[5]]
    } else {
        [10, n[3], n[4], n[5]]
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Datagram {
    pub proto: u8,
    pub node: Node,
    pub dst_port: u16,
    pub src_port: u16,
    pub payload: Bytes,
}
impl Datagram {
    pub fn decode(b: Bytes) -> Result<Self, WireError> {
        if b.len() < 12
            || b.len() > MAX_FRAME_SIZE
            || b[0] != 2
            || b[1] > 7
            || b.len() - 12 > max_payload(b[1])
        {
            return Err(WireError("Invalid LAN frame"));
        }
        let proto = b[1];
        let dst_port = u16::from_be_bytes([b[8], b[9]]);
        let src_port = u16::from_be_bytes([b[10], b[11]]);
        if dst_port == 0 || src_port == 0 || (proto == 0 && b.len() < 14) {
            return Err(WireError("Invalid datagram ports/payload"));
        }
        if raw(proto) {
            let p = &b[12..];
            if p.len() < 2 || p[1] & !3 != 0 || dst_port > 256 || src_port > 256 {
                return Err(WireError("Invalid RAW frame"));
            }
            let h = if p[1] & 2 != 0 { 5 } else { 2 };
            if p.len() < h || p.len() - h > 65535 {
                return Err(WireError("Invalid RAW size"));
            }
            if h == 5 {
                let ttl = i16::from_le_bytes([p[2], p[3]]);
                if !(-1..=255).contains(&ttl) {
                    return Err(WireError("Invalid RAW hop limit"));
                }
            }
        }
        let mut n = [0; 6];
        n.copy_from_slice(&b[2..8]);
        if is_multicast4_node(&n) {
            return Err(WireError("Multicast destination requires type3"));
        }
        Ok(Self {
            proto,
            node: n,
            dst_port,
            src_port,
            payload: b.slice(12..),
        })
    }
    pub fn encode(&self) -> Result<Bytes, WireError> {
        let mut v = Vec::with_capacity(12 + self.payload.len());
        v.extend_from_slice(&[2, self.proto]);
        v.extend_from_slice(&self.node);
        v.extend_from_slice(&self.dst_port.to_be_bytes());
        v.extend_from_slice(&self.src_port.to_be_bytes());
        v.extend_from_slice(&self.payload);
        let b = Bytes::from(v);
        Self::decode(b.clone())?;
        Ok(b)
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TcpFrame {
    pub kind: u32,
    pub src_id: u32,
    pub dst_id: u32,
    pub value: u32,
    pub data: Bytes,
}
impl TcpFrame {
    pub fn decode(b: Bytes) -> Result<Self, WireError> {
        if b.len() < 20 {
            return Err(WireError("Short TCP frame"));
        }
        let r = |i| u32::from_le_bytes(b[i..i + 4].try_into().unwrap());
        if r(0) != 0x31545342 || !(1..=8).contains(&r(4)) {
            return Err(WireError("Invalid TCP frame"));
        }
        Ok(Self {
            kind: r(4),
            src_id: r(8),
            dst_id: r(12),
            value: r(16),
            data: b.slice(20..),
        })
    }
    pub fn encode(&self) -> Bytes {
        let mut b = Vec::with_capacity(20 + self.data.len());
        for v in [0x31545342, self.kind, self.src_id, self.dst_id, self.value] {
            b.extend_from_slice(&v.to_le_bytes())
        }
        b.extend_from_slice(&self.data);
        b.into()
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinRequest {
    pub room: String,
    pub client_id: String,
    pub node: Node,
}
impl JoinRequest {
    pub fn decode(value: &Value) -> Result<Self, WireError> {
        let room = value
            .get("room")
            .and_then(Value::as_str)
            .ok_or(WireError("Invalid room"))?;
        let client = value
            .get("clientId")
            .and_then(Value::as_str)
            .ok_or(WireError("Invalid client identity"))?;
        let n = value
            .get("node")
            .and_then(node)
            .ok_or(WireError("Invalid LAN address"))?;
        if value.get("version").and_then(|v| number(v, 255)) != Some(1)
            || room.is_empty()
            || room.len() > 64
            || !room
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || !(16..=128).contains(&client.len())
            || !client
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || !lan_node(&n)
        {
            return Err(WireError("Invalid LAN handshake"));
        }
        Ok(Self {
            room: room.into(),
            client_id: client.into(),
            node: n,
        })
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveRequest {
    pub host: String,
    pub family: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reverse: Option<bool>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UdpLeaseRequest {
    pub proto: u8,
    pub local_port: u16,
    pub binding_generation: u32,
    pub node: Node,
    pub remote_port: u16,
}
impl UdpLeaseRequest {
    fn decode(v: &Value) -> Result<Self, WireError> {
        let fail = WireError("Invalid UDP peer request");
        let proto = v
            .get("proto")
            .and_then(|v| number(v, 7))
            .ok_or(fail.clone())? as u8;
        let local_port = v
            .get("localPort")
            .and_then(|v| positive(v, 65535))
            .ok_or(fail.clone())? as u16;
        let remote_port = v
            .get("remotePort")
            .and_then(|v| positive(v, 65535))
            .ok_or(fail.clone())? as u16;
        let binding_generation = v
            .get("bindingGeneration")
            .and_then(|v| positive(v, u32::MAX))
            .ok_or(fail.clone())?;
        let node = v.get("node").and_then(node).ok_or(fail.clone())?;
        if !matches!(proto, 1 | 4) || !external_node(&node) {
            return Err(fail);
        }
        Ok(Self {
            proto,
            local_port,
            remote_port,
            binding_generation,
            node,
        })
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UdpHostRequest {
    pub proto: u8,
    pub local_port: u16,
    pub binding_generation: u32,
    pub listener_id: String,
}
impl UdpHostRequest {
    fn decode(v: &Value) -> Result<Self, WireError> {
        let fail = WireError("Invalid UDP Host request");
        let proto = v
            .get("proto")
            .and_then(|v| number(v, 1))
            .filter(|v| *v == 1)
            .ok_or(fail.clone())? as u8;
        let local_port = v
            .get("localPort")
            .and_then(|v| positive(v, 65535))
            .ok_or(fail.clone())? as u16;
        let binding_generation = v
            .get("bindingGeneration")
            .and_then(|v| positive(v, u32::MAX))
            .ok_or(fail.clone())?;
        let id = v
            .get("listenerId")
            .and_then(Value::as_str)
            .ok_or(fail.clone())?;
        if id.is_empty()
            || id.len() > 64
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(fail);
        }
        Ok(Self {
            proto,
            local_port,
            binding_generation,
            listener_id: id.into(),
        })
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InboundEvent {
    Multicast4 {
        datagram: Multicast4Datagram,
        generation: Option<u32>,
    },
    Frame {
        datagram: Datagram,
        generation: Option<u32>,
    },
    OpenUdpHost {
        id: u32,
        request: UdpHostRequest,
    },
    CancelUdpHost {
        id: u32,
    },
    ReleaseUdpHost {
        id: u32,
    },
    ReleasePort {
        proto: u8,
        port: u16,
        generation: u32,
    },
    Resolve {
        id: u32,
        request: ResolveRequest,
    },
    CancelResolve {
        id: u32,
    },
    LeaseUdpPeer {
        id: u32,
        request: UdpLeaseRequest,
    },
    CancelUdpPeer {
        id: u32,
    },
    ReleaseUdpPeer {
        id: u32,
    },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    Fatal(WireError),
    Ignore,
    Lease { id: u32 },
    Host { id: u32 },
    Resolve { id: u32 },
}
fn json_arg(a: &Arg) -> Option<&Value> {
    if let Arg::Json(v) = a { Some(v) } else { None }
}
pub fn decode_event(name: &str, args: &[Arg]) -> Result<InboundEvent, DecodeError> {
    use DecodeError::*;
    let fail = || Fatal(WireError("Invalid event arguments"));
    let j = |i| args.get(i).and_then(json_arg);
    let id = || j(0).and_then(|v| positive(v, u32::MAX));
    match name {
        "frame" => {
            if args.is_empty() || args.len() > 2 {
                return Err(fail());
            }
            let b = match &args[0] {
                Arg::Binary(b) => b.clone(),
                _ => return Err(fail()),
            };
            let generation = if args.len() == 1 {
                None
            } else {
                Some(j(1).and_then(|v| positive(v, u32::MAX)).ok_or_else(fail)?)
            };
            if b.first() == Some(&WIRE_DGRAM_MULTICAST4) {
                Ok(InboundEvent::Multicast4 {
                    datagram: Multicast4Datagram::decode(b).map_err(Fatal)?,
                    generation,
                })
            } else {
                Ok(InboundEvent::Frame {
                    datagram: Datagram::decode(b).map_err(Fatal)?,
                    generation,
                })
            }
        }
        "releasePort" => {
            if args.len() != 3 {
                return Err(fail());
            }
            Ok(InboundEvent::ReleasePort {
                proto: j(0).and_then(|v| number(v, 7)).ok_or_else(fail)? as u8,
                port: j(1).and_then(|v| positive(v, 65535)).ok_or_else(fail)? as u16,
                generation: j(2).and_then(|v| positive(v, u32::MAX)).ok_or_else(fail)?,
            })
        }
        "openUdpHost" => {
            let id = id().ok_or_else(fail)?;
            if args.len() != 2 {
                return Err(Host { id });
            }
            Ok(InboundEvent::OpenUdpHost {
                id,
                request: UdpHostRequest::decode(j(1).ok_or(Host { id })?)
                    .map_err(|_| Host { id })?,
            })
        }
        "cancelUdpHost" | "releaseUdpHost" => {
            if args.len() != 1 {
                return Err(Ignore);
            }
            let id = id().ok_or(Ignore)?;
            Ok(if name == "cancelUdpHost" {
                InboundEvent::CancelUdpHost { id }
            } else {
                InboundEvent::ReleaseUdpHost { id }
            })
        }
        "leaseUdpPeer" => {
            let id = id().ok_or_else(fail)?;
            if args.len() != 2 {
                return Err(Lease { id });
            }
            Ok(InboundEvent::LeaseUdpPeer {
                id,
                request: UdpLeaseRequest::decode(j(1).ok_or(Lease { id })?)
                    .map_err(|_| Lease { id })?,
            })
        }
        "resolve" => {
            let id = id().ok_or(Ignore)?;
            let v = j(1).ok_or(Resolve { id })?;
            let host = v
                .get("host")
                .and_then(Value::as_str)
                .ok_or(Resolve { id })?;
            let family = v
                .get("family")
                .and_then(|v| number(v, 6))
                .filter(|v| matches!(v, 0 | 4 | 6))
                .ok_or(Resolve { id })? as u8;
            if args.len() != 2 || host.is_empty() || host.encode_utf16().count() > 253 {
                return Err(Resolve { id });
            }
            Ok(InboundEvent::Resolve {
                id,
                request: ResolveRequest {
                    host: host.into(),
                    family,
                    reverse: v.get("reverse").and_then(Value::as_bool),
                },
            })
        }
        "cancelResolve" | "cancelUdpPeer" | "releaseUdpPeer" => {
            if args.len() != 1 {
                return Err(Ignore);
            }
            let id = id().ok_or(Ignore)?;
            Ok(match name {
                "cancelResolve" => InboundEvent::CancelResolve { id },
                "cancelUdpPeer" => InboundEvent::CancelUdpPeer { id },
                _ => InboundEvent::ReleaseUdpPeer { id },
            })
        }
        _ => Err(Ignore),
    }
}
#[derive(Debug, Clone, PartialEq)]
pub enum ServerEvent {
    Json {
        name: &'static str,
        args: Vec<Value>,
    },
    Frame {
        bytes: Bytes,
        generation: Option<u32>,
    },
}
impl ServerEvent {
    pub fn name(&self) -> &str {
        match self {
            Self::Json { name, .. } => name,
            Self::Frame { .. } => "frame",
        }
    }
    pub fn args(&self) -> Vec<Arg> {
        match self {
            Self::Json { args, .. } => args.iter().cloned().map(Arg::Json).collect(),
            Self::Frame { bytes, generation } => {
                let mut a = vec![Arg::Binary(bytes.clone())];
                if let Some(g) = generation {
                    a.push(Arg::Json(json!(g)))
                }
                a
            }
        }
    }
    /// Logical payload budget. The transport must additionally bound its encoded engine/sink buffers.
    pub fn retained_bytes(&self) -> usize {
        match self {
            Self::Frame { bytes, .. } => bytes.len(),
            Self::Json { args, .. } => serde_json::to_vec(args).map_or(128, |v| v.len() + 32),
        }
    }
}
