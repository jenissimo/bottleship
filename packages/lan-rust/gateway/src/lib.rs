//! Ordered, bounded native gateway actors. Core owns room/authentication policy.
mod budget;
mod host;
mod plain_udp;
mod raw;
mod raw_packet;
mod tcp;
mod tcp_accept;
mod tcp_host;
mod udp;
mod udp_carrier;
use bottleship_lan_core::{
    ConnId, GatewayEvent, GatewayInput, TcpChildKey, TcpOfferKey,
    config::GatewayConfig,
    gateway::{BindingRegistry, BindingToken, DestinationPolicy},
    wire::unreliable,
};
use bottleship_lan_native::{
    NativeError,
    udp::{UdpLosses, UdpPeerError},
};
use budget::{Budget, Permit};
use plain_udp::SendOutcome;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tcp::{Connecting, TcpKey, TcpPool};
use tokio::{
    sync::{Notify, mpsc, watch},
    task::JoinSet,
    time::{Instant, MissedTickBehavior},
};
use udp::{FlowKey, UdpPool};
use udp_carrier::Datagram as UdpDatagram;
#[derive(Clone, Debug)]
pub struct GatewayOptions {
    pub input_records: usize,
    pub input_bytes: usize,
    pub output_records: usize,
    pub output_bytes: usize,
}
impl Default for GatewayOptions {
    fn default() -> Self {
        Self {
            input_records: 256,
            input_bytes: 1048576,
            output_records: 64,
            output_bytes: 1048576,
        }
    }
}
#[derive(Clone, Debug, Default)]
pub struct GatewayStatus {
    pub closed: bool,
    pub error: Option<NativeError>,
    pub dropped_udp_packets: u64,
    pub native_rx_packets_lost: u64,
    pub native_rx_bytes_lost: u64,
    pub native_error_records_lost: u64,
    pub unattributed_udp_errors: u64,
    pub last_unattributed_send_native_code: Option<u32>,
    pub udp_flows: usize,
    pub tcp_flows: usize,
    pub raw_flows: usize,
    pub host_listeners: usize,
    pub host_rx_packets_lost: u64,
    pub host_rx_bytes_lost: u64,
    pub host_unauthorized_packets: u64,
    pub host_unattributed_errors: u64,
    pub native_raw_rx_packets_lost: u64,
    pub native_raw_rx_bytes_lost: u64,
}
/// Hold this envelope until all core effects have been admitted to the transport.
/// Its native receive guard returns RX credits on Drop, not when Bytes is cloned.
pub struct GatewayOutput {
    pub connection: ConnId,
    pub event: GatewayEvent,
    _permit: Permit,
    _receive: Option<Box<dyn Send>>,
}
pub struct GatewayEvents {
    pub outputs: mpsc::Receiver<GatewayOutput>,
    pub status: watch::Receiver<GatewayStatus>,
}
struct Envelope {
    input: GatewayInput,
    permit: Permit,
}
struct Inner {
    input: mpsc::Sender<Envelope>,
    budget: Arc<Budget>,
    closing: watch::Sender<bool>,
    status: watch::Receiver<GatewayStatus>,
    cancellations: Arc<Mutex<HashMap<u64, bool>>>,
    cancel_notify: Arc<Notify>,
    connecting: Connecting,
}
impl Drop for Inner {
    fn drop(&mut self) {
        let _ = self.closing.send(true);
    }
}
#[derive(Clone)]
pub struct GatewayHandle {
    inner: Arc<Inner>,
}
pub struct Gateway;
impl Gateway {
    pub fn spawn(
        connection: ConnId,
        config: GatewayConfig,
        policy: Arc<Mutex<DestinationPolicy>>,
        options: GatewayOptions,
    ) -> Result<(GatewayHandle, GatewayEvents), NativeError> {
        Self::spawn_inner(connection, None, config, policy, options)
    }
    /// RAW address translation requires the identity already authenticated by Core.
    pub fn spawn_with_node(
        connection: ConnId,
        node: bottleship_lan_core::wire::Node,
        config: GatewayConfig,
        policy: Arc<Mutex<DestinationPolicy>>,
        options: GatewayOptions,
    ) -> Result<(GatewayHandle, GatewayEvents), NativeError> {
        if !bottleship_lan_core::wire::lan_node(&node) {
            return Err(NativeError::new(
                10049,
                "invalid authenticated LAN identity",
            ));
        }
        Self::spawn_inner(connection, Some(node), config, policy, options)
    }
    fn spawn_inner(
        connection: ConnId,
        guest_node: Option<bottleship_lan_core::wire::Node>,
        config: GatewayConfig,
        policy: Arc<Mutex<DestinationPolicy>>,
        options: GatewayOptions,
    ) -> Result<(GatewayHandle, GatewayEvents), NativeError> {
        config
            .validate()
            .map_err(|_| NativeError::new(10022, "invalid gateway configuration"))?;
        if connection == 0
            || options.input_records == 0
            || options.input_records > 4096
            || options.input_bytes == 0
            || options.input_bytes > 16777216
            || options.output_records == 0
            || options.output_records > 4096
            || options.output_bytes == 0
            || options.output_bytes > 16777216
        {
            return Err(NativeError::new(10022, "invalid gateway queue limits"));
        }
        let budget = Budget::new(options.input_records, options.input_bytes);
        let output_budget = Budget::new(options.output_records, options.output_bytes);
        let (input, receiver) = mpsc::channel(options.input_records);
        let (events, event_rx) = mpsc::channel(256);
        let (outputs, output_rx) = mpsc::channel(options.output_records);
        let (closing, closed) = watch::channel(false);
        let (status, status_rx) = watch::channel(GatewayStatus::default());
        let cancellations = Arc::new(Mutex::new(HashMap::new()));
        let connecting = Arc::new(Mutex::new(HashMap::new()));
        let cancel_notify = Arc::new(Notify::new());
        let host = host::HostPool::new(
            connection,
            Duration::from_millis(config.connect_timeout_ms),
            policy.clone(),
            events.clone(),
        );
        let tcp = TcpPool::new(
            connection,
            config.max_tcp_connections,
            config.native_helper_path.as_ref().map(Into::into),
            Duration::from_millis(config.connect_timeout_ms),
            policy.clone(),
            events.clone(),
            connecting.clone(),
        );
        let raw = raw::RawPool::new(
            connection,
            guest_node,
            &config,
            policy.clone(),
            events.clone(),
        );
        let tcp_host = tcp_host::TcpHostPool::new(connection, policy.clone(), events.clone(), config.max_tcp_connections, tcp.quota.clone());
        let udp = UdpPool::new(
            connection,
            config.native_udp_helper_path.as_ref().map(Into::into),
            config.max_udp_flows,
            Duration::from_millis(config.connect_timeout_ms),
            policy,
            events.clone(),
        );
        let actor = Actor {
            connection,
            config,
            udp,
            tcp,
            raw,
            host,
            tcp_host,
            tcp_children: HashMap::new(),
            tcp_offers: HashMap::new(),
            bindings: BindingRegistry::default(),
            receiver,
            events: event_rx,
            event_tx: events,
            outputs,
            output_budget,
            status,
            cancellations: cancellations.clone(),
            cancel_notify: cancel_notify.clone(),
            leases: HashMap::new(),
            next_lease: 0,
            tasks: JoinSet::new(),
        };
        let handle = GatewayHandle {
            inner: Arc::new(Inner {
                input,
                budget: budget.clone(),
                closing,
                status: status_rx.clone(),
                cancellations,
                cancel_notify,
                connecting,
            }),
        };
        tokio::spawn(async move { actor.run(closed, budget).await });
        Ok((
            handle,
            GatewayEvents {
                outputs: output_rx,
                status: status_rx,
            },
        ))
    }
}
impl GatewayHandle {
    pub fn try_submit(&self, input: GatewayInput) -> Result<(), NativeError> {
        match input {
            GatewayInput::Close => {
                self.abort();
                return Ok(());
            }
            GatewayInput::CancelOperation { operation } => {
                if let Some(cancelled) = self
                    .inner
                    .cancellations
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get_mut(&operation)
                {
                    *cancelled = true;
                }
                self.inner.cancel_notify.notify_one();
                return Ok(());
            }
            _ => {}
        }
        let bytes = match &input {
            GatewayInput::Frame { datagram, .. } | GatewayInput::HostFrame { datagram, .. }
            | GatewayInput::TcpListenerFrame { datagram, .. } | GatewayInput::TcpChildFrame { datagram, .. } => {
                datagram.payload.len() + 256
            }
            _ => 256,
        };
        let permit = self.inner.budget.reserve(bytes)?;
        let slot = self
            .inner
            .input
            .try_reserve()
            .map_err(|_| NativeError::new(10055, "gateway command channel full"))?;
        if let GatewayInput::LeaseUdpPeer { operation, .. }
        | GatewayInput::OpenUdpHost { operation, .. }
        | GatewayInput::OpenTcpListener { operation_id: operation, .. } = &input
        {
            let mut pending = self
                .inner
                .cancellations
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if pending.len() >= 16 {
                return Err(NativeError::new(
                    10055,
                    "gateway pending lease limit reached",
                ));
            }
            if pending.contains_key(operation) {
                return Err(NativeError::new(10022, "gateway operation identity reused"));
            }
            pending.insert(*operation, false);
        }
        if let GatewayInput::Frame {
            datagram, binding, ..
        } = &input
        {
            if bottleship_lan_core::wire::tcp(datagram.proto) {
                if let Ok(packet) =
                    bottleship_lan_core::wire::TcpFrame::decode(datagram.payload.clone())
                {
                    if packet.kind == 5 {
                        let key = TcpKey {
                            binding: *binding,
                            node: datagram.node,
                            remote_port: datagram.dst_port,
                            client_id: packet.src_id,
                        };
                        if let Some(handle) = self
                            .inner
                            .connecting
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .get(&key)
                        {
                            handle.abort();
                        }
                    }
                }
            }
        }
        slot.send(Envelope { input, permit });
        Ok(())
    }
    pub fn abort(&self) {
        self.inner.budget.close();
        let _ = self.inner.closing.send(true);
    }
    pub fn status(&self) -> GatewayStatus {
        self.inner.status.borrow().clone()
    }
    pub async fn wait_closed(&self) -> Result<(), NativeError> {
        let mut status = self.inner.status.clone();
        loop {
            let s = status.borrow().clone();
            if s.closed {
                return s.error.map_or(Ok(()), Err);
            }
            status
                .changed()
                .await
                .map_err(|_| NativeError::new(10050, "gateway actor ended"))?;
        }
    }
}
enum Internal {
    TcpHostAccepted { id: u64, binding: BindingToken, accepted_id: u64, _slot: tokio::sync::OwnedSemaphorePermit },
    TcpHostClosed { id: u64, code: u32 },
    HostRead {
        id: u64,
        packet: bottleship_lan_native::listener::ListenerDatagram,
    },
    HostLoss {
        id: u64,
        loss: bottleship_lan_native::listener::ListenerLosses,
    },
    HostClosed {
        id: u64,
        code: u32,
    },
    HostSendDone {
        id: u64,
        binding: BindingToken,
        node: bottleship_lan_core::wire::Node,
        remote_port: u16,
        result: Result<(), NativeError>,
        _permit: Permit,
    },
    RawRead {
        token: raw::Token,
        packet: bottleship_lan_native::raw::RawPacket,
    },
    RawClosed {
        token: raw::Token,
        error: NativeError,
    },
    RawSendDone {
        token: raw::Token,
        result: Result<(), NativeError>,
        _permit: Permit,
    },
    RawLoss {
        token: raw::Token,
        loss: bottleship_lan_native::raw::RawLoss,
    },
    TcpRead {
        key: TcpKey,
        server_id: u32,
        read: bottleship_lan_native::tcp::TcpRead,
    },
    TcpEof {
        key: TcpKey,
        server_id: u32,
    },
    TcpClosed {
        key: TcpKey,
        server_id: u32,
        status: bottleship_lan_native::tcp::TcpStatus,
    },
    TcpWriteDone {
        key: TcpKey,
        server_id: u32,
        amount: u32,
        result: Result<(), NativeError>,
        _permit: Permit,
    },
    TcpFinishDone {
        key: TcpKey,
        server_id: u32,
        result: Result<(), NativeError>,
    },
    UdpReceive {
        port: u64,
        datagram: UdpDatagram,
    },
    UdpError {
        port: u64,
        error: UdpPeerError,
    },
    UdpClosed {
        port: u64,
        error: NativeError,
    },
    SendDone {
        key: FlowKey,
        result: SendOutcome,
        _permit: Permit,
    },
    UdpLosses {
        port: u64,
        losses: UdpLosses,
    },
}
struct Actor {
    connection: ConnId,
    config: GatewayConfig,
    udp: UdpPool,
    tcp: TcpPool,
    raw: raw::RawPool,
    host: host::HostPool,
    tcp_host: tcp_host::TcpHostPool,
    tcp_children: HashMap<TcpKey, TcpChildKey>,
    tcp_offers: HashMap<u32, TcpOfferKey>,
    bindings: BindingRegistry,
    receiver: mpsc::Receiver<Envelope>,
    events: mpsc::Receiver<Internal>,
    event_tx: mpsc::Sender<Internal>,
    outputs: mpsc::Sender<GatewayOutput>,
    output_budget: Arc<Budget>,
    status: watch::Sender<GatewayStatus>,
    cancellations: Arc<Mutex<HashMap<u64, bool>>>,
    cancel_notify: Arc<Notify>,
    leases: HashMap<u64, FlowKey>,
    next_lease: u64,
    tasks: JoinSet<()>,
}
impl Actor {
    async fn run(mut self, mut closing: watch::Receiver<bool>, budget: Arc<Budget>) {
        let mut error = None;
        let mut sweep = tokio::time::interval(Duration::from_secs(1));
        sweep.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            while self.tasks.try_join_next().is_some() {}
            if *closing.borrow() {
                break;
            }
            let result = tokio::select! {
             _=closing.changed()=>break,
             command=self.receiver.recv()=>match command{
              Some(envelope)=>{tokio::select!{biased;_ =closing.changed()=>break,result=self.input(envelope)=>result}},
              None=>break
             },
             event=self.events.recv()=>match event{Some(event)=>self.event(event).await,None=>break},
             _=sweep.tick()=>{tokio::select!{biased;_ =closing.changed()=>break,_=self.sweep()=>Ok(())}}
            };
            let result = result.and_then(|()| self.retire_tcp_children()).and_then(|()| self.retire_tcp_offers());
            self.publish_counts();
            if let Err(failure) = result {
                error = Some(failure);
                break;
            }
        }
        budget.close();
        self.receiver.close();
        self.udp.abort();
        self.tcp.abort();
        self.raw.abort();
        self.host.abort();
        self.tcp_host.abort();
        self.tasks.abort_all();
        while self.tasks.join_next().await.is_some() {}
        self.udp.close().await;
        self.tcp.close().await;
        self.raw.close().await;
        self.host.close().await;
        self.tcp_host.close().await;
        self.output_budget.close();
        self.cancellations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.status.send_modify(|s| {
            s.udp_flows = 0;
            s.tcp_flows = 0;
            s.raw_flows = 0;
            s.host_listeners = 0;
            s.closed = true;
            s.error = error;
        });
    }
    fn publish_counts(&self) {
        let udp = self.udp.flows.len();
        let tcp = self.tcp.len();
        let raw = self.raw.len();
        let host = self.host.len();
        self.status.send_if_modified(|s| {
            if s.udp_flows == udp
                && s.tcp_flows == tcp
                && s.raw_flows == raw
                && s.host_listeners == host
            {
                return false;
            }
            s.udp_flows = udp;
            s.tcp_flows = tcp;
            s.raw_flows = raw;
            s.host_listeners = host;
            true
        });
    }
    fn output(
        &self,
        event: GatewayEvent,
        receive: Option<Box<dyn Send>>,
    ) -> Result<(), NativeError> {
        let event = match event {
            GatewayEvent::Frame { binding, datagram } if binding.proto == 2 => {
                let key = bottleship_lan_core::wire::TcpFrame::decode(datagram.payload.clone()).ok().and_then(|frame| {
                    let lookup = TcpKey { binding, node: datagram.node, remote_port: datagram.src_port, client_id: frame.dst_id };
                    self.tcp_children.get(&lookup).filter(|owner| owner.native_id == frame.src_id).copied()
                });
                match key {
                    Some(key) => GatewayEvent::TcpChildFrame { key, datagram },
                    None => GatewayEvent::Frame { binding, datagram },
                }
            }
            other => other,
        };
        let unreliable = matches!(&event,GatewayEvent::Frame{binding,..}|GatewayEvent::HostFrame{binding,..}if unreliable(binding.proto));
        let bytes = match &event {
            GatewayEvent::Frame { datagram, .. } | GatewayEvent::HostFrame { datagram, .. }
            | GatewayEvent::TcpListenerFrame { datagram, .. } | GatewayEvent::TcpChildFrame { datagram, .. } => {
                datagram.payload.len() + 64
            }
            _ => 128,
        };
        let result = (|| {
            let permit = self.output_budget.reserve(bytes)?;
            self.outputs
                .try_send(GatewayOutput {
                    connection: self.connection,
                    event,
                    _permit: permit,
                    _receive: receive,
                })
                .map_err(|_| NativeError::new(10055, "gateway output channel full"))
        })();
        if result.is_err() && unreliable {
            self.status
                .send_modify(|s| s.dropped_udp_packets = s.dropped_udp_packets.saturating_add(1));
            return Ok(());
        }
        result
    }
    fn retire_tcp_offers(&mut self) -> Result<(), NativeError> {
        let retired: Vec<_> = self.tcp_offers.iter()
            .filter(|(id, _)| !self.tcp.inbound.contains(**id))
            .map(|(id, key)| (*id, *key)).collect();
        for (id, _) in retired {
            self.finish_tcp_offer(id, true)?;
        }
        Ok(())
    }
    fn finish_tcp_offer(&mut self, id: u32, reset: bool) -> Result<(), NativeError> {
        let Some(key) = self.tcp_offers.remove(&id) else { return Ok(()); };
        if reset {
            let datagram = bottleship_lan_core::wire::Datagram {
                proto: 2, node: key.node, src_port: key.remote_port, dst_port: key.binding.local_port,
                payload: bottleship_lan_core::wire::TcpFrame { kind: 5, src_id: key.native_id,
                    dst_id: 0, value: 10054, data: bytes::Bytes::new() }.encode(),
            };
            self.output(GatewayEvent::TcpListenerFrame { lease_id: key.lease_id, binding: key.binding, datagram }, None)?;
        }
        self.output(GatewayEvent::TcpOfferClosed { key }, None)
    }
    fn finish_tcp_offer_exact(&mut self, child: TcpChildKey) -> Result<(), NativeError> {
        if self.tcp_offers.get(&child.native_id).is_some_and(|offer|
            offer.lease_id == child.lease_id && offer.binding == child.binding
            && offer.node == child.node && offer.remote_port == child.remote_port) {
            self.finish_tcp_offer(child.native_id, false)?;
        }
        Ok(())
    }
    fn retire_tcp_children(&mut self) -> Result<(), NativeError> {
        let closed: Vec<_> = self.tcp_children.iter()
            .filter(|(key, child)| !self.tcp.owns_event(**key, child.native_id))
            .map(|(key, child)| (*key, *child)).collect();
        for (key, child) in closed {
            self.tcp_children.remove(&key);
            self.output(GatewayEvent::TcpChildClosed { key: child }, None)?;
        }
        Ok(())
    }
    fn reject_tcp_child(&self, child: TcpChildKey, code: u32) -> Result<(), NativeError> {
        let reply = bottleship_lan_core::wire::Datagram {
            proto: 2, node: child.node, src_port: child.remote_port, dst_port: child.binding.local_port,
            payload: bottleship_lan_core::wire::TcpFrame { kind: 5, src_id: child.native_id,
                dst_id: child.guest_id, value: code, data: bytes::Bytes::new() }.encode(),
        };
        self.output(GatewayEvent::TcpListenerFrame { lease_id: child.lease_id, binding: child.binding, datagram: reply }, None)?;
        self.output(GatewayEvent::TcpChildClosed { key: child }, None)
    }
    async fn retire_tcp_listener(&mut self, id: u64) {
        if let Some((binding, Some(epoch))) = self.tcp_host.identity(id) {
            self.tcp.inbound.cancel_listener(binding, epoch);
        }
        self.tcp_host.remove(id).await;
    }
    fn error(&self, key: FlowKey, code: u32) -> Result<(), NativeError> {
        self.output(
            GatewayEvent::SocketError {
                binding: key.binding,
                node: key.node,
                remote_port: key.remote_port,
                code,
                wire_id: None,
            },
            None,
        )
    }
    fn cancelled(&self, operation: u64) -> bool {
        self.cancellations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&operation)
            .copied()
            .unwrap_or(true)
    }
    fn finish_operation(&self, operation: u64) {
        self.cancellations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&operation);
    }
    async fn admit_binding(&mut self, binding: BindingToken) -> bool {
        if !self.bindings.admit(binding) {
            return false;
        }
        let old: Vec<_> = self
            .udp
            .flows
            .keys()
            .filter(|key| {
                key.binding.proto == binding.proto
                    && key.binding.local_port == binding.local_port
                    && key.binding != binding
            })
            .copied()
            .collect();
        for key in old {
            self.remove_flow(key).await;
        }
        if let Some(g) = binding.generation {
            for id in self.tcp_host.ids_for_port(binding.proto, binding.local_port, g - 1) {
                self.retire_tcp_listener(id).await;
            }
            self.tcp
                .release_port(binding.proto, binding.local_port, g - 1)
                .await;
            self.raw
                .release_port(binding.proto, binding.local_port, g - 1)
                .await;
            self.host
                .release_port(binding.proto, binding.local_port, g - 1)
                .await;
        }
        true
    }
    async fn remove_flow(&mut self, key: FlowKey) {
        self.leases.retain(|_, other| *other != key);
        self.udp.remove(&key).await;
    }
    async fn input(&mut self, Envelope { input, permit }: Envelope) -> Result<(), NativeError> {
        match input {
            GatewayInput::OpenTcpListener { operation_id, binding, config } => {
                if self.cancelled(operation_id) {
                    self.finish_operation(operation_id);
                    return Ok(());
                }
                if !self.config.tcp_listeners.iter().any(|allowed| allowed == &config) {
                    self.finish_operation(operation_id);
                    return self.output(GatewayEvent::TcpListenerFailed { operation_id, code: 10013 }, None);
                }
                if !self.admit_binding(binding).await {
                    self.finish_operation(operation_id);
                    return self.output(GatewayEvent::TcpListenerFailed { operation_id, code: 10057 }, None);
                }
                if self.tcp_host.contains_binding(binding) {
                    self.finish_operation(operation_id);
                    return self.output(GatewayEvent::TcpListenerFailed { operation_id, code: 10048 }, None);
                }
                let cancellations = self.cancellations.clone();
                let wake = self.cancel_notify.clone();
                let result = {
                    let opening = self.tcp_host.open(binding, config);
                    tokio::pin!(opening);
                    loop {
                        if cancellations.lock().unwrap_or_else(|e| e.into_inner()).get(&operation_id).copied().unwrap_or(true) {
                            break None;
                        }
                        tokio::select! { biased; _ = wake.notified() => {}, result = &mut opening => break Some(result) }
                    }
                };
                if result.is_none() || self.cancelled(operation_id) {
                    self.tcp_host.cancel_binding(binding).await;
                    self.finish_operation(operation_id);
                    return Ok(());
                }
                self.finish_operation(operation_id);
                match result.unwrap() {
                    Ok((lease_id, address)) => self.output(GatewayEvent::TcpListenerReady { operation_id, lease_id, binding, address }, None)?,
                    Err(error) => self.output(GatewayEvent::TcpListenerFailed { operation_id, code: error.code }, None)?,
                }
            }
            GatewayInput::CancelTcpOffer { key } => {
                if self.tcp_offers.get(&key.native_id) == Some(&key) {
                    self.tcp.inbound.cancel(key.native_id);
                    self.finish_tcp_offer(key.native_id, true)?;
                }
            }
            GatewayInput::CloseTcpListener { lease_id } => {
                self.retire_tcp_listener(lease_id).await;
            }
            GatewayInput::TcpListenerFrame { lease_id, binding, datagram } => {
                let frame = match bottleship_lan_core::wire::TcpFrame::decode(datagram.payload.clone()) {
                    Ok(frame) => frame, Err(_) => return Ok(()),
                };
                let child = TcpChildKey { lease_id, binding, node: datagram.node, remote_port: datagram.dst_port,
                    native_id: frame.dst_id, guest_id: frame.src_id };
                if frame.kind == 2 && (frame.src_id == 0 || frame.dst_id == 0) { return Ok(()); }
                if frame.kind == 2 && !frame.data.is_empty() { self.reject_tcp_child(child, 10022)?; return Ok(()); }
                // A duplicate handshake for an already established exact child must
                // never retire it, even if a stale control frame bypasses Core.
                let lookup = TcpKey { binding, node: child.node, remote_port: child.remote_port, client_id: child.guest_id };
                if frame.kind == 2 && self.tcp_children.get(&lookup) == Some(&child) { return Ok(()); }
                let epoch = self.tcp_host.epoch(lease_id, binding);
                if !self.bindings.is_live(binding) || epoch.is_none() {
                    if frame.kind == 2 { self.reject_tcp_child(child, 10054)?; self.finish_tcp_offer_exact(child)?; }
                    return Ok(());
                }
                let epoch = epoch.unwrap();
                if frame.kind == 5 {
                    if self.tcp.inbound.reset(binding, epoch, &datagram) { self.finish_tcp_offer_exact(child)?; }
                } else if frame.kind == 2 {
                    match self.tcp.establish_inbound(binding, epoch, &datagram) {
                        Ok(Some(key)) => {
                            self.tcp_children.insert(key, child);
                            self.output(GatewayEvent::TcpChildEstablished { key: child }, None)?;
                        }
                        Ok(None) => self.reject_tcp_child(child, 10054)?,
                        Err(error) => self.reject_tcp_child(child, error.code)?,
                    }
                    self.finish_tcp_offer_exact(child)?;
                }
            }
            GatewayInput::TcpChildFrame { key, datagram } => {
                let lookup = TcpKey { binding: key.binding, node: key.node, remote_port: key.remote_port, client_id: key.guest_id };
                if self.tcp_children.get(&lookup) != Some(&key) || !self.tcp.owns_event(lookup, key.native_id)
                    || !self.bindings.is_live(key.binding) || datagram.proto != 2 || datagram.node != key.node
                    || datagram.src_port != key.binding.local_port || datagram.dst_port != key.remote_port { return Ok(()); }
                let Ok(frame) = bottleship_lan_core::wire::TcpFrame::decode(datagram.payload.clone()) else { return Ok(()); };
                if frame.src_id != key.guest_id || frame.dst_id != key.native_id || frame.kind == 1 || frame.kind == 2 { return Ok(()); }
                let address = std::net::Ipv4Addr::new(key.node[2], key.node[3], key.node[4], key.node[5]);
                let target = bottleship_lan_core::routes::Target {
                    route_id: 0, address: bottleship_lan_core::routes::NativeAddress::parse(&address.to_string()).unwrap(),
                    port: key.remote_port, canonical_policy_key: address.to_string(), raw_mode: None,
                };
                let deliveries = self.tcp.process(datagram, key.binding, target, permit).await?;
                for delivery in deliveries { self.output(delivery.event, delivery.guard)?; }
            }
            GatewayInput::CloseTcpChild { key } => {
                let lookup = TcpKey { binding: key.binding, node: key.node, remote_port: key.remote_port, client_id: key.guest_id };
                if self.tcp_children.get(&lookup) == Some(&key) {
                    self.tcp.close_child(lookup, key.native_id).await;
                }
            }
            GatewayInput::OpenUdpHost {
                operation,
                binding,
                listener,
            } => {
                if self.cancelled(operation) {
                    self.finish_operation(operation);
                    return Ok(());
                }
                if !self.admit_binding(binding).await {
                    self.finish_operation(operation);
                    return self.output(
                        GatewayEvent::HostFailed {
                            operation,
                            code: 10057,
                        },
                        None,
                    );
                }
                if self
                    .udp
                    .flows
                    .iter()
                    .any(|(k, f)| k.binding == binding && f.pins != 0)
                {
                    self.finish_operation(operation);
                    return self.output(
                        GatewayEvent::HostFailed {
                            operation,
                            code: 10048,
                        },
                        None,
                    );
                }
                let old: Vec<_> = self
                    .udp
                    .flows
                    .keys()
                    .filter(|k| k.binding == binding)
                    .copied()
                    .collect();
                for key in old {
                    self.remove_flow(key).await;
                }
                let cancellations = self.cancellations.clone();
                let wake = self.cancel_notify.clone();
                let result = {
                    let opening = self.host.open(binding, listener);
                    tokio::pin!(opening);
                    loop {
                        if cancellations
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .get(&operation)
                            .copied()
                            .unwrap_or(true)
                        {
                            break None;
                        }
                        tokio::select! {biased;_=wake.notified()=>{},result=&mut opening=>break Some(result)}
                    }
                };
                if result.is_none() || self.cancelled(operation) {
                    self.host.cancel_binding(binding).await;
                    self.finish_operation(operation);
                    return Ok(());
                }
                self.finish_operation(operation);
                match result.unwrap() {
                    Ok((lease_id, node, port)) => self.output(
                        GatewayEvent::HostReady {
                            operation,
                            lease_id,
                            node,
                            port,
                        },
                        None,
                    )?,
                    Err(error) => self.output(
                        GatewayEvent::HostFailed {
                            operation,
                            code: error.code,
                        },
                        None,
                    )?,
                }
            }
            GatewayInput::ReleaseUdpHost { lease_id } => {
                self.host.remove(lease_id).await;
            }
            GatewayInput::HostFrame {
                lease_id,
                binding,
                datagram,
            } => {
                if !self.bindings.is_live(binding) {
                    return Ok(());
                }
                match self.host.send(lease_id, binding, &datagram) {
                    Ok(ticket) => {
                        let tx = self.event_tx.clone();
                        let node = datagram.node;
                        let remote_port = datagram.dst_port;
                        self.tasks.spawn(async move {
                            let result = ticket.completion().await;
                            let _ = tx
                                .send(Internal::HostSendDone {
                                    id: lease_id,
                                    binding,
                                    node,
                                    remote_port,
                                    result,
                                    _permit: permit,
                                })
                                .await;
                        });
                    }
                    Err(error) => self.output(
                        GatewayEvent::HostSocketError {
                            lease_id,
                            binding,
                            node: datagram.node,
                            remote_port: datagram.dst_port,
                            code: error.code,
                        },
                        None,
                    )?,
                }
            }
            GatewayInput::Frame {
                datagram,
                binding,
                target,
            } => {
                if !self.admit_binding(binding).await {
                    return Ok(());
                }
                if bottleship_lan_core::wire::tcp(binding.proto) {
                    let deliveries = self.tcp.process(datagram, binding, target, permit).await?;
                    for delivery in deliveries {
                        self.output(delivery.event, delivery.guard)?;
                    }
                    return Ok(());
                }
                if bottleship_lan_core::wire::raw(binding.proto) {
                    let deliveries = self.raw.process(datagram, binding, target, permit).await?;
                    for delivery in deliveries {
                        self.output(delivery.event, delivery.guard)?;
                    }
                    return Ok(());
                }
                let key = FlowKey {
                    binding,
                    node: datagram.node,
                    remote_port: datagram.dst_port,
                };
                if !matches!(binding.proto, 1 | 4) {
                    return self.error(key, 10045);
                }
                if let Err(error) = self.udp.ensure(key, &target).await {
                    return self.error(key, error.code);
                }
                match self.udp.send(&key, &datagram.payload) {
                    Ok(ticket) => {
                        let events = self.event_tx.clone();
                        self.tasks.spawn(async move {
                            let result = ticket.completion().await;
                            let _ = events
                                .send(Internal::SendDone {
                                    key,
                                    result,
                                    _permit: permit,
                                })
                                .await;
                        });
                    }
                    Err(error) => {
                        self.error(key, error.code)?;
                    }
                }
            }
            GatewayInput::LeaseUdpPeer {
                operation,
                request,
                binding,
                target,
                ..
            } => {
                if self.cancelled(operation) {
                    self.finish_operation(operation);
                    return Ok(());
                }
                let key = FlowKey {
                    binding,
                    node: request.node,
                    remote_port: request.remote_port,
                };
                if !self.admit_binding(binding).await {
                    self.finish_operation(operation);
                    return self.output(
                        GatewayEvent::LeaseFailed {
                            operation,
                            code: 10057,
                        },
                        None,
                    );
                }
                let result = self.udp.ensure(key, &target).await;
                if self.cancelled(operation) {
                    if result == Ok(true)
                        && self
                            .udp
                            .flows
                            .get(&key)
                            .is_some_and(|f| f.pins == 0 && !f.outbound)
                    {
                        self.remove_flow(key).await;
                    }
                    self.finish_operation(operation);
                    return Ok(());
                }
                match result {
                    Ok(_) => {
                        let Some(id) = self.next_lease.checked_add(1) else {
                            self.finish_operation(operation);
                            return self.output(
                                GatewayEvent::LeaseFailed {
                                    operation,
                                    code: 10055,
                                },
                                None,
                            );
                        };
                        self.next_lease = id;
                        if self.leases.len() >= 128 {
                            self.finish_operation(operation);
                            return self.output(
                                GatewayEvent::LeaseFailed {
                                    operation,
                                    code: 10055,
                                },
                                None,
                            );
                        }
                        self.udp.flows.get_mut(&key).unwrap().pins += 1;
                        self.leases.insert(id, key);
                        self.finish_operation(operation);
                        self.output(
                            GatewayEvent::LeaseReady {
                                operation,
                                lease_id: id,
                            },
                            None,
                        )?
                    }
                    Err(error) => {
                        self.finish_operation(operation);
                        self.output(
                            GatewayEvent::LeaseFailed {
                                operation,
                                code: error.code,
                            },
                            None,
                        )?;
                    }
                }
            }
            GatewayInput::ReleaseUdpPeer { lease_id } => {
                if let Some(key) = self.leases.remove(&lease_id) {
                    if let Some(flow) = self.udp.flows.get_mut(&key) {
                        flow.pins = flow.pins.saturating_sub(1);
                        if flow.pins == 0 && !flow.outbound {
                            self.remove_flow(key).await;
                        }
                    }
                }
            }
            GatewayInput::ReleasePort {
                proto,
                port,
                generation,
            } => {
                if self.bindings.release(proto, port, generation) {
                    for id in self.tcp_host.ids_for_port(proto, port, generation) {
                        self.retire_tcp_listener(id).await;
                    }
                    self.tcp.release_port(proto, port, generation).await;
                    self.raw.release_port(proto, port, generation).await;
                    self.host.release_port(proto, port, generation).await;
                    let keys: Vec<_> = self
                        .udp
                        .flows
                        .keys()
                        .filter(|key| {
                            key.binding.proto == proto
                                && key.binding.local_port == port
                                && key.binding.generation.is_none_or(|g| g <= generation)
                        })
                        .copied()
                        .collect();
                    for key in keys {
                        self.remove_flow(key).await;
                    }
                }
            }
            GatewayInput::CancelOperation { .. } | GatewayInput::Close => {}
        }
        Ok(())
    }
    async fn event(&mut self, event: Internal) -> Result<(), NativeError> {
        match event {
            Internal::TcpHostAccepted { id, binding, accepted_id, _slot } => {
                let Some(accepted) = self.tcp_host.take_accepted(id, binding, accepted_id) else { return Ok(()); };
                if !self.bindings.is_live(binding) || !self.tcp_host.accept_epoch(id, binding, accepted.epoch) {
                    return Ok(());
                }
                if let Ok(datagram) = self.tcp.admit_inbound(accepted, binding) {
                    let frame = bottleship_lan_core::wire::TcpFrame::decode(datagram.payload.clone())
                        .expect("internally encoded TCP SYN");
                    let key = TcpOfferKey { lease_id: id, binding, node: datagram.node,
                        remote_port: datagram.src_port, native_id: frame.src_id };
                    self.tcp_offers.insert(frame.src_id, key);
                    self.output(GatewayEvent::TcpListenerFrame { lease_id: id, binding, datagram }, None)?;
                }
            }
            Internal::TcpHostClosed { id, code } => {
                if self.tcp_host.identity(id).is_some() {
                    self.retire_tcp_listener(id).await;
                    self.output(GatewayEvent::TcpListenerClosed { lease_id: id, code }, None)?;
                }
            }
            Internal::HostRead { id, packet } => {
                if let Some(event) = self.host.receive(id, &packet) {
                    self.output(event, Some(Box::new(packet)))?;
                }
            }
            Internal::HostLoss { id, loss } => {
                if let Some(loss) = self.host.loss(id, loss) {
                    self.status.send_modify(|s| {
                        s.host_rx_packets_lost =
                            s.host_rx_packets_lost.saturating_add(loss.rx_packets);
                        s.host_rx_bytes_lost = s.host_rx_bytes_lost.saturating_add(loss.rx_bytes);
                        s.host_unauthorized_packets = s
                            .host_unauthorized_packets
                            .saturating_add(loss.unauthorized_packets);
                        s.host_unattributed_errors = s
                            .host_unattributed_errors
                            .saturating_add(loss.unattributed_errors);
                    });
                }
            }
            Internal::HostClosed { id, code } => {
                if let Some(event) = self.host.failed(id, code).await {
                    self.output(event, None)?;
                }
            }
            Internal::HostSendDone {
                id,
                binding,
                node,
                remote_port,
                result,
                ..
            } => {
                if self.host.is_live(id, binding) {
                    if let Err(error) = result {
                        self.output(
                            GatewayEvent::HostSocketError {
                                lease_id: id,
                                binding,
                                node,
                                remote_port,
                                code: error.code,
                            },
                            None,
                        )?;
                    }
                }
            }
            Internal::RawRead { token, packet } => {
                if let Some(delivery) = self.raw.read(token, packet) {
                    self.output(delivery.event, delivery.guard)?;
                }
            }
            Internal::RawClosed { token, error } => {
                for delivery in self.raw.failed(token, error).await {
                    self.output(delivery.event, delivery.guard)?;
                }
            }
            Internal::RawSendDone { token, result, .. } => {
                if let Err(error) = result {
                    for delivery in self.raw.failed(token, error).await {
                        self.output(delivery.event, delivery.guard)?;
                    }
                }
            }
            Internal::RawLoss { token, loss } => {
                if let Some(loss) = self.raw.loss(token, loss) {
                    self.status.send_modify(|s| {
                        s.native_raw_rx_packets_lost =
                            s.native_raw_rx_packets_lost.saturating_add(loss.packets);
                        s.native_raw_rx_bytes_lost =
                            s.native_raw_rx_bytes_lost.saturating_add(loss.bytes);
                    });
                }
            }
            Internal::UdpLosses { port, losses } => {
                let delta = self.udp.losses(port, losses);
                self.status.send_modify(|s| {
                    s.native_rx_packets_lost =
                        s.native_rx_packets_lost.saturating_add(delta.rx_packets);
                    s.native_rx_bytes_lost = s.native_rx_bytes_lost.saturating_add(delta.rx_bytes);
                    s.native_error_records_lost = s
                        .native_error_records_lost
                        .saturating_add(delta.error_records);
                    s.unattributed_udp_errors = s
                        .unattributed_udp_errors
                        .saturating_add(delta.unattributed_errors);
                });
            }
            Internal::TcpRead { key, server_id, read } => {
                if !self.tcp.owns_event(key, server_id) { return Ok(()); }
                for delivery in self.tcp.read(key, server_id, read) {
                    self.output(delivery.event, delivery.guard)?;
                }
            }
            Internal::TcpEof { key, server_id } => {
                if !self.tcp.owns_event(key, server_id) { return Ok(()); }
                for delivery in self.tcp.eof(key, server_id) {
                    self.output(delivery.event, delivery.guard)?;
                }
            }
            Internal::TcpClosed { key, server_id, status } => {
                if !self.tcp.owns_event(key, server_id) { return Ok(()); }
                for delivery in self.tcp.closed(key, server_id, status).await {
                    self.output(delivery.event, delivery.guard)?;
                }
            }
            Internal::TcpWriteDone {
                key,
                server_id,
                amount,
                result,
                ..
            } => {
                if !self.tcp.owns_event(key, server_id) { return Ok(()); }
                for delivery in self.tcp.wrote(key, server_id, amount, result).await {
                    self.output(delivery.event, delivery.guard)?;
                }
            }
            Internal::TcpFinishDone { key, server_id, result } => {
                if !self.tcp.owns_event(key, server_id) { return Ok(()); }
                for delivery in self.tcp.finished(key, server_id, result).await {
                    self.output(delivery.event, delivery.guard)?;
                }
            }
            Internal::UdpReceive { port, datagram } => {
                if let Some(event) = self.udp.receive(port, &datagram) {
                    self.output(event, Some(Box::new(datagram)))?;
                }
            }
            Internal::UdpError { port, error } => {
                if let Some(event) = self.udp.peer_error(port, &error) {
                    self.output(event, None)?;
                }
            }
            Internal::UdpClosed { port, error } => {
                let events = self.udp.port_closed(port, error).await;
                for event in events {
                    self.output(event, None)?;
                }
                self.leases
                    .retain(|_, key| self.udp.flows.contains_key(key));
            }
            Internal::SendDone { key, result, .. } => {
                if self.bindings.is_live(key.binding) && self.udp.flows.contains_key(&key) {
                    match result {
                        SendOutcome::Accepted => {}
                        SendOutcome::Refused(error) => self.error(key, error.code)?,
                        SendOutcome::Unattributed(error) => {
                            self.status.send_modify(|s| {
                                s.dropped_udp_packets = s.dropped_udp_packets.saturating_add(1);
                                s.last_unattributed_send_native_code = Some(error.native_code);
                            });
                        }
                    }
                }
            }
        }
        Ok(())
    }
    async fn sweep(&mut self) {
        self.tcp.inbound.sweep();
        let deadline = Instant::now() - Duration::from_millis(self.config.udp_idle_timeout_ms);
        let keys: Vec<_> = self
            .udp
            .flows
            .iter()
            .filter(|(_, flow)| flow.pins == 0 && flow.seen < deadline)
            .map(|(key, _)| *key)
            .collect();
        for key in keys {
            self.remove_flow(key).await;
        }
        self.raw.sweep(deadline).await;
    }
}
