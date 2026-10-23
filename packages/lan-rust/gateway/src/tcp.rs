use crate::{Internal, budget::Permit};
use bottleship_lan_core::{
    ConnId, GatewayEvent,
    gateway::{BindingToken, DestinationPolicy},
    routes::Target,
    wire::{Datagram, Node, TCP_SEGMENT, TCP_WINDOW, TcpFrame},
};
use bottleship_lan_native::{
    NativeError,
    tcp::{NativeTcp, TcpOption, TcpOptions, TcpRead, TcpStatus},
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
}
impl Drop for Flow {
    fn drop(&mut self) {
        self.handle.abort();
        self.forward.abort();
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
    next_id: u32,
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
        Self {
            connection,
            limit,
            helper,
            timeout,
            policy,
            flows: HashMap::new(),
            next_id: 0,
            events,
            connecting,
            tasks: JoinSet::new(),
        }
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
            if self.flows.len() >= self.limit {
                return Ok(vec![Self::packet_for(key, 0, 5, 10055, Bytes::new(), None)]);
            }
            let Some(server_id) = self.next_id.checked_add(1) else {
                return Ok(vec![Self::packet_for(key, 0, 5, 10055, Bytes::new(), None)]);
            };
            self.next_id = server_id;
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
            let (handle, mut native) =
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
            let tx = self.events.clone();
            let mut status = handle.subscribe();
            let forward = tokio::spawn(async move {
                let mut reads_open = true;
                let mut eof_sent = false;
                loop {
                    tokio::select! {
                     read=native.reads.recv(),if reads_open=>match read{Some(read)=>if tx.send(Internal::TcpRead{key,read}).await.is_err(){break},None=>reads_open=false},
                     changed=status.changed()=>{
                      if changed.is_err(){break}let current=status.borrow_and_update().clone();
                      if current.remote_eof||current.closed{
                       while let Ok(read)=native.reads.try_recv(){if tx.send(Internal::TcpRead{key,read}).await.is_err(){return}}
                       if current.remote_eof&&!eof_sent{eof_sent=true;if tx.send(Internal::TcpEof{key}).await.is_err(){break}}
                      }
                      if current.closed{let _=tx.send(Internal::TcpClosed{key,status:current}).await;break}
                     }
                    }
                }
            });
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
                        self.tasks.spawn(async move {
                            let result = ticket.completion().await;
                            let _ = tx
                                .send(Internal::TcpWriteDone {
                                    key,
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
                    self.tasks.spawn(async move {
                        let result = tokio::time::timeout(timeout, handle.finish())
                            .await
                            .unwrap_or_else(|_| {
                                Err(NativeError::new(10060, "native FIN timed out"))
                            });
                        let _ = tx.send(Internal::TcpFinishDone { key, result }).await;
                    });
                }
            }
            _ => {}
        }
        Ok(vec![])
    }
    pub fn read(&mut self, key: TcpKey, read: TcpRead) -> Vec<Delivery> {
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
    pub fn eof(&mut self, key: TcpKey) -> Vec<Delivery> {
        if let Some(flow) = self.flows.get_mut(&key) {
            flow.remote_eof = true;
        }
        self.pump(&key)
    }
    pub async fn wrote(
        &mut self,
        key: TcpKey,
        amount: u32,
        result: Result<(), NativeError>,
    ) -> Vec<Delivery> {
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
        result: Result<(), NativeError>,
    ) -> Vec<Delivery> {
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
    pub async fn closed(&mut self, key: TcpKey, status: TcpStatus) -> Vec<Delivery> {
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
    pub fn len(&self) -> usize {
        self.flows.len()
    }
    pub fn abort(&self) {
        for flow in self.flows.values() {
            flow.handle.abort();
        }
    }
    pub async fn close(&mut self) {
        self.abort();
        self.tasks.abort_all();
        while self.tasks.join_next().await.is_some() {}
        let keys: Vec<_> = self.flows.keys().copied().collect();
        for key in keys {
            self.remove(&key).await;
        }
    }
}
