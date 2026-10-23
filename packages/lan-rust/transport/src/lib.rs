//! Bounded Socket.IO v5 / Engine.IO v4 adapter. Core policy runs in the caller.
mod budget;
mod codec;
mod runtime;
pub use bottleship_lan_core::ConnId;
use bottleship_lan_core::wire::{Arg, ServerEvent};
pub use budget::Usage;
pub use runtime::{BoundTransport, CloseReceipt, DeliveryTicket, TransportHandle, bind};
use std::{net::SocketAddr, time::Duration};
use tokio::sync::{mpsc, oneshot};
#[derive(Clone, Debug)]
pub struct Config {
    /// Optional caller-owned /health JSON body (at most 4096 bytes).
    pub health_response: Option<bytes::Bytes>,
    pub max_connections: usize,
    pub max_tcp_connections: usize,
    pub max_sessions_per_tcp: usize,
    pub max_requests_per_session: usize,
    pub ingress_records: usize,
    pub ingress_bytes: usize,
    pub global_ingress_records: usize,
    pub global_ingress_bytes: usize,
    pub output_records: usize,
    pub output_bytes: usize,
    pub encoded_output_bytes: usize,
    pub global_output_records: usize,
    pub global_output_bytes: usize,
    pub authorization_timeout: Duration,
    pub binary_timeout: Duration,
    pub header_timeout: Duration,
    pub ping_interval: Duration,
    pub ping_timeout: Duration,
    pub allow_polling: bool,
    pub allow_websocket: bool,
    /// Empty list allows absent Origin only. "*" is an explicit opt-in.
    pub origins: Vec<String>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            health_response: None,
            max_connections: 256,
            max_tcp_connections: 1024,
            max_sessions_per_tcp: 1,
            max_requests_per_session: 8,
            ingress_records: 64,
            ingress_bytes: 1048576,
            global_ingress_records: 4096,
            global_ingress_bytes: 67108864,
            output_records: 64,
            output_bytes: 1048576,
            encoded_output_bytes: 1500000,
            global_output_records: 8192,
            global_output_bytes: 134217728,
            authorization_timeout: Duration::from_secs(5),
            binary_timeout: Duration::from_secs(5),
            header_timeout: Duration::from_secs(5),
            ping_interval: Duration::from_secs(25),
            ping_timeout: Duration::from_secs(20),
            allow_polling: true,
            allow_websocket: true,
            origins: vec![],
        }
    }
}
#[derive(Clone, Debug)]
pub struct RequestMeta {
    pub peer: SocketAddr,
    pub origin: Option<String>,
}
#[derive(Debug)]
pub enum IncomingKind {
    Authorize {
        auth: serde_json::Value,
        request: RequestMeta,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Namespace connect ACK has been accepted ahead of all subsequent outputs.
    Activated,
    Message {
        sequence: u64,
        name: String,
        args: Vec<Arg>,
    },
    Closed {
        reason: String,
    },
}
#[derive(Debug)]
pub struct Incoming {
    pub connection: ConnId,
    pub kind: IncomingKind,
    // Kept until caller has consumed/decoded the item; dropping releases admission.
    pub(crate) lease: Option<budget::Leases>,
    pub(crate) _hold: Option<std::sync::Arc<budget::Leases>>,
}
impl Incoming {
    pub fn retained_usage(&self) -> Usage {
        self.lease
            .as_ref()
            .map(|v| {
                v.0.iter().step_by(2).fold(Usage::default(), |mut used, l| {
                    let amount = l.amount();
                    used.records += amount.records;
                    used.bytes += amount.bytes;
                    used
                })
            })
            .unwrap_or_default()
    }
}
pub type IncomingReceiver = mpsc::Receiver<Incoming>;
#[derive(Debug)]
pub struct Egress {
    pub recipient: ConnId,
    pub event: ServerEvent,
    pub retained_bytes: usize,
    pub reliable: bool,
    pub sender: Option<ConnId>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputRejected {
    pub recipient: ConnId,
    pub sender: Option<ConnId>,
    pub reliable: bool,
    pub reason: &'static str,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Metrics {
    pub sessions: usize,
    pub tcp_connections: usize,
    pub ingress: Usage,
    pub output: Usage,
}
