//! Physically bound Host listeners, separate from v1 exact-peer UDP permissions.
use crate::Internal;
use bottleship_lan_core::{
    ConnId, GatewayEvent,
    config::UdpListenerConfig,
    gateway::{BindingToken, DestinationPolicy},
    wire::{Datagram, Node},
};
use bottleship_lan_native::{
    NativeError,
    listener::{
        ListenerConfig, ListenerDatagram, ListenerLosses, ListenerTicket, NativeUdpListener,
    },
};
use std::{
    collections::HashMap,
    net::{Ipv4Addr, SocketAddrV4},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};
struct Flow {
    binding: BindingToken,
    handle: NativeUdpListener,
    forward: JoinHandle<()>,
    status: watch::Receiver<bottleship_lan_native::listener::ListenerStatus>,
    policy: Arc<Mutex<DestinationPolicy>>,
    leases: Vec<u64>,
    losses: ListenerLosses,
}
impl Drop for Flow {
    fn drop(&mut self) {
        self.handle.abort();
        self.forward.abort();
        let leases = std::mem::take(&mut self.leases);
        let p = self.policy.clone();
        if self.status.borrow().closed {
            let mut p = p.lock().unwrap_or_else(|e| e.into_inner());
            for id in leases {
                p.release(id);
            }
        } else {
            let h = self.handle.clone();
            tokio::spawn(async move {
                let _ = h.wait_closed().await;
                let mut p = p.lock().unwrap_or_else(|e| e.into_inner());
                for id in leases {
                    p.release(id);
                }
            });
        }
    }
}
pub(crate) struct HostPool {
    connection: ConnId,
    timeout: Duration,
    policy: Arc<Mutex<DestinationPolicy>>,
    events: mpsc::Sender<Internal>,
    flows: HashMap<u64, Flow>,
    next: u64,
}
impl HostPool {
    pub fn new(
        connection: ConnId,
        timeout: Duration,
        policy: Arc<Mutex<DestinationPolicy>>,
        events: mpsc::Sender<Internal>,
    ) -> Self {
        Self {
            connection,
            timeout,
            policy,
            events,
            flows: HashMap::new(),
            next: 0,
        }
    }
    pub async fn open(
        &mut self,
        binding: BindingToken,
        listener: UdpListenerConfig,
    ) -> Result<(u64, Node, u16), NativeError> {
        listener
            .validate()
            .map_err(|_| NativeError::new(10022, "invalid Host listener policy"))?;
        if binding.proto != 1 || self.flows.values().any(|f| f.binding == binding) {
            return Err(NativeError::new(
                10048,
                "UDP binding already has a Host listener",
            ));
        }
        if self.flows.len() >= 32 {
            return Err(NativeError::new(10055, "Host listener limit reached"));
        }
        let id = self
            .next
            .checked_add(1)
            .ok_or_else(|| NativeError::new(10055, "Host listener identity exhausted"))?;
        self.next = id;
        let leases = {
            let mut p = self.policy.lock().unwrap_or_else(|e| e.into_inner());
            let host = p
                .acquire_host_listener(&listener.id, self.connection, listener.max_owners)
                .ok_or_else(|| {
                    NativeError::new(10048, "configured Host listener owner limit reached")
                })?;
            let mut leases = vec![host];
            for host in &listener.allowed_hosts {
                match p.acquire(host, self.connection, false) {
                    Some(id) => leases.push(id),
                    None => {
                        for id in leases {
                            p.release(id)
                        }
                        return Err(NativeError::new(
                            10048,
                            "Host source policy conflicts with native raw owner",
                        ));
                    }
                }
            }
            leases
        };
        let cfg = ListenerConfig {
            bind: SocketAddrV4::new(listener.bind_host.parse().unwrap(), listener.port),
            advertised_ip: listener.advertised_host.parse().unwrap(),
            allowed_hosts: listener
                .allowed_hosts
                .iter()
                .map(|a| a.parse().unwrap())
                .collect(),
            max_peers: listener.max_peers,
            idle_timeout: Duration::from_millis(listener.idle_timeout_ms),
            startup_timeout: self.timeout,
            send_timeout: self.timeout,
            tx_records: 256,
            tx_bytes: 262144,
            rx_records: 256,
            rx_bytes: 262144,
        };
        let (handle, mut native) = match NativeUdpListener::start(cfg) {
            Ok(v) => v,
            Err(e) => {
                let mut p = self.policy.lock().unwrap_or_else(|e| e.into_inner());
                for id in leases {
                    p.release(id)
                }
                return Err(e);
            }
        };
        let h = handle.clone();
        let tx = self.events.clone();
        let status = native.status.clone();
        let forward = tokio::spawn(async move {
            // Waiting here does not publish an ingress packet ahead of the actor's
            // HostReady result; the actor is inside open until that control is admitted.
            let mut packets_open = true;
            let mut losses_open = true;
            loop {
                tokio::select! {
                 packet=native.datagrams.recv(),if packets_open=>match packet{Some(packet)=>if tx.send(Internal::HostRead{id,packet}).await.is_err(){break},None=>packets_open=false},
                 changed=native.losses.changed(),if losses_open=>{if changed.is_err(){losses_open=false}else{let loss=*native.losses.borrow_and_update();if tx.send(Internal::HostLoss{id,loss}).await.is_err(){break}}},
                 changed=native.status.changed()=>{if changed.is_err(){break}let s=native.status.borrow_and_update().clone();if s.closed{let _=tx.send(Internal::HostClosed{id,code:s.error.map_or(10054,|e|e.code)}).await;break}}
                }
            }
        });
        self.flows.insert(
            id,
            Flow {
                binding,
                handle: h,
                forward,
                status,
                policy: self.policy.clone(),
                leases,
                losses: ListenerLosses::default(),
            },
        );
        match handle.when_ready().await {
            Ok(ready) => {
                let ip = ready.advertised.ip().octets();
                Ok((
                    id,
                    [2, 1, ip[0], ip[1], ip[2], ip[3]],
                    ready.advertised.port(),
                ))
            }
            Err(error) => {
                self.remove(id).await;
                Err(error)
            }
        }
    }
    pub fn send(
        &self,
        id: u64,
        binding: BindingToken,
        d: &Datagram,
    ) -> Result<ListenerTicket, NativeError> {
        let flow = self
            .flows
            .get(&id)
            .filter(|f| f.binding == binding)
            .ok_or_else(|| NativeError::new(10057, "Host listener lease is no longer live"))?;
        if d.proto != 1 || d.node[..2] != [2, 1] || d.dst_port == 0 {
            return Err(NativeError::new(10013, "invalid Host destination"));
        }
        let endpoint = SocketAddrV4::new(
            Ipv4Addr::new(d.node[2], d.node[3], d.node[4], d.node[5]),
            d.dst_port,
        );
        let peer = flow.handle.peer_for_endpoint(endpoint).ok_or_else(|| {
            NativeError::new(10013, "Host destination has not sent an authorized packet")
        })?;
        flow.handle.try_send(peer, &d.payload)
    }
    pub fn receive(&self, id: u64, packet: &ListenerDatagram) -> Option<GatewayEvent> {
        let flow = self.flows.get(&id)?;
        let ip = packet.peer.endpoint.ip().octets();
        Some(GatewayEvent::HostFrame {
            lease_id: id,
            binding: flow.binding,
            datagram: Datagram {
                proto: 1,
                node: [2, 1, ip[0], ip[1], ip[2], ip[3]],
                src_port: packet.peer.endpoint.port(),
                dst_port: flow.binding.local_port,
                payload: packet.bytes.clone(),
            },
        })
    }
    pub fn loss(&mut self, id: u64, loss: ListenerLosses) -> Option<ListenerLosses> {
        let flow = self.flows.get_mut(&id)?;
        let old = flow.losses;
        flow.losses = loss;
        Some(ListenerLosses {
            rx_packets: loss.rx_packets.saturating_sub(old.rx_packets),
            rx_bytes: loss.rx_bytes.saturating_sub(old.rx_bytes),
            unauthorized_packets: loss
                .unauthorized_packets
                .saturating_sub(old.unauthorized_packets),
            peer_limit_packets: loss
                .peer_limit_packets
                .saturating_sub(old.peer_limit_packets),
            expired_peers: loss.expired_peers.saturating_sub(old.expired_peers),
            unattributed_errors: loss
                .unattributed_errors
                .saturating_sub(old.unattributed_errors),
        })
    }
    pub async fn failed(&mut self, id: u64, code: u32) -> Option<GatewayEvent> {
        if !self.flows.contains_key(&id) {
            return None;
        }
        self.remove(id).await;
        Some(GatewayEvent::HostClosed { lease_id: id, code })
    }
    pub async fn remove(&mut self, id: u64) {
        if let Some(f) = self.flows.remove(&id) {
            f.handle.abort();
            let _ = f.handle.wait_closed().await;
            drop(f);
        }
    }
    pub async fn release_port(&mut self, proto: u8, port: u16, g: u32) {
        let ids: Vec<_> = self
            .flows
            .iter()
            .filter(|(_, f)| {
                f.binding.proto == proto
                    && f.binding.local_port == port
                    && f.binding.generation.is_none_or(|old| old <= g)
            })
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            self.remove(id).await
        }
    }
    pub async fn cancel_binding(&mut self, b: BindingToken) {
        let ids: Vec<_> = self
            .flows
            .iter()
            .filter(|(_, f)| f.binding == b)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            self.remove(id).await
        }
    }
    pub fn is_live(&self, id: u64, binding: BindingToken) -> bool {
        self.flows.get(&id).is_some_and(|f| f.binding == binding)
    }
    pub fn len(&self) -> usize {
        self.flows.len()
    }
    pub fn abort(&self) {
        for f in self.flows.values() {
            f.handle.abort();
        }
    }
    pub async fn close(&mut self) {
        self.abort();
        let ids: Vec<_> = self.flows.keys().copied().collect();
        for id in ids {
            self.remove(id).await
        }
    }
}
