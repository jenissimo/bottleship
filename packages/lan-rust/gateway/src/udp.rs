use crate::{
    Internal,
    udp_carrier::{Carrier as BoundUdp, Datagram as UdpDatagram, Ticket, helper_supported},
};
use bottleship_lan_core::{
    ConnId, GatewayEvent,
    gateway::{BindingToken, DestinationPolicy},
    routes::Target,
    wire::{Datagram, Node},
};
use bottleship_lan_native::{
    NativeError,
    udp::{UdpLosses, UdpPeerError},
};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::mpsc, task::JoinHandle, time::Instant};
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct FlowKey {
    pub binding: BindingToken,
    pub node: Node,
    pub remote_port: u16,
}
struct PolicyLease {
    policy: Arc<Mutex<DestinationPolicy>>,
    id: u64,
    closing: Option<BoundUdp>,
}
impl Drop for PolicyLease {
    fn drop(&mut self) {
        if let Some(handle) = self.closing.take() {
            if !handle.status().closed {
                let policy = self.policy.clone();
                let id = self.id;
                tokio::spawn(async move {
                    let _ = handle.wait_closed().await;
                    policy.lock().unwrap_or_else(|e| e.into_inner()).release(id);
                });
                return;
            }
        }
        self.policy
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .release(self.id)
    }
}
struct History {
    identity: (Node, u16),
    peer_id: u32,
    epoch: u32,
}
pub(crate) struct Flow {
    pub key: FlowKey,
    pub port: u64,
    pub peer_id: u32,
    pub epoch: u32,
    pub pins: usize,
    pub outbound: bool,
    pub seen: Instant,
    endpoint: SocketAddr,
    _policy: PolicyLease,
}
struct Physical {
    handle: BoundUdp,
    binding: BindingToken,
    family: u8,
    history: HashMap<SocketAddr, History>,
    losses: UdpLosses,
    forward: JoinHandle<()>,
}
impl Drop for Physical {
    fn drop(&mut self) {
        self.handle.abort();
        self.forward.abort();
    }
}
pub(crate) struct UdpPool {
    connection: ConnId,
    helper: Option<PathBuf>,
    limit: usize,
    timeout: Duration,
    policy: Arc<Mutex<DestinationPolicy>>,
    pub flows: HashMap<FlowKey, Flow>,
    ports: HashMap<u64, Physical>,
    next_port: u64,
    events: mpsc::Sender<Internal>,
}
fn normalize(endpoint: SocketAddr) -> SocketAddr {
    match endpoint {
        SocketAddr::V4(a) => SocketAddr::new(
            IpAddr::V4(if a.ip().is_unspecified() {
                Ipv4Addr::LOCALHOST
            } else {
                *a.ip()
            }),
            a.port(),
        ),
        SocketAddr::V6(a) if a.ip().is_unspecified() => {
            SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), a.port())
        }
        other => other,
    }
}
impl UdpPool {
    pub fn new(
        connection: ConnId,
        helper: Option<PathBuf>,
        limit: usize,
        timeout: Duration,
        policy: Arc<Mutex<DestinationPolicy>>,
        events: mpsc::Sender<Internal>,
    ) -> Self {
        Self {
            connection,
            helper,
            limit,
            timeout,
            policy,
            flows: HashMap::new(),
            ports: HashMap::new(),
            next_port: 0,
            events,
        }
    }
    pub async fn ensure(&mut self, key: FlowKey, target: &Target) -> Result<bool, NativeError> {
        if self.flows.contains_key(&key) {
            return Ok(false);
        }
        if self.flows.len() >= self.limit {
            return Err(NativeError::new(10055, "native UDP flow limit reached"));
        }
        let endpoint = normalize(target.address.socket_addr(target.port));
        let family = if endpoint.is_ipv4() { 4 } else { 6 };
        let use_helper = self.helper.is_some() && helper_supported(endpoint);
        let lease = self
            .policy
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .acquire(&target.canonical_policy_key, self.connection, false)
            .ok_or_else(|| NativeError::new(10048, "native destination has an exclusive owner"))?;
        let mut policy = PolicyLease {
            policy: self.policy.clone(),
            id: lease,
            closing: None,
        };
        let identity = (key.node, key.remote_port);
        let existing = self
            .ports
            .iter()
            .find(|(_, p)| {
                p.binding == key.binding
                    && p.family == family
                    && p.handle.is_helper() == use_helper
                    && p.history
                        .get(&endpoint)
                        .is_none_or(|h| h.identity == identity)
                    && (p.history.contains_key(&endpoint) || p.history.len() < 128)
            })
            .map(|(id, _)| *id);
        let port = if let Some(port) = existing {
            port
        } else {
            let path = if use_helper {
                self.helper.as_deref()
            } else {
                None
            };
            let (handle, mut native) = BoundUdp::start(path, family, self.timeout)?;
            let Some(port) = self.next_port.checked_add(1) else {
                handle.abort();
                let _ = handle.wait_closed().await;
                return Err(NativeError::new(10055, "native port identity exhausted"));
            };
            self.next_port = port;
            let tx = self.events.clone();
            let observer = handle.clone();
            let forward = tokio::spawn(async move {
                let mut reads_open = true;
                let mut errors_open = true;
                let mut losses_open = true;
                loop {
                    tokio::select! {
                     value=native.datagrams.recv(),if reads_open=>match value{Some(datagram)=>if tx.send(Internal::UdpReceive{port,datagram}).await.is_err(){break},None=>reads_open=false},
                     value=native.errors.recv(),if errors_open=>match value{Some(error)=>if tx.send(Internal::UdpError{port,error}).await.is_err(){break},None=>errors_open=false},
                     changed=native.losses.changed(),if losses_open=>{if changed.is_ok(){let losses=*native.losses.borrow_and_update();if tx.send(Internal::UdpLosses{port,losses}).await.is_err(){break}}else{losses_open=false}},
                     result=observer.wait_closed()=>{let losses=*native.losses.borrow_and_update();let _=tx.send(Internal::UdpLosses{port,losses}).await;let error=result.err().unwrap_or_else(||NativeError::new(10050,"native UDP binding closed"));let _=tx.send(Internal::UdpClosed{port,error}).await;break}
                    }
                }
            });
            self.ports.insert(
                port,
                Physical {
                    handle,
                    binding: key.binding,
                    family,
                    history: HashMap::new(),
                    losses: UdpLosses::default(),
                    forward,
                },
            );
            port
        };
        let physical = self.ports.get_mut(&port).unwrap();
        let (peer_id, epoch) = if let Some(h) = physical.history.get(&endpoint) {
            (
                h.peer_id,
                h.epoch
                    .checked_add(1)
                    .ok_or_else(|| NativeError::new(10055, "native peer epoch exhausted"))?,
            )
        } else {
            ((physical.history.len() + 1) as u32, 1)
        };
        // Preserve the tuple tombstone even if registration subsequently fails.
        physical.history.insert(
            endpoint,
            History {
                identity,
                peer_id,
                epoch,
            },
        );
        let handle = physical.handle.clone();
        policy.closing = Some(handle.clone());
        if let Err(error) = handle.when_ready().await {
            handle.abort();
            let _ = handle.wait_closed().await;
            self.ports.remove(&port);
            return Err(error);
        }
        if let Err(error) = handle.register_peer(peer_id, epoch, endpoint).await {
            if !self.flows.values().any(|f| f.port == port) {
                if let Some(p) = self.ports.remove(&port) {
                    p.handle.abort();
                    let _ = p.handle.wait_closed().await;
                }
            }
            return Err(error);
        }
        policy.closing = None;
        self.flows.insert(
            key,
            Flow {
                key,
                port,
                peer_id,
                epoch,
                pins: 0,
                outbound: false,
                seen: Instant::now(),
                endpoint,
                _policy: policy,
            },
        );
        Ok(true)
    }
    pub fn send(&mut self, key: &FlowKey, payload: &[u8]) -> Result<Ticket, NativeError> {
        let flow = self
            .flows
            .get_mut(key)
            .ok_or_else(|| NativeError::new(10057, "native UDP flow closed"))?;
        let port = self
            .ports
            .get(&flow.port)
            .ok_or_else(|| NativeError::new(10050, "native UDP binding closed"))?;
        let ticket = port.handle.try_send(flow.peer_id, flow.epoch, payload)?;
        flow.outbound = true;
        flow.seen = Instant::now();
        Ok(ticket)
    }
    pub fn receive(&mut self, port: u64, datagram: &UdpDatagram) -> Option<GatewayEvent> {
        let flow = self.flows.values_mut().find(|f| {
            f.port == port
                && f.peer_id == datagram.peer_id
                && f.epoch == datagram.epoch
                && f.endpoint == datagram.endpoint
        })?;
        flow.seen = Instant::now();
        Some(GatewayEvent::Frame {
            binding: flow.key.binding,
            datagram: Datagram {
                proto: flow.key.binding.proto,
                node: flow.key.node,
                dst_port: flow.key.binding.local_port,
                src_port: flow.key.remote_port,
                payload: datagram.bytes.clone(),
            },
        })
    }
    pub fn peer_error(&self, port: u64, error: &UdpPeerError) -> Option<GatewayEvent> {
        if error.code == 0 {
            return None;
        }
        let flow = self
            .flows
            .values()
            .find(|f| f.port == port && f.peer_id == error.peer_id && f.epoch == error.epoch)?;
        Some(GatewayEvent::SocketError {
            binding: flow.key.binding,
            node: flow.key.node,
            remote_port: flow.key.remote_port,
            code: error.code,
            wire_id: None,
        })
    }
    pub async fn remove(&mut self, key: &FlowKey) {
        let Some(mut flow) = self.flows.remove(key) else {
            return;
        };
        let Some(port) = self.ports.get(&flow.port) else {
            return;
        };
        let handle = port.handle.clone();
        if self.flows.values().any(|other| other.port == flow.port) {
            if handle.retire_peer(flow.peer_id, flow.epoch).await.is_err() {
                handle.abort();
            }
        } else {
            flow._policy.closing = Some(handle.clone());
            let _ = handle.close().await;
            self.ports.remove(&flow.port);
        }
        flow._policy.closing = None;
        // Policy lease lives through native retire/physical close.
        drop(flow);
    }
    pub async fn port_closed(&mut self, port: u64, error: NativeError) -> Vec<GatewayEvent> {
        self.ports.remove(&port);
        let keys: Vec<_> = self
            .flows
            .iter()
            .filter(|(_, f)| f.port == port)
            .map(|(k, _)| *k)
            .collect();
        let mut out = vec![];
        for key in keys {
            if let Some(flow) = self.flows.remove(&key) {
                out.push(GatewayEvent::SocketError {
                    binding: flow.key.binding,
                    node: flow.key.node,
                    remote_port: flow.key.remote_port,
                    code: error.code,
                    wire_id: None,
                })
            }
        }
        out
    }
    pub fn losses(&mut self, port: u64, losses: UdpLosses) -> UdpLosses {
        let Some(physical) = self.ports.get_mut(&port) else {
            return UdpLosses::default();
        };
        let previous = physical.losses;
        physical.losses = losses;
        UdpLosses {
            rx_packets: losses.rx_packets.saturating_sub(previous.rx_packets),
            rx_bytes: losses.rx_bytes.saturating_sub(previous.rx_bytes),
            error_records: losses.error_records.saturating_sub(previous.error_records),
            unattributed_errors: losses
                .unattributed_errors
                .saturating_sub(previous.unattributed_errors),
        }
    }
    pub fn abort(&self) {
        for p in self.ports.values() {
            p.handle.abort();
        }
    }
    pub async fn close(&mut self) {
        self.abort();
        let ports = std::mem::take(&mut self.ports);
        for (_, port) in ports {
            let _ = port.handle.wait_closed().await;
        }
        self.flows.clear();
    }
}
