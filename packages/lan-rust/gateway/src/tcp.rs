use crate::{Internal, budget::Permit, tcp_accept::{PendingTcpAccepts, TcpIds}};
use bottleship_lan_core::{
    ConnId, GatewayEvent,
    gateway::{BindingToken, DestinationPolicy},
    routes::Target,
    wire::{Datagram, Node, TCP_SEGMENT, TCP_WINDOW, TcpFrame},
};
use bottleship_lan_native::{
    NativeError,
    tcp::{NativeTcp, TcpEvents, TcpOption, TcpOptions, TcpRead, TcpStatus},
    tcp_listener::AcceptedTcp,
    tcp_quota::{TcpQuota, TcpQuotaPermit},
};
use bytes::Bytes;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::mpsc,
    task::{JoinHandle, JoinSet},
};
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct TcpKey {
    pub binding: BindingToken,
    pub node: Node,
    pub remote_port: u16,
    pub client_id: u32,
}
pub(crate) type Connecting = Arc<Mutex<HashMap<TcpKey, NativeTcp>>>;
pub(crate) struct Delivery {
    pub event: GatewayEvent,
    pub guard: Option<Box<dyn Send>>,
}
struct PendingRead {
    read: Arc<TcpRead>,
    offset: usize,
}
struct Flow {
    key: TcpKey,
    handle: NativeTcp,
    server_id: u32,
    remote_credit: u32,
    write_credit: u32,
    pending: VecDeque<PendingRead>,
    sent_fin: bool,
    received_fin: bool,
    remote_eof: bool,
    write_finished: bool,
    released: bool,
    native_closed: bool,
    forward: JoinHandle<()>,
    policy: Arc<Mutex<DestinationPolicy>>,
    policy_id: u64,
    permit: Option<TcpQuotaPermit>,
}
impl Drop for Flow {
    fn drop(&mut self) {
        self.handle.abort();
        self.forward.abort();
        let permit = self.permit.take();
        if self.handle.status().closed {
            self.policy
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .release(self.policy_id);
        } else {
            let handle = self.handle.clone();
            let policy = self.policy.clone();
            let id = self.policy_id;
            tokio::spawn(async move {
                let _ = handle.wait_closed().await;
                policy.lock().unwrap_or_else(|e| e.into_inner()).release(id);
                drop(permit);
            });
        }
    }
}
pub(crate) struct TcpPool {
    connection: ConnId,
    limit: usize,
    helper: Option<std::path::PathBuf>,
    timeout: Duration,
    policy: Arc<Mutex<DestinationPolicy>>,
    flows: HashMap<TcpKey, Flow>,
    ids: Arc<TcpIds>,
    pub(crate) quota: Arc<TcpQuota>,
    pub(crate) inbound: PendingTcpAccepts,
    events: mpsc::Sender<Internal>,
    connecting: Connecting,
    tasks: JoinSet<()>,
}
impl TcpPool {
    pub fn new(
        connection: ConnId,
        limit: usize,
        helper: Option<std::path::PathBuf>,
        timeout: Duration,
        policy: Arc<Mutex<DestinationPolicy>>,
        events: mpsc::Sender<Internal>,
        connecting: Connecting,
    ) -> Self {
        let ids = Arc::new(TcpIds::default());
        Self {
            connection,
            limit,
            helper,
            timeout,
            policy,
            flows: HashMap::new(),
            inbound: PendingTcpAccepts::new(ids.clone(), limit, timeout),
            ids,
            quota: TcpQuota::new(limit),
            events,
            connecting,
            tasks: JoinSet::new(),
        }
    }
    /// Reserve a pending slot from the same total capacity as outbound flows.
    /// The caller owns and validates the active listener lease and its source ACL.
    pub(crate) fn admit_inbound(&mut self, accepted: AcceptedTcp, binding: BindingToken) -> Result<Datagram, NativeError> {
        self.inbound.sweep();
        if self.flows.len() + self.inbound.len() >= self.limit {
            return Err(NativeError::new(10055, "TCP flow limit reached"));
        }
        self.inbound.admit(accepted, binding)
    }

    /// Consume a matched SYNACK and hand the original stream to the normal TCP actor.
    /// The supplied epoch must belong to the current, externally validated listener.
    pub(crate) fn establish_inbound(&mut self, binding: BindingToken, epoch: u64, datagram: &Datagram) -> Result<Option<TcpKey>, NativeError> {
        let Some(accepted) = self.inbound.synack(binding, epoch, datagram) else { return Ok(None); };
        let key = TcpKey { binding, node: accepted.peer_node, remote_port: accepted.peer_port, client_id: accepted.guest_id };
        if self.flows.len() >= self.limit || self.flows.contains_key(&key) {
            return Err(NativeError::new(10055, "TCP flow capacity or identity conflict"));
        }
        if accepted.guest_options & 0x80000000 != 0 {
            return Err(NativeError::new(10045, "inline urgent data requires an accepted-socket helper"));
        }
        let peer = std::net::Ipv4Addr::new(key.node[2], key.node[3], key.node[4], key.node[5]).to_string();
        let policy_id = self.policy.lock().unwrap_or_else(|e| e.into_inner())
            .acquire(&peer, self.connection, false)
            .ok_or_else(|| NativeError::new(10048, "inbound TCP source policy conflict"))?;
        let options = TcpOptions {
            helper: None,
            inline: false,
            keep_alive: accepted.guest_options & 0x40000000 != 0,
            no_delay: accepted.guest_options & 0x20000000 != 0,
            timeout: self.timeout,
        };
        let (handle, native) = match NativeTcp::from_accepted(accepted.stream, options) {
            Ok(value) => value,
            Err(error) => {
                self.policy.lock().unwrap_or_else(|e| e.into_inner()).release(policy_id);
                return Err(error);
            }
        };
        let forward = self.forward(key, accepted.native_id, &handle, native);
        self.connecting.lock().unwrap_or_else(|e| e.into_inner()).insert(key, handle.clone());
        self.flows.insert(key, Flow {
            key, handle, server_id: accepted.native_id, remote_credit: accepted.guest_credit, write_credit: TCP_WINDOW,
            pending: VecDeque::new(), sent_fin: false, received_fin: false, remote_eof: false,
            write_finished: false, released: false, native_closed: false, forward,
            policy: self.policy.clone(), policy_id, permit: accepted.permit,
        });
        Ok(Some(key))
    }

    fn forward(&self, key: TcpKey, server_id: u32, handle: &NativeTcp, mut native: TcpEvents) -> JoinHandle<()> {
        let tx = self.events.clone();
        let mut status = handle.subscribe();
        tokio::spawn(async move {
            let mut reads_open = true;
            let mut eof_sent = false;
            let mut initial = true;
            loop {
                tokio::select! {
                 read=native.reads.recv(),if reads_open=>match read{Some(read)=>if tx.send(Internal::TcpRead{key,server_id,read}).await.is_err(){break},None=>reads_open=false},
                 changed=async { if initial { Ok(()) } else { status.changed().await } }=>{
                  initial = false;
                  if changed.is_err(){break}let current=status.borrow_and_update().clone();
                  if current.remote_eof||current.closed{
                   while let Ok(read)=native.reads.try_recv(){if tx.send(Internal::TcpRead{key,server_id,read}).await.is_err(){return}}
                   if current.remote_eof&&!eof_sent{eof_sent=true;if tx.send(Internal::TcpEof{key,server_id}).await.is_err(){break}}
                  }
                  if current.closed{let _=tx.send(Internal::TcpClosed{key,server_id,status:current}).await;break}
                 }
                }
            }
        })
    }

    fn packet(
        flow: &Flow,
        kind: u32,
        value: u32,
        data: Bytes,
        guard: Option<Box<dyn Send>>,
    ) -> Option<Delivery> {
        if flow.released {
            return None;
        }
        Some(Self::packet_for(
            flow.key,
            flow.server_id,
            kind,
            value,
            data,
            guard,
        ))
    }
    fn packet_for(
        key: TcpKey,
        server_id: u32,
        kind: u32,
        value: u32,
        data: Bytes,
        guard: Option<Box<dyn Send>>,
    ) -> Delivery {
        Delivery {
            event: GatewayEvent::Frame {
                binding: key.binding,
                datagram: Datagram {
                    proto: key.binding.proto,
                    node: key.node,
                    dst_port: key.binding.local_port,
                    src_port: key.remote_port,
                    payload: TcpFrame {
                        kind,
                        src_id: server_id,
                        dst_id: key.client_id,
                        value,
                        data,
                    }
                    .encode(),
                },
            },
            guard,
        }
    }
    async fn remove(&mut self, key: &TcpKey) {
        self.connecting
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(key);
        if let Some(flow) = self.flows.remove(key) {
            flow.handle.abort();
            let _ = flow.handle.wait_closed().await;
            drop(flow);
        }
    }
    async fn abort_flow(&mut self, key: &TcpKey, code: u32) -> Vec<Delivery> {
        let packet = self
            .flows
            .get(key)
            .and_then(|flow| Self::packet(flow, 5, code, Bytes::new(), None));
        self.remove(key).await;
        packet.into_iter().collect()
    }
    pub async fn process(
        &mut self,
        d: Datagram,
        binding: BindingToken,
        target: Target,
        permit: Permit,
    ) -> Result<Vec<Delivery>, NativeError> {
        while self.tasks.try_join_next().is_some() {}
        let p = match TcpFrame::decode(d.payload) {
            Ok(p) if p.src_id != 0 => p,
            _ => return Ok(vec![]),
        };
        let key = TcpKey {
            binding,
            node: d.node,
            remote_port: d.dst_port,
            client_id: p.src_id,
        };
        if p.kind == 1 && p.dst_id == 0 {
            if let Some(flow) = self.flows.get(&key) {
                return Ok(Self::packet(flow, 2, TCP_WINDOW, Bytes::new(), None)
                    .into_iter()
                    .collect());
            }
            self.inbound.sweep();
            if self.flows.len() + self.inbound.len() >= self.limit {
                return Ok(vec![Self::packet_for(key, 0, 5, 10055, Bytes::new(), None)]);
            }
            let permit_slot = match self.quota.try_acquire() {
                Some(permit) => permit,
                None => return Ok(vec![Self::packet_for(key, 0, 5, 10055, Bytes::new(), None)]),
            };
            let server_id = match self.ids.next() {
                Ok(id) => id,
                Err(_) => return Ok(vec![Self::packet_for(key, 0, 5, 10055, Bytes::new(), None)]),
            };
            let policy_id = match self
                .policy
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .acquire(&target.canonical_policy_key, self.connection, false)
            {
                Some(id) => id,
                None => return Ok(vec![Self::packet_for(key, 0, 5, 10048, Bytes::new(), None)]),
            };
            let options = TcpOptions {
                helper: self.helper.clone(),
                inline: p.value & 0x80000000 != 0,
                keep_alive: p.value & 0x40000000 != 0,
                no_delay: p.value & 0x20000000 != 0,
                timeout: self.timeout,
            };
            let (handle, native) =
                match NativeTcp::start(target.address.socket_addr(target.port), options) {
                    Ok(result) => result,
                    Err(error) => {
                        self.policy
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .release(policy_id);
                        return Ok(vec![Self::packet_for(
                            key,
                            0,
                            5,
                            error.code,
                            Bytes::new(),
                            None,
                        )]);
                    }
                };
            let forward = self.forward(key, server_id, &handle, native);
            self.connecting
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(key, handle.clone());
            self.flows.insert(
                key,
                Flow {
                    key,
                    handle: handle.clone(),
                    server_id,
                    remote_credit: (p.value & 0x1fffffff).min(TCP_WINDOW),
                    write_credit: TCP_WINDOW,
                    pending: VecDeque::new(),
                    sent_fin: false,
                    received_fin: false,
                    remote_eof: false,
                    write_finished: false,
                    released: false,
                    native_closed: false,
                    forward,
                    policy: self.policy.clone(),
                    policy_id,
                    permit: Some(permit_slot),
                },
            );
            if let Err(error) = handle.when_connected().await {
                return Ok(self.abort_flow(&key, error.code).await);
            }
            return Ok(Self::packet(
                self.flows.get(&key).unwrap(),
                2,
                TCP_WINDOW,
                Bytes::new(),
                None,
            )
            .into_iter()
            .collect());
        }
        let Some(flow) = self.flows.get_mut(&key) else {
            return Ok(vec![]);
        };
        if p.kind == 5 && (p.dst_id == 0 || p.dst_id == flow.server_id) {
            self.remove(&key).await;
            return Ok(vec![]);
        }
        if p.dst_id != flow.server_id && !(p.kind == 8 && p.dst_id == 0) {
            return Ok(vec![]);
        }
        match p.kind {
            8 => {
                if !p.data.is_empty() || ![0, 1, 0x100, 0x101, 0x200, 0x201].contains(&p.value) {
                    return Ok(self.abort_flow(&key, 10022).await);
                }
                let option = match p.value & !1 {
                    0 => TcpOption::Inline,
                    0x100 => TcpOption::KeepAlive,
                    _ => TcpOption::NoDelay,
                };
                let handle = flow.handle.clone();
                if let Err(error) = handle.set_option(option, p.value & 1 != 0).await {
                    return Ok(self.abort_flow(&key, error.code).await);
                }
            }
            6 => {
                if p.value > TCP_WINDOW - flow.remote_credit {
                    return Ok(self.abort_flow(&key, 10054).await);
                }
                flow.remote_credit += p.value;
                return Ok(self.pump(&key));
            }
            3 | 7 => {
                let amount = if p.kind == 7 { 1 } else { p.data.len() };
                if flow.received_fin
                    || p.data.is_empty()
                    || (p.kind == 7 && p.data.len() != 1)
                    || amount > flow.write_credit as usize
                {
                    return Ok(self.abort_flow(&key, 10054).await);
                }
                let ticket = if p.kind == 7 {
                    flow.handle.try_urgent(p.data[0])
                } else {
                    flow.handle.try_write(&p.data)
                };
                match ticket {
                    Ok(ticket) => {
                        flow.write_credit -= amount as u32;
                        let tx = self.events.clone();
                        let server_id = flow.server_id;
                        self.tasks.spawn(async move {
                            let result = ticket.completion().await;
                            let _ = tx
                                .send(Internal::TcpWriteDone {
                                    key,
                                    server_id,
                                    amount: amount as u32,
                                    result,
                                    _permit: permit,
                                })
                                .await;
                        });
                    }
                    Err(error) => return Ok(self.abort_flow(&key, error.code).await),
                }
            }
            4 => {
                if !flow.received_fin {
                    flow.received_fin = true;
                    let handle = flow.handle.clone();
                    let tx = self.events.clone();
                    let timeout = self.timeout;
                    let server_id = flow.server_id;
                    self.tasks.spawn(async move {
                        let result = tokio::time::timeout(timeout, handle.finish())
                            .await
                            .unwrap_or_else(|_| {
                                Err(NativeError::new(10060, "native FIN timed out"))
                            });
                        let _ = tx.send(Internal::TcpFinishDone { key, server_id, result }).await;
                    });
                }
            }
            _ => {}
        }
        Ok(vec![])
    }
    pub fn read(&mut self, key: TcpKey, server_id: u32, read: TcpRead) -> Vec<Delivery> {
        if !self.owns_event(key, server_id) { return vec![]; }
        let Some(flow) = self.flows.get_mut(&key) else {
            return vec![];
        };
        if flow.released {
            return vec![];
        }
        flow.pending.push_back(PendingRead {
            read: Arc::new(read),
            offset: 0,
        });
        self.pump(&key)
    }
    fn pump(&mut self, key: &TcpKey) -> Vec<Delivery> {
        let Some(flow) = self.flows.get_mut(key) else {
            return vec![];
        };
        let mut out = vec![];
        if flow.released {
            return out;
        }
        while flow.remote_credit > 0 {
            let Some(mut pending) = flow.pending.pop_front() else {
                break;
            };
            match pending.read.as_ref() {
                TcpRead::Data { bytes, .. } => {
                    let len = (bytes.len() - pending.offset)
                        .min(flow.remote_credit as usize)
                        .min(TCP_SEGMENT);
                    if len == 0 {
                        continue;
                    }
                    let data = bytes.slice(pending.offset..pending.offset + len);
                    pending.offset += len;
                    flow.remote_credit -= len as u32;
                    if let Some(packet) =
                        Self::packet(flow, 3, 0, data, Some(Box::new(pending.read.clone())))
                    {
                        out.push(packet)
                    }
                    if pending.offset < bytes.len() {
                        flow.pending.push_front(pending)
                    }
                }
                TcpRead::Urgent { byte, .. } => {
                    flow.remote_credit -= 1;
                    if let Some(packet) = Self::packet(
                        flow,
                        7,
                        0,
                        Bytes::copy_from_slice(&[*byte]),
                        Some(Box::new(pending.read.clone())),
                    ) {
                        out.push(packet)
                    }
                }
            }
        }
        if flow.remote_eof && flow.pending.is_empty() && !flow.sent_fin {
            flow.sent_fin = true;
            if let Some(packet) = Self::packet(flow, 4, 0, Bytes::new(), None) {
                out.push(packet)
            }
        }
        // Native EOF may be observed while the guest still owes RX credit.
        // Keep its tail until final DATA/FIN admission, then release the closed
        // physical flow without depending on an unrelated port-unbind command.
        let retired = flow.native_closed && flow.received_fin && flow.sent_fin;
        if retired {
            self.connecting
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(key);
            self.flows.remove(key);
        }
        out
    }
    pub fn eof(&mut self, key: TcpKey, server_id: u32) -> Vec<Delivery> {
        if !self.owns_event(key, server_id) { return vec![]; }
        if let Some(flow) = self.flows.get_mut(&key) {
            flow.remote_eof = true;
        }
        self.pump(&key)
    }
    pub async fn wrote(
        &mut self,
        key: TcpKey,
        server_id: u32,
        amount: u32,
        result: Result<(), NativeError>,
    ) -> Vec<Delivery> {
        if !self.owns_event(key, server_id) { return vec![]; }
        if let Err(error) = result {
            return self.abort_flow(&key, error.code).await;
        }
        let Some(flow) = self.flows.get_mut(&key) else {
            return vec![];
        };
        if amount > TCP_WINDOW - flow.write_credit {
            return self.abort_flow(&key, 10054).await;
        }
        flow.write_credit += amount;
        Self::packet(flow, 6, amount, Bytes::new(), None)
            .into_iter()
            .collect()
    }
    pub async fn finished(
        &mut self,
        key: TcpKey,
        server_id: u32,
        result: Result<(), NativeError>,
    ) -> Vec<Delivery> {
        if !self.owns_event(key, server_id) { return vec![]; }
        if let Err(error) = result {
            return self.abort_flow(&key, error.code).await;
        }
        if let Some(flow) = self.flows.get_mut(&key) {
            flow.write_finished = true;
            if flow.released {
                self.remove(&key).await;
            }
        }
        vec![]
    }
    pub async fn closed(&mut self, key: TcpKey, server_id: u32, status: TcpStatus) -> Vec<Delivery> {
        if !self.owns_event(key, server_id) { return vec![]; }
        let Some(flow) = self.flows.get(&key) else {
            return vec![];
        };
        if status.error.is_none() && flow.remote_eof {
            if flow.received_fin && flow.sent_fin {
                self.remove(&key).await;
            } else if let Some(flow) = self.flows.get_mut(&key) {
                flow.native_closed = true;
            }
            vec![]
        } else {
            self.abort_flow(&key, status.error.map_or(10054, |e| e.code))
                .await
        }
    }
    pub async fn release_port(&mut self, proto: u8, port: u16, generation: u32) {
        self.inbound.release_port(proto, port, generation);
        let keys: Vec<_> = self
            .flows
            .keys()
            .filter(|k| {
                k.binding.proto == proto
                    && k.binding.local_port == port
                    && k.binding.generation.is_none_or(|g| g <= generation)
            })
            .copied()
            .collect();
        for key in keys {
            let flow = self.flows.get_mut(&key).unwrap();
            if flow.received_fin {
                flow.released = true;
                flow.pending.clear();
                if flow.write_finished {
                    self.remove(&key).await;
                }
            } else {
                self.remove(&key).await;
            }
        }
    }
    pub(crate) async fn close_child(&mut self, key: TcpKey, server_id: u32) {
        if self.owns_event(key, server_id) { self.remove(&key).await; }
    }
    pub(crate) fn owns_event(&self, key: TcpKey, server_id: u32) -> bool {
        self.flows.get(&key).is_some_and(|flow| flow.server_id == server_id)
    }
    pub fn len(&self) -> usize {
        self.flows.len() + self.inbound.len()
    }
    pub fn abort(&self) {
        for flow in self.flows.values() {
            flow.handle.abort();
        }
    }
    pub async fn close(&mut self) {
        self.inbound.clear();
        self.abort();
        self.tasks.abort_all();
        while self.tasks.join_next().await.is_some() {}
        let keys: Vec<_> = self.flows.keys().copied().collect();
        for key in keys {
            self.remove(&key).await;
        }
    }
}

#[cfg(test)]
mod inbound_tests {
    use super::*;
    use crate::budget::Budget;
    use bottleship_lan_core::routes::NativeAddress;
    use bottleship_lan_native::tcp_listener::{NativeTcpListener, TcpListenerConfig};
    use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpStream, time::timeout};

    async fn incoming(listener: &NativeTcpListener) -> (TcpStream, AcceptedTcp) {
        let ready = timeout(Duration::from_secs(2), listener.when_ready()).await.unwrap().unwrap();
        let peer = timeout(Duration::from_secs(2), TcpStream::connect(std::net::SocketAddr::V4(ready.bound))).await.unwrap().unwrap();
        let accepted = timeout(Duration::from_secs(2), listener.accept()).await.unwrap().unwrap();
        (peer, accepted)
    }
    fn binding() -> BindingToken {
        BindingToken { proto: 2, local_port: 2310, generation: Some(4) }
    }
    fn answer(syn: &Datagram, guest: u32, value: u32) -> Datagram {
        let id = TcpFrame::decode(syn.payload.clone()).unwrap().src_id;
        Datagram { proto: 2, node: syn.node, src_port: syn.dst_port, dst_port: syn.src_port,
            payload: TcpFrame { kind: 2, src_id: guest, dst_id: id, value, data: Bytes::new() }.encode() }
    }
    fn target(port: u16) -> Target {
        Target { route_id: 0, address: NativeAddress::parse("127.0.0.1").unwrap(), port,
            canonical_policy_key: "127.0.0.1".into(), raw_mode: None }
    }
    #[tokio::test]
    async fn accepted_flow_uses_shared_limit_policy_and_existing_tcp_data_path() {
        let listener = NativeTcpListener::start(TcpListenerConfig::default()).unwrap();
        let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
        let (events, mut incoming_events) = mpsc::channel(64);
        let mut pool = TcpPool::new(7, 1, None, Duration::from_secs(2), policy.clone(), events,
            Arc::new(Mutex::new(HashMap::new())));
        let (mut peer, accepted) = incoming(&listener).await;
        let epoch = accepted.epoch;
        let syn = pool.admit_inbound(accepted, binding()).unwrap();
        let (mut denied_peer, second) = incoming(&listener).await;
        assert_eq!(pool.admit_inbound(second, binding()).unwrap_err().code, 10055);
        let mut byte = [0; 1];
        assert!(matches!(timeout(Duration::from_secs(2), denied_peer.read(&mut byte)).await.unwrap(), Ok(0) | Err(_)));
        let reply = answer(&syn, 77, 4096);
        assert!(pool.establish_inbound(binding(), epoch + 1, &reply).unwrap().is_none());
        let key = pool.establish_inbound(binding(), epoch, &reply).unwrap().unwrap();
        assert_eq!(pool.len(), 1);
        assert_eq!(policy.lock().unwrap().active_leases(), 1);

        peer.write_all(b"from-native").await.unwrap();
        let mut data = Vec::new();
        while data.len() < b"from-native".len() {
            let event = timeout(Duration::from_secs(2), incoming_events.recv()).await.unwrap().unwrap();
            if let Internal::TcpRead { key: k, server_id, read } = event {
                assert_eq!(k, key);
                for delivery in pool.read(k, server_id, read) {
                    if let GatewayEvent::Frame { datagram, .. } = delivery.event {
                        let frame = TcpFrame::decode(datagram.payload).unwrap();
                        if frame.kind == 3 { data.extend_from_slice(&frame.data); }
                    }
                }
            }
        }
        assert_eq!(data, b"from-native");

        let native_id = TcpFrame::decode(syn.payload.clone()).unwrap().src_id;
        let output = Datagram { proto: 2, node: syn.node, src_port: syn.dst_port, dst_port: syn.src_port,
            payload: TcpFrame { kind: 3, src_id: 77, dst_id: native_id, value: 0, data: Bytes::from_static(b"to-native") }.encode() };
        let budget = Budget::new(4, 1024);
        pool.process(output, binding(), target(syn.src_port), budget.reserve(1).unwrap()).await.unwrap();
        let mut bytes = [0; 9];
        timeout(Duration::from_secs(2), peer.read_exact(&mut bytes)).await.unwrap().unwrap();
        assert_eq!(&bytes, b"to-native");
        loop {
            let event = timeout(Duration::from_secs(2), incoming_events.recv()).await.unwrap().unwrap();
            if let Internal::TcpWriteDone { key: k, server_id, amount, result, .. } = event {
                let credit = pool.wrote(k, server_id, amount, result).await;
                assert_eq!(credit.len(), 1);
                break;
            }
        }
        peer.shutdown().await.unwrap();
        loop {
            let event = timeout(Duration::from_secs(2), incoming_events.recv()).await.unwrap().unwrap();
            if let Internal::TcpEof { key: k, server_id } = event {
                let fin = pool.eof(k, server_id);
                assert!(fin.iter().any(|delivery| match &delivery.event {
                    GatewayEvent::Frame { datagram, .. } => TcpFrame::decode(datagram.payload.clone()).unwrap().kind == 4,
                    _ => false,
                }));
                break;
            }
        }
        let guest_fin = Datagram { proto: 2, node: syn.node, src_port: syn.dst_port, dst_port: syn.src_port,
            payload: TcpFrame { kind: 4, src_id: 77, dst_id: native_id, value: 0, data: Bytes::new() }.encode() };
        pool.process(guest_fin, binding(), target(syn.src_port), budget.reserve(1).unwrap()).await.unwrap();
        loop {
            let event = timeout(Duration::from_secs(2), incoming_events.recv()).await.unwrap().unwrap();
            if let Internal::TcpFinishDone { key: k, server_id, result } = event {
                pool.finished(k, server_id, result).await;
                break;
            }
        }
        pool.close().await;
        assert_eq!(policy.lock().unwrap().active_leases(), 0);
        listener.abort();
        timeout(Duration::from_secs(2), listener.wait_closed()).await.unwrap().unwrap();
    }
    #[tokio::test]
    async fn old_native_events_are_fenced_when_guest_reuses_flow_key() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
        let (events, mut incoming_events) = mpsc::channel(64);
        let mut pool = TcpPool::new(7, 2, None, Duration::from_secs(2), policy, events,
            Arc::new(Mutex::new(HashMap::new())));
        let budget = Budget::new(8, 4096);
        let node = [2, 1, 127, 0, 0, 1];
        let make = |kind, dst_id| Datagram { proto: 2, node, src_port: 2310, dst_port: port,
            payload: TcpFrame { kind, src_id: 77, dst_id, value: TCP_WINDOW, data: Bytes::new() }.encode() };
        let first = pool.process(make(1, 0), binding(), target(port), budget.reserve(1).unwrap()).await.unwrap();
        let old_id = match &first[0].event { GatewayEvent::Frame { datagram, .. } =>
            TcpFrame::decode(datagram.payload.clone()).unwrap().src_id, _ => panic!("expected SYNACK") };
        let (mut first_peer, _) = listener.accept().await.unwrap();
        first_peer.write_all(b"stale").await.unwrap();
        let stale_read = loop {
            match timeout(Duration::from_secs(2), incoming_events.recv()).await.unwrap().unwrap() {
                Internal::TcpRead { server_id, read, .. } if server_id == old_id => break read,
                _ => {}
            }
        };
        let key = TcpKey { binding: binding(), node, remote_port: port, client_id: 77 };
        assert!(pool.owns_event(key, old_id));
        pool.process(make(5, old_id), binding(), target(port), budget.reserve(1).unwrap()).await.unwrap();
        let second = pool.process(make(1, 0), binding(), target(port), budget.reserve(1).unwrap()).await.unwrap();
        let new_id = match &second[0].event { GatewayEvent::Frame { datagram, .. } =>
            TcpFrame::decode(datagram.payload.clone()).unwrap().src_id, _ => panic!("expected SYNACK") };
        let (_second_peer, _) = listener.accept().await.unwrap();
        assert_ne!(old_id, new_id);
        assert!(!pool.owns_event(key, old_id));
        assert!(pool.owns_event(key, new_id));
        assert!(pool.read(key, old_id, stale_read).is_empty());
        assert!(pool.eof(key, old_id).is_empty());
        let status = TcpStatus { closed: true, error: Some(NativeError::new(10054, "old")), ..Default::default() };
        assert!(pool.closed(key, old_id, status).await.is_empty());
        assert!(pool.wrote(key, old_id, 1, Ok(())).await.is_empty());
        assert!(pool.wrote(key, old_id, 1, Err(NativeError::new(10054, "old"))).await.is_empty());
        assert!(pool.finished(key, old_id, Ok(())).await.is_empty());
        assert!(pool.finished(key, old_id, Err(NativeError::new(10054, "old"))).await.is_empty());
        assert!(pool.owns_event(key, new_id));
        let live = pool.eof(key, new_id);
        assert!(live.iter().any(|d| match &d.event {
            GatewayEvent::Frame { datagram, .. } => TcpFrame::decode(datagram.payload.clone()).unwrap().kind == 4,
            _ => false,
        }));
        pool.close().await;
    }

    #[tokio::test]
    async fn shared_quota_covers_queued_pending_and_outbound_until_socket_close() {
        let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
        let (events, _rx) = mpsc::channel(64);
        let mut pool = TcpPool::new(7, 1, None, Duration::from_secs(2), policy, events,
            Arc::new(Mutex::new(HashMap::new())));
        let idle1 = NativeTcpListener::start_with_quota(TcpListenerConfig::default(), pool.quota.clone()).unwrap();
        let idle2 = NativeTcpListener::start_with_quota(TcpListenerConfig::default(), pool.quota.clone()).unwrap();
        idle1.when_ready().await.unwrap(); idle2.when_ready().await.unwrap();
        let outgoing = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = outgoing.local_addr().unwrap().port();
        let budget = Budget::new(8, 4096);
        let node = [2, 1, 127, 0, 0, 1];
        let packet = |kind, dst_id| Datagram { proto: 2, node, src_port: 2310, dst_port: port,
            payload: TcpFrame { kind, src_id: 77, dst_id, value: TCP_WINDOW, data: Bytes::new() }.encode() };
        for _ in 0..10 {
            let result = pool.process(packet(1, 0), binding(), target(port), budget.reserve(1).unwrap()).await.unwrap();
            let native_id = match &result[0].event { GatewayEvent::Frame { datagram, .. } => {
                let f = TcpFrame::decode(datagram.payload.clone()).unwrap(); assert_eq!(f.kind, 2); f.src_id
            }, _ => panic!("expected outbound SYNACK") };
            let (peer, _) = outgoing.accept().await.unwrap();
            pool.process(packet(5, native_id), binding(), target(port), budget.reserve(1).unwrap()).await.unwrap();
            drop(peer);
            assert_eq!(pool.quota.available(), 1);
        }
        let (mut peer, accepted) = incoming(&idle1).await;
        assert_eq!(pool.quota.available(), 0);
        let refused = pool.process(packet(1, 0), binding(), target(port), budget.reserve(1).unwrap()).await.unwrap();
        match &refused[0].event { GatewayEvent::Frame { datagram, .. } =>
            assert_eq!(TcpFrame::decode(datagram.payload.clone()).unwrap().kind, 5), _ => panic!("expected capacity RST") }
        let epoch = accepted.epoch;
        pool.admit_inbound(accepted, binding()).unwrap();
        pool.inbound.cancel_listener(binding(), epoch);
        let mut byte = [0; 1];
        assert!(matches!(timeout(Duration::from_secs(2), peer.read(&mut byte)).await.unwrap(), Ok(0) | Err(_)));
        assert_eq!(pool.quota.available(), 1);
        idle1.abort(); idle2.abort();
        idle1.wait_closed().await.unwrap(); idle2.wait_closed().await.unwrap();
        assert_eq!(pool.quota.available(), 1);
        pool.close().await;
    }

    #[tokio::test]
    async fn source_policy_conflict_and_inline_reject_release_the_original_socket() {
        let listener = NativeTcpListener::start(TcpListenerConfig::default()).unwrap();
        let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
        let exclusive = policy.lock().unwrap().acquire("127.0.0.1", 99, true).unwrap();
        let (events, _incoming_events) = mpsc::channel(16);
        let mut pool = TcpPool::new(7, 2, None, Duration::from_secs(2), policy.clone(), events,
            Arc::new(Mutex::new(HashMap::new())));
        let (mut peer, accepted) = incoming(&listener).await;
        let epoch = accepted.epoch;
        let syn = pool.admit_inbound(accepted, binding()).unwrap();
        let error = match pool.establish_inbound(binding(), epoch, &answer(&syn, 7, 1024)) {
            Err(error) => error,
            _ => panic!("exclusive source conflict accepted"),
        };
        assert_eq!(error.code, 10048);
        assert_eq!(policy.lock().unwrap().active_leases(), 1);
        let mut byte = [0; 1];
        assert!(matches!(timeout(Duration::from_secs(2), peer.read(&mut byte)).await.unwrap(), Ok(0) | Err(_)));
        policy.lock().unwrap().release(exclusive);

        let (mut peer, accepted) = incoming(&listener).await;
        let epoch = accepted.epoch;
        let syn = pool.admit_inbound(accepted, binding()).unwrap();
        let error = match pool.establish_inbound(binding(), epoch, &answer(&syn, 8, 0x80000400)) {
            Err(error) => error,
            _ => panic!("unsupported accepted inline option accepted"),
        };
        assert_eq!(error.code, 10045);
        assert_eq!(policy.lock().unwrap().active_leases(), 0);
        assert!(matches!(timeout(Duration::from_secs(2), peer.read(&mut byte)).await.unwrap(), Ok(0) | Err(_)));
        pool.close().await;
        listener.abort();
        timeout(Duration::from_secs(2), listener.wait_closed()).await.unwrap().unwrap();
    }
}

