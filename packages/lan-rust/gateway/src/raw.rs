//! Native RAW forwarding: ICMP echo identifiers, UDP tuples, then explicit
//! destination-exclusive generic capture. This ports the TS reference mechanism.
use crate::{Internal, budget::Permit, raw_packet::*};
use bottleship_lan_core::{
    ConnId, GatewayEvent,
    config::{GatewayConfig, RawMode as RouteRawMode},
    gateway::{BindingToken, DestinationPolicy},
    routes::{NativeAddress, Target},
    wire::{Datagram, Node, node_ipv4},
};
use bottleship_lan_native::{
    NativeError,
    raw::{NativeRaw, RawLoss, RawMode, RawOptions, RawPacket},
};
use bytes::Bytes;
use std::{
    collections::HashMap,
    net::IpAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::mpsc,
    task::{JoinHandle, JoinSet},
    time::Instant,
};
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
enum Kind {
    Echo { original: u16 },
    Udp { source: u16, destination: u16 },
    Generic,
}
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
struct Key {
    binding: BindingToken,
    node: Node,
    protocol: u8,
    included: bool,
    kind: Kind,
}
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub(crate) struct Token {
    key: Key,
    serial: u64,
}
struct Flow {
    token: Token,
    handle: NativeRaw,
    forward: JoinHandle<()>,
    seen: Instant,
    endpoint: String,
    guest_destination: Vec<u8>,
    guest_source: Vec<u8>,
    native_echo: Option<u16>,
    native_port: u16,
    last_loss: RawLoss,
    allowed: Vec<u8>,
    policy: Arc<Mutex<DestinationPolicy>>,
    policy_id: u64,
}
impl Drop for Flow {
    fn drop(&mut self) {
        self.handle.abort();
        self.forward.abort();
        let policy = self.policy.clone();
        let id = self.policy_id;
        let echo = self.native_echo;
        if self.handle.status().closed {
            let mut p = policy.lock().unwrap_or_else(|e| e.into_inner());
            p.release(id);
            if let Some(echo) = echo {
                p.release_echo_id(echo);
            }
        } else {
            let h = self.handle.clone();
            tokio::spawn(async move {
                let _ = h.wait_closed().await;
                let mut p = policy.lock().unwrap_or_else(|e| e.into_inner());
                p.release(id);
                if let Some(echo) = echo {
                    p.release_echo_id(echo);
                }
            });
        }
    }
}
pub(crate) struct Delivery {
    pub event: GatewayEvent,
    pub guard: Option<Box<dyn Send>>,
}
pub(crate) struct RawPool {
    connection: ConnId,
    guest_node: Option<Node>,
    helper: Option<PathBuf>,
    limit: usize,
    timeout: Duration,
    config: GatewayConfig,
    policy: Arc<Mutex<DestinationPolicy>>,
    events: mpsc::Sender<Internal>,
    flows: HashMap<Key, Flow>,
    next: u64,
    tasks: JoinSet<()>,
}
impl RawPool {
    pub fn new(
        connection: ConnId,
        guest_node: Option<Node>,
        config: &GatewayConfig,
        policy: Arc<Mutex<DestinationPolicy>>,
        events: mpsc::Sender<Internal>,
    ) -> Self {
        Self {
            connection,
            guest_node,
            helper: config.native_helper_path.as_ref().map(Into::into),
            limit: config.max_raw_flows,
            timeout: Duration::from_millis(config.connect_timeout_ms),
            config: config.clone(),
            policy,
            events,
            flows: HashMap::new(),
            next: 0,
            tasks: JoinSet::new(),
        }
    }
    fn error(binding: BindingToken, node: Node, remote_port: u16, code: u32) -> Delivery {
        Delivery {
            event: GatewayEvent::SocketError {
                binding,
                node,
                remote_port,
                code,
                wire_id: None,
            },
            guard: None,
        }
    }
    fn reject(key: Key, code: u32) -> Delivery {
        Self::error(key.binding, key.node, u16::from(key.protocol) + 1, code)
    }
    fn current(&self, token: Token) -> bool {
        self.flows.get(&token.key).is_some_and(|f| f.token == token)
    }
    async fn remove(&mut self, key: &Key) {
        if let Some(flow) = self.flows.remove(key) {
            flow.handle.abort();
            let _ = flow.handle.wait_closed().await;
            drop(flow);
        }
    }
    fn addresses(&self, key: &Key, target: &Target) -> Result<(Vec<u8>, Vec<u8>), NativeError> {
        let node = self.guest_node.ok_or_else(|| {
            NativeError::new(
                10049,
                "RAW gateway requires an authenticated participant identity",
            )
        })?;
        if key.binding.proto == 6 {
            return Ok((node_ipv4(&node).to_vec(), node_ipv4(&key.node).to_vec()));
        }
        let mut source = [0; 16];
        source[..10].copy_from_slice(&LAN_PREFIX);
        source[10..].copy_from_slice(&node);
        let guest = self
            .config
            .routes
            .get(target.route_id)
            .and_then(|r| r.address.as_ref())
            .and_then(|a| NativeAddress::parse(a).ok())
            .map(|a| a.ip)
            .unwrap_or(target.address.ip);
        match guest {
            IpAddr::V6(ip) => Ok((source.to_vec(), ip.octets().to_vec())),
            _ => Err(NativeError::new(
                10049,
                "RAW IPv6 route has no matching guest address",
            )),
        }
    }
    async fn ensure(&mut self, key: Key, target: &Target) -> Result<Token, NativeError> {
        if let Some(flow) = self.flows.get(&key) {
            return Ok(flow.token);
        }
        let (source, destination) = self.addresses(&key, target)?;
        let helper = self
            .helper
            .as_ref()
            .ok_or_else(|| NativeError::new(10045, "native RAW helper unavailable"))?;
        if self.flows.len() >= self.limit {
            return Err(NativeError::new(10055, "native RAW flow limit reached"));
        }
        let serial = self
            .next
            .checked_add(1)
            .ok_or_else(|| NativeError::new(10055, "native RAW flow identity exhausted"))?;
        self.next = serial;
        let exclusive = matches!(key.kind, Kind::Generic);
        let (policy_id, native_echo) = {
            let mut policy = self.policy.lock().unwrap_or_else(|e| e.into_inner());
            let id = policy
                .acquire(&target.canonical_policy_key, self.connection, exclusive)
                .ok_or_else(|| NativeError::new(10048, "native destination is already owned"))?;
            let echo = if matches!(key.kind, Kind::Echo { .. }) {
                match policy.allocate_echo_id() {
                    Some(e) => Some(e),
                    None => {
                        policy.release(id);
                        return Err(NativeError::new(
                            10055,
                            "native echo identifier space exhausted",
                        ));
                    }
                }
            } else {
                None
            };
            (id, echo)
        };
        let (handle, mut native) = match NativeRaw::start(
            helper,
            target.address.socket_addr(target.port),
            RawMode::Raw {
                protocol: (key.binding.local_port - 1) as u8,
                header_included: key.included,
            },
            RawOptions {
                timeout: self.timeout,
            },
        ) {
            Ok(v) => v,
            Err(e) => {
                let mut p = self.policy.lock().unwrap_or_else(|e| e.into_inner());
                p.release(policy_id);
                if let Some(id) = native_echo {
                    p.release_echo_id(id);
                }
                return Err(e);
            }
        };
        let token = Token { key, serial };
        let mut status = handle.subscribe();
        let tx = self.events.clone();
        let forward = tokio::spawn(async move {
            let mut packets_open = true;
            let mut losses_open = true;
            loop {
                tokio::select! {
                 packet=native.packets.recv(),if packets_open=>match packet{Some(packet)=>if tx.send(Internal::RawRead{token,packet}).await.is_err(){break},None=>packets_open=false},
                 changed=native.losses.changed(),if losses_open=>{if changed.is_err(){losses_open=false}else{let loss=*native.losses.borrow_and_update();if tx.send(Internal::RawLoss{token,loss}).await.is_err(){break}}},
                 changed=status.changed()=>{if changed.is_err(){break}let s=status.borrow_and_update().clone();if s.closed{let _=tx.send(Internal::RawClosed{token,error:s.error.unwrap_or_else(||NativeError::new(10054,"native RAW helper closed"))}).await;break}}
                }
            }
        });
        let allowed = self
            .config
            .routes
            .get(target.route_id)
            .map(|r| r.ip_protocols.clone())
            .unwrap_or_else(|| vec![key.protocol]);
        self.flows.insert(
            key,
            Flow {
                token,
                handle: handle.clone(),
                forward,
                seen: Instant::now(),
                endpoint: target.canonical_policy_key.clone(),
                guest_source: source.clone(),
                guest_destination: destination.clone(),
                native_echo,
                native_port: 0,
                last_loss: RawLoss::default(),
                allowed,
                policy: self.policy.clone(),
                policy_id,
            },
        );
        let ready = async {
            handle.when_connected().await?;
            if !matches!(key.kind, Kind::Echo { .. }) {
                handle.set_guest_addresses(&source, &destination)?;
            }
            if let Kind::Udp {
                source,
                destination,
            } = key.kind
            {
                handle.set_udp_tuple(source, destination)?;
                let mut state = handle.subscribe();
                tokio::time::timeout(self.timeout, async {
                    loop {
                        let current = state.borrow().clone();
                        if let Some(error) = current.error {
                            return Err(error);
                        }
                        if let Some(tuple) = current.tuple {
                            if tuple.guest_port != source || tuple.remote_port != destination {
                                return Err(NativeError::new(
                                    10022,
                                    "mismatched native RAW UDP tuple",
                                ));
                            }
                            return Ok(tuple.native_port);
                        }
                        if current.closed {
                            return Err(NativeError::new(
                                10054,
                                "native RAW UDP reservation closed",
                            ));
                        }
                        state.changed().await.map_err(|_| {
                            NativeError::new(10054, "native RAW tuple observer stopped")
                        })?;
                    }
                })
                .await
                .map_err(|_| NativeError::new(10060, "native RAW UDP tuple timed out"))?
                .map(Some)
            } else {
                Ok(None)
            }
        }
        .await;
        match ready {
            Ok(port) => {
                if let Some(flow) = self.flows.get_mut(&key) {
                    flow.native_port = port.unwrap_or(0);
                }
                if let Err(error) = handle.set_ip_options(128, 0) {
                    self.remove(&key).await;
                    return Err(error);
                }
                Ok(token)
            }
            Err(error) => {
                self.remove(&key).await;
                Err(error)
            }
        }
    }
    pub async fn process(
        &mut self,
        d: Datagram,
        binding: BindingToken,
        target: Target,
        permit: Permit,
    ) -> Result<Vec<Delivery>, NativeError> {
        while self.tasks.try_join_next().is_some() {}
        let family = if binding.proto == 6 { 4 } else { 6 };
        let fail = |code| vec![Self::error(binding, d.node, d.dst_port, code)];
        if d.payload.len() < 2
            || d.payload[1] & !3 != 0
            || binding.local_port == 0
            || binding.local_port > 256
        {
            return Ok(fail(10022));
        }
        let protocol = d.payload[0];
        let included = d.payload[1] & 1 != 0;
        let header = if d.payload[1] & 2 != 0 { 5 } else { 2 };
        if d.payload.len() < header
            || d.dst_port != u16::from(protocol) + 1
            || (!included && binding.local_port != d.dst_port)
        {
            return Ok(fail(10022));
        }
        let socket_protocol = (binding.local_port - 1) as u8;
        if family == 6
            && (socket_protocol == 0 || socket_protocol == 255 || socket_protocol != protocol)
        {
            return Ok(fail(10045));
        }
        let packet = d.payload.slice(header..);
        let kind = if target.raw_mode == Some(RouteRawMode::Exclusive) {
            Kind::Generic
        } else if protocol == 17 && socket_protocol == 17 {
            match udp_ports(&packet, family, included) {
                Ok((source, destination)) => Kind::Udp {
                    source,
                    destination,
                },
                Err(e) => return Ok(fail(e.code)),
            }
        } else if protocol == if family == 4 { 1 } else { 58 } {
            match echo_id(&packet, family, included, false) {
                Some(original) => Kind::Echo { original },
                None => Kind::Generic,
            }
        } else {
            Kind::Generic
        };
        let key = Key {
            binding,
            node: d.node,
            protocol,
            included,
            kind,
        };
        let token = match self.ensure(key, &target).await {
            Ok(t) => t,
            Err(e) => return Ok(fail(e.code)),
        };
        let flow = self.flows.get_mut(&key).unwrap();
        flow.seen = Instant::now();
        if header == 5 {
            let ttl = i16::from_le_bytes([d.payload[2], d.payload[3]]) as i32;
            if let Err(error) = flow.handle.set_ip_options(ttl, u32::from(d.payload[4])) {
                if error.code != 10055 {
                    self.remove(&key).await;
                }
                return Ok(fail(error.code));
            }
        }
        let payload = if let Some(native_id) = flow.native_echo {
            Bytes::from(translate_echo(&packet, family, included, native_id).unwrap())
        } else {
            packet
        };
        match flow.handle.try_send(&payload) {
            Ok(ticket) => {
                let tx = self.events.clone();
                self.tasks.spawn(async move {
                    let result = ticket.completion().await;
                    let _ = tx
                        .send(Internal::RawSendDone {
                            token,
                            result,
                            _permit: permit,
                        })
                        .await;
                });
                Ok(vec![])
            }
            Err(error) => {
                if error.code != 10055 {
                    self.remove(&key).await;
                }
                Ok(fail(error.code))
            }
        }
    }
    pub fn read(&mut self, token: Token, packet: RawPacket) -> Option<Delivery> {
        if !self.current(token) {
            return None;
        }
        let key = token.key;
        let family = if key.binding.proto == 6 { 4 } else { 6 };
        let flow = self.flows.get(&key)?;
        let actual = if family == 4 {
            if packet.bytes.len() < 20 || packet.bytes[0] >> 4 != 4 {
                return None;
            }
            packet.bytes[9]
        } else {
            key.protocol
        };
        if !flow.allowed.contains(&actual) {
            return None;
        }
        let mut reply = packet.bytes.clone();
        match key.kind {
            Kind::Echo { original } => {
                if echo_id(&reply, family, family == 4, true) != flow.native_echo {
                    return None;
                }
                let mut bytes = translate_echo(&reply, family, family == 4, original)?;
                if family == 4 {
                    if !rewrite_ipv4(&mut bytes, &flow.guest_destination, &flow.guest_source) {
                        return None;
                    }
                } else if !checksum_v6(&mut bytes, &flow.guest_destination, &flow.guest_source) {
                    return None;
                }
                reply = Bytes::from(bytes);
            }
            Kind::Udp {
                source,
                destination,
            } => {
                if flow.native_port == 0
                    || udp_ports(&reply, family, family == 4).ok() != Some((destination, source))
                {
                    return None;
                }
            }
            Kind::Generic => {
                if actual == 17 {
                    if let Ok((_, destination)) = udp_ports(&reply, family, family == 4) {
                        if self.flows.values().any(|other| {
                            other.endpoint == flow.endpoint
                                && other.token.key.binding.proto == key.binding.proto
                                && matches!(other.token.key.kind, Kind::Udp { .. })
                                && other.native_port != 0
                                && other.native_port == destination
                        }) {
                            return None;
                        }
                    }
                }
                if actual == if family == 4 { 1 } else { 58 } {
                    if let Some(id) = echo_id(&reply, family, family == 4, true) {
                        if self
                            .policy
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .owns_echo_id(id)
                        {
                            return None;
                        }
                    }
                }
            }
        }
        let mut body = Vec::with_capacity(reply.len() + 2);
        body.push(actual);
        body.push(if family == 4 { 1 } else { 0 });
        body.extend_from_slice(&reply);
        self.flows.get_mut(&key)?.seen = Instant::now();
        Some(Delivery {
            event: GatewayEvent::Frame {
                binding: key.binding,
                datagram: Datagram {
                    proto: key.binding.proto,
                    node: key.node,
                    dst_port: key.binding.local_port,
                    src_port: u16::from(actual) + 1,
                    payload: Bytes::from(body),
                },
            },
            guard: Some(Box::new(packet)),
        })
    }
    pub async fn failed(&mut self, token: Token, error: NativeError) -> Vec<Delivery> {
        if !self.current(token) {
            return vec![];
        }
        let key = token.key;
        self.remove(&key).await;
        vec![Self::reject(key, error.code)]
    }
    pub fn loss(&mut self, token: Token, loss: RawLoss) -> Option<RawLoss> {
        if !self.current(token) {
            return None;
        }
        let flow = self.flows.get_mut(&token.key)?;
        let delta = RawLoss {
            packets: loss.packets.saturating_sub(flow.last_loss.packets),
            bytes: loss.bytes.saturating_sub(flow.last_loss.bytes),
        };
        flow.last_loss = loss;
        Some(delta)
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
            self.remove(&key).await
        }
    }
    pub async fn sweep(&mut self, deadline: Instant) {
        let keys: Vec<_> = self
            .flows
            .iter()
            .filter(|(_, f)| f.seen < deadline)
            .map(|(k, _)| *k)
            .collect();
        for key in keys {
            self.remove(&key).await
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
            self.remove(&key).await
        }
    }
}
