use crate::{
    ConnId,
    config::{ConfigError, Limits},
    gateway::{BindingRegistry, BindingToken},
    routes::{NativeAddress, ResolveCode, ResolveError, Routes, Target},
    wire::{
        self, Arg, Datagram, DecodeError, InboundEvent, JoinRequest, Node, ServerEvent,
        UdpLeaseRequest,
    },
};
mod host;
mod multicast4;
use host::HostState;
use serde_json::{Value, json};
use std::collections::HashMap;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreError(pub String);
impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for CoreError {}
/// The native adapter consumes these in effect order for each exact ConnId.
#[derive(Debug, Clone)]
pub enum GatewayInput {
    OpenUdpHost {
        operation: u64,
        binding: BindingToken,
        listener: crate::config::UdpListenerConfig,
    },
    HostFrame {
        lease_id: u64,
        binding: BindingToken,
        datagram: Datagram,
    },
    ReleaseUdpHost {
        lease_id: u64,
    },
    Frame {
        datagram: Datagram,
        binding: BindingToken,
        target: Target,
    },
    ReleasePort {
        proto: u8,
        port: u16,
        generation: u32,
    },
    LeaseUdpPeer {
        request_id: u32,
        operation: u64,
        request: UdpLeaseRequest,
        binding: BindingToken,
        target: Target,
    },
    CancelOperation {
        operation: u64,
    },
    ReleaseUdpPeer {
        lease_id: u64,
    },
    Close,
}
#[derive(Debug, Clone)]
pub enum GatewayEvent {
    HostSocketError {
        lease_id: u64,
        binding: BindingToken,
        node: Node,
        remote_port: u16,
        code: u32,
    },
    HostReady {
        operation: u64,
        lease_id: u64,
        node: Node,
        port: u16,
    },
    HostFailed {
        operation: u64,
        code: u32,
    },
    HostClosed {
        lease_id: u64,
        code: u32,
    },
    HostFrame {
        lease_id: u64,
        binding: BindingToken,
        datagram: Datagram,
    },
    Frame {
        binding: BindingToken,
        datagram: Datagram,
    },
    SocketError {
        binding: BindingToken,
        node: Node,
        remote_port: u16,
        code: u32,
        wire_id: Option<u32>,
    },
    LeaseReady {
        operation: u64,
        lease_id: u64,
    },
    LeaseFailed {
        operation: u64,
        code: u32,
    },
}
#[derive(Debug, Clone)]
pub enum Effect {
    Emit {
        to: ConnId,
        event: ServerEvent,
        retained_bytes: usize,
        reliable: bool,
        source: Option<ConnId>,
    },
    Disconnect {
        connection: ConnId,
        reason: &'static str,
    },
    NativeOperation {
        connection: ConnId,
        input: GatewayInput,
    },
    ResolveRoutes {
        connection: ConnId,
        operation: u64,
        request_id: u32,
        route_ids: Vec<usize>,
    },
    CancelResolve {
        connection: ConnId,
        operation: u64,
    },
}
#[derive(Debug)]
pub enum Command {
    Wire {
        connection: ConnId,
        name: String,
        args: Vec<Arg>,
        now_ms: u64,
    },
    Input {
        connection: ConnId,
        event: InboundEvent,
        now_ms: u64,
    },
    Closed {
        connection: ConnId,
        now_ms: u64,
    },
    DeliveryRejected {
        to: ConnId,
        source: Option<ConnId>,
        reliable: bool,
        now_ms: u64,
    },
    GatewayEvent {
        connection: ConnId,
        event: GatewayEvent,
    },
    RoutesResolved {
        connection: ConnId,
        operation: u64,
        resolutions: Vec<(usize, Result<Vec<NativeAddress>, ResolveError>)>,
    },
    Tick {
        now_ms: u64,
    },
}
struct Peer {
    client_id: String,
    connection: Option<ConnId>,
    expires_at: u64,
}
struct Pending {
    request_id: u32,
    binding: BindingToken,
}
struct PendingResolve {
    operation: u64,
    request: wire::ResolveRequest,
    route_ids: Vec<usize>,
}
struct Active {
    request_id: u32,
    binding: BindingToken,
    native_id: u64,
}
struct Participant {
    join: JoinRequest,
    bindings: BindingRegistry,
    multicast_bindings: BindingRegistry,
    window_start: u64,
    frames: u32,
    bytes: usize,
    last_udp_request: u32,
    next_udp_lease: u64,
    pending: HashMap<u64, Pending>,
    active: HashMap<u32, Active>,
    resolving: HashMap<u32, PendingResolve>,
    host: HostState,
}
pub struct Core {
    pub limits: Limits,
    pub routes: Routes,
    rooms: HashMap<String, HashMap<Node, Peer>>,
    participants: HashMap<ConnId, Participant>,
    next_operation: u64,
}
fn emit(to: ConnId, event: ServerEvent, reliable: bool, source: Option<ConnId>) -> Effect {
    let retained_bytes = event.retained_bytes();
    Effect::Emit {
        to,
        event,
        retained_bytes,
        reliable,
        source,
    }
}
fn json_event(name: &'static str, args: Vec<Value>) -> ServerEvent {
    ServerEvent::Json { name, args }
}
fn lease_reply(to: ConnId, id: u32, code: u32) -> Effect {
    emit(
        to,
        json_event(
            "udpPeerLeased",
            vec![
                json!(id),
                json!({"error":{"code":code,"message":"UDP peer lease refused"}}),
            ],
        ),
        true,
        None,
    )
}
impl Core {
    pub fn new(limits: Limits, routes: Routes) -> Result<Self, ConfigError> {
        limits.validate()?;
        Ok(Self {
            limits,
            routes,
            rooms: HashMap::new(),
            participants: HashMap::new(),
            next_operation: 0,
        })
    }
    /// Authenticated identity for trusted gateway construction; unknown/retired
    /// connection IDs never acquire a participant identity.
    pub fn connection_node(&self, connection: ConnId) -> Option<Node> {
        self.participants.get(&connection).map(|p| p.join.node)
    }
    pub fn participant_count(&self) -> usize {
        self.participants.len()
    }
    pub fn room_count(&self) -> usize {
        self.rooms.len()
    }
    pub fn join(
        &mut self,
        connection: ConnId,
        auth: &Value,
        now_ms: u64,
    ) -> Result<Vec<Effect>, CoreError> {
        let join = JoinRequest::decode(auth).map_err(|e| CoreError(e.to_string()))?;
        self.prune(now_ms);
        if connection == 0 || self.participants.contains_key(&connection) {
            return Err(CoreError("Connection identity is already used".into()));
        }
        let mut effects = vec![];
        if let Some(peer) = self
            .rooms
            .get(&join.room)
            .and_then(|room| room.get(&join.node))
        {
            if peer.client_id != join.client_id {
                return Err(CoreError("LAN address already in use".into()));
            }
            if let Some(old) = peer.connection {
                self.disconnect(old, now_ms, "Connection replaced", &mut effects);
            }
        } else {
            if !self.rooms.contains_key(&join.room) && self.rooms.len() >= self.limits.max_rooms {
                return Err(CoreError("LAN room limit reached".into()));
            }
            if self
                .rooms
                .get(&join.room)
                .is_some_and(|r| r.len() >= self.limits.max_peers_per_room)
            {
                return Err(CoreError("LAN room is full".into()));
            }
        }
        self.rooms.entry(join.room.clone()).or_default().insert(
            join.node,
            Peer {
                client_id: join.client_id.clone(),
                connection: Some(connection),
                expires_at: u64::MAX,
            },
        );
        let mut ready = json!({"version":1,"node":join.node,"ipv4":wire::node_ipv4(&join.node),"gatewayIpv4":self.routes.advertised_ipv4(),"gatewayIpv6":[],"udpMulticast4V1":true});
        ready["gatewayIpv6"] = Value::Array(
            self.routes
                .advertised_ipv6()
                .into_iter()
                .map(|a| {
                    let ip = a
                        .address
                        .parse::<std::net::Ipv6Addr>()
                        .expect("registered numeric IPv6");
                    let mut v =
                        json!({"address":ip.octets(),"node":a.node.expect("registered IPv6 node")});
                    if let Some(scope) = a.scope_id {
                        v["scopeId"] = json!(scope)
                    }
                    v
                })
                .collect(),
        );
        if !self.routes.config.udp_listeners.is_empty() {
            ready["udpHostListenV1"] = json!({"listeners":self.routes.config.udp_listeners.iter().map(|l|json!({"id":l.id,"allowedNodes":l.allowed_nodes()})).collect::<Vec<_>>()});
        }
        self.participants.insert(
            connection,
            Participant {
                join,
                bindings: BindingRegistry::default(),
                multicast_bindings: BindingRegistry::default(),
                window_start: now_ms,
                frames: 0,
                bytes: 0,
                last_udp_request: 0,
                next_udp_lease: 1,
                pending: HashMap::new(),
                active: HashMap::new(),
                resolving: HashMap::new(),
                host: HostState::default(),
            },
        );
        effects.push(emit(
            connection,
            json_event("ready", vec![ready]),
            true,
            None,
        ));
        Ok(effects)
    }
    pub fn apply(&mut self, command: Command) -> Vec<Effect> {
        let mut effects = vec![];
        match command {
            Command::Wire {
                connection,
                name,
                args,
                now_ms,
            } => {
                if !self.participants.contains_key(&connection) {
                    return effects;
                }
                match wire::decode_event(&name,&args){
     Ok(event)=>self.input(connection,event,now_ms,&mut effects),
     Err(DecodeError::Fatal(_))=>self.disconnect(connection,now_ms,"Invalid LAN event",&mut effects),
     Err(DecodeError::Lease{id})=>{if self.lease_admission(connection,id,now_ms,&mut effects){effects.push(lease_reply(connection,id,10022))}},
     Err(DecodeError::Host{id})=>self.host_malformed(connection,id,now_ms,&mut effects),
     Err(DecodeError::Resolve{id})=>effects.push(emit(connection,json_event("resolved",vec![json!(id),json!({"error":ResolveError::new(ResolveCode::NoRecovery,"Invalid DNS request")})]),true,None)),
     Err(DecodeError::Ignore)=>{}
    }
            }
            Command::Input {
                connection,
                event,
                now_ms,
            } => {
                if self.participants.contains_key(&connection) {
                    self.input(connection, event, now_ms, &mut effects)
                }
            }
            Command::Closed { connection, now_ms } => self.retire(connection, now_ms, &mut effects),
            Command::DeliveryRejected {
                to,
                source,
                reliable,
                now_ms,
            } => {
                if reliable {
                    self.disconnect(
                        to,
                        now_ms,
                        "Reliable output capacity exceeded",
                        &mut effects,
                    );
                    if let Some(source) = source {
                        if source != to {
                            self.disconnect(
                                source,
                                now_ms,
                                "Reliable destination failed",
                                &mut effects,
                            )
                        }
                    }
                }
            }
            Command::GatewayEvent { connection, event } => {
                self.gateway_event(connection, event, &mut effects)
            }
            Command::RoutesResolved {
                connection,
                operation,
                resolutions,
            } => self.routes_resolved(connection, operation, resolutions, &mut effects),
            Command::Tick { now_ms } => self.prune(now_ms),
        }
        effects
    }
    fn rate(
        &mut self,
        connection: ConnId,
        size: usize,
        now_ms: u64,
        effects: &mut Vec<Effect>,
    ) -> bool {
        let Some(p) = self.participants.get_mut(&connection) else {
            return false;
        };
        if now_ms.saturating_sub(p.window_start) >= 1000 {
            p.window_start = now_ms;
            p.frames = 0;
            p.bytes = 0;
        }
        p.frames = p.frames.saturating_add(1);
        p.bytes = p.bytes.saturating_add(size);
        if p.frames > self.limits.max_frames_per_second
            || p.bytes > self.limits.max_bytes_per_second
        {
            self.disconnect(connection, now_ms, "LAN rate limit exceeded", effects);
            return false;
        }
        true
    }
    fn lease_admission(
        &mut self,
        connection: ConnId,
        id: u32,
        now_ms: u64,
        effects: &mut Vec<Effect>,
    ) -> bool {
        if !self.rate(connection, 64, now_ms, effects) {
            return false;
        }
        let p = self.participants.get_mut(&connection).unwrap();
        if id == 0 || id <= p.last_udp_request {
            self.disconnect(connection, now_ms, "UDP request identity reused", effects);
            return false;
        }
        p.last_udp_request = id;
        true
    }
    fn input(
        &mut self,
        connection: ConnId,
        event: InboundEvent,
        now_ms: u64,
        effects: &mut Vec<Effect>,
    ) {
        match event {
            InboundEvent::Multicast4 {
                datagram,
                generation,
            } => self.multicast4_input(connection, datagram, generation, now_ms, effects),
            InboundEvent::OpenUdpHost { id, request } => {
                self.host_open(connection, id, request, now_ms, effects)
            }
            InboundEvent::CancelUdpHost { id } => self.host_cancel(connection, id, now_ms, effects),
            InboundEvent::ReleaseUdpHost { id } => {
                self.host_release(connection, id, now_ms, effects)
            }
            InboundEvent::Frame {
                datagram,
                generation,
            } => {
                if !self.rate(connection, 12 + datagram.payload.len(), now_ms, effects) {
                    return;
                }
                if datagram.proto == 1 {
                    self.participants
                        .get_mut(&connection)
                        .unwrap()
                        .multicast_bindings
                        .admit(BindingToken {
                            proto: 1,
                            local_port: datagram.src_port,
                            generation,
                        });
                }
                if wire::external_node(&datagram.node) {
                    let binding = BindingToken {
                        proto: datagram.proto,
                        local_port: datagram.src_port,
                        generation,
                    };
                    if !self
                        .participants
                        .get_mut(&connection)
                        .unwrap()
                        .bindings
                        .admit(binding)
                    {
                        return;
                    }
                    if let Some(g) = generation {
                        self.retire_udp(
                            connection,
                            datagram.proto,
                            datagram.src_port,
                            g,
                            false,
                            effects,
                        );
                    }
                    if self.host_outbound(connection, binding, &datagram, effects) {
                        return;
                    }
                    match self.routes.target(&datagram) {
                        Ok(target) => effects.push(Effect::NativeOperation {
                            connection,
                            input: GatewayInput::Frame {
                                datagram,
                                binding,
                                target,
                            },
                        }),
                        Err(_) => self.socket_error(
                            connection,
                            binding,
                            datagram.node,
                            datagram.dst_port,
                            10013,
                            None,
                            effects,
                        ),
                    }
                    return;
                }
                let p = &self.participants[&connection];
                let Some(room) = self.rooms.get(&p.join.room) else {
                    return;
                };
                let broadcast = wire::broadcast(&datagram.node);
                if !broadcast && !wire::unreliable(datagram.proto) {
                    if let Some(peer) = room.get(&datagram.node) {
                        if peer.connection.is_none() {
                            effects.push(emit(
                                connection,
                                json_event("peerLeft", vec![json!({"node":datagram.node})]),
                                true,
                                None,
                            ));
                        }
                    }
                }
                let recipients: Vec<_> = if broadcast {
                    room.values()
                        .filter_map(|p| p.connection)
                        .filter(|c| *c != connection)
                        .collect()
                } else {
                    room.get(&datagram.node)
                        .and_then(|p| p.connection)
                        .filter(|c| *c != connection)
                        .into_iter()
                        .collect()
                };
                let forwarded = Datagram {
                    node: p.join.node,
                    ..datagram
                };
                if let Ok(bytes) = forwarded.encode() {
                    for to in recipients {
                        effects.push(emit(
                            to,
                            ServerEvent::Frame {
                                bytes: bytes.clone(),
                                generation: None,
                            },
                            !wire::unreliable(forwarded.proto),
                            Some(connection),
                        ))
                    }
                }
            }
            InboundEvent::ReleasePort {
                proto,
                port,
                generation,
            } => {
                if !self.rate(connection, 16, now_ms, effects) {
                    return;
                }
                let p = self.participants.get_mut(&connection).unwrap();
                if proto == 1 {
                    p.multicast_bindings.release(proto, port, generation);
                }
                if p.bindings.release(proto, port, generation) {
                    self.retire_udp(connection, proto, port, generation, true, effects);
                    effects.push(Effect::NativeOperation {
                        connection,
                        input: GatewayInput::ReleasePort {
                            proto,
                            port,
                            generation,
                        },
                    })
                }
            }
            InboundEvent::Resolve { id, request } => {
                let p = &self.participants[&connection];
                if p.resolving.contains_key(&id) {
                    return;
                }
                if p.resolving.len() >= 16 {
                    self.resolve_error(
                        connection,
                        id,
                        ResolveError::new(ResolveCode::TryAgain, "Too many DNS requests"),
                        effects,
                    );
                    return;
                }
                let route_ids = match self.routes.selected_route_ids(&request) {
                    Ok(ids) => ids,
                    Err(error) => {
                        self.resolve_error(connection, id, error, effects);
                        return;
                    }
                };
                let Some(operation) = self.next_operation.checked_add(1) else {
                    self.resolve_error(
                        connection,
                        id,
                        ResolveError::new(ResolveCode::TryAgain, "DNS identity exhausted"),
                        effects,
                    );
                    return;
                };
                self.next_operation = operation;
                self.participants
                    .get_mut(&connection)
                    .unwrap()
                    .resolving
                    .insert(
                        id,
                        PendingResolve {
                            operation,
                            request,
                            route_ids: route_ids.clone(),
                        },
                    );
                effects.push(Effect::ResolveRoutes {
                    connection,
                    operation,
                    request_id: id,
                    route_ids,
                });
            }
            InboundEvent::CancelResolve { id } => {
                if let Some(pending) = self
                    .participants
                    .get_mut(&connection)
                    .unwrap()
                    .resolving
                    .remove(&id)
                {
                    effects.push(Effect::CancelResolve {
                        connection,
                        operation: pending.operation,
                    })
                }
            }
            InboundEvent::LeaseUdpPeer { id, request } => {
                if !self.lease_admission(connection, id, now_ms, effects) {
                    return;
                }
                let p = &self.participants[&connection];
                if p.pending.len() >= 16
                    || p.active.len() + p.pending.len() >= self.routes.config.max_udp_flows.min(128)
                {
                    effects.push(lease_reply(connection, id, 10055));
                    return;
                }
                let binding = BindingToken {
                    proto: request.proto,
                    local_port: request.local_port,
                    generation: Some(request.binding_generation),
                };
                if !self
                    .participants
                    .get_mut(&connection)
                    .unwrap()
                    .bindings
                    .admit(binding)
                {
                    effects.push(lease_reply(connection, id, 10057));
                    return;
                }
                if request.proto == 1 {
                    self.participants
                        .get_mut(&connection)
                        .unwrap()
                        .multicast_bindings
                        .admit(binding);
                }
                self.retire_udp(
                    connection,
                    request.proto,
                    request.local_port,
                    request.binding_generation,
                    false,
                    effects,
                );
                if self.host_binding_owned(connection, binding) {
                    effects.push(lease_reply(connection, id, 10048));
                    return;
                }
                let d = Datagram {
                    proto: request.proto,
                    node: request.node,
                    src_port: request.local_port,
                    dst_port: request.remote_port,
                    payload: bytes::Bytes::new(),
                };
                let target = match self.routes.target(&d) {
                    Ok(t) => t,
                    Err(_) => {
                        effects.push(lease_reply(connection, id, 10013));
                        return;
                    }
                };
                let Some(operation) = self.next_operation.checked_add(1) else {
                    effects.push(lease_reply(connection, id, 10055));
                    return;
                };
                self.next_operation = operation;
                self.participants
                    .get_mut(&connection)
                    .unwrap()
                    .pending
                    .insert(
                        operation,
                        Pending {
                            request_id: id,
                            binding,
                        },
                    );
                effects.push(Effect::NativeOperation {
                    connection,
                    input: GatewayInput::LeaseUdpPeer {
                        request_id: id,
                        operation,
                        request,
                        binding,
                        target,
                    },
                })
            }
            InboundEvent::CancelUdpPeer { id } => {
                if !self.rate(connection, 16, now_ms, effects) {
                    return;
                }
                let p = self.participants.get_mut(&connection).unwrap();
                let operations: Vec<_> = p
                    .pending
                    .iter()
                    .filter(|(_, v)| v.request_id == id)
                    .map(|(op, _)| *op)
                    .collect();
                for operation in operations {
                    p.pending.remove(&operation);
                    effects.push(Effect::NativeOperation {
                        connection,
                        input: GatewayInput::CancelOperation { operation },
                    });
                }
                let ids: Vec<_> = p
                    .active
                    .iter()
                    .filter(|(_, v)| v.request_id == id)
                    .map(|(id, _)| *id)
                    .collect();
                for id in ids {
                    let active = p.active.remove(&id).unwrap();
                    effects.push(Effect::NativeOperation {
                        connection,
                        input: GatewayInput::ReleaseUdpPeer {
                            lease_id: active.native_id,
                        },
                    });
                }
            }
            InboundEvent::ReleaseUdpPeer { id } => {
                if !self.rate(connection, 16, now_ms, effects) {
                    return;
                }
                if let Some(active) = self
                    .participants
                    .get_mut(&connection)
                    .unwrap()
                    .active
                    .remove(&id)
                {
                    effects.push(Effect::NativeOperation {
                        connection,
                        input: GatewayInput::ReleaseUdpPeer {
                            lease_id: active.native_id,
                        },
                    });
                }
            }
        }
    }
    fn retire_udp(
        &mut self,
        connection: ConnId,
        proto: u8,
        port: u16,
        generation: u32,
        inclusive: bool,
        effects: &mut Vec<Effect>,
    ) {
        self.host_retire_binding(connection, proto, port, generation, inclusive, effects);
        let Some(p) = self.participants.get_mut(&connection) else {
            return;
        };
        let matches = |b: BindingToken| {
            b.proto == proto
                && b.local_port == port
                && b.generation.is_none_or(|g| {
                    if inclusive {
                        g <= generation
                    } else {
                        g < generation
                    }
                })
        };
        let pending: Vec<_> = p
            .pending
            .iter()
            .filter(|(_, v)| matches(v.binding))
            .map(|(op, _)| *op)
            .collect();
        for operation in pending {
            p.pending.remove(&operation);
            effects.push(Effect::NativeOperation {
                connection,
                input: GatewayInput::CancelOperation { operation },
            });
        }
        let active: Vec<_> = p
            .active
            .iter()
            .filter(|(_, v)| matches(v.binding))
            .map(|(id, _)| *id)
            .collect();
        for id in active {
            let active = p.active.remove(&id).unwrap();
            effects.push(Effect::NativeOperation {
                connection,
                input: GatewayInput::ReleaseUdpPeer {
                    lease_id: active.native_id,
                },
            });
        }
    }
    fn gateway_event(
        &mut self,
        connection: ConnId,
        event: GatewayEvent,
        effects: &mut Vec<Effect>,
    ) {
        match event {
            GatewayEvent::HostSocketError {
                lease_id,
                binding,
                node,
                remote_port,
                code,
            } => self.host_socket_error(
                connection,
                lease_id,
                binding,
                node,
                remote_port,
                code,
                effects,
            ),
            GatewayEvent::HostReady {
                operation,
                lease_id,
                node,
                port,
            } => self.host_ready(connection, operation, lease_id, node, port, effects),
            GatewayEvent::HostFailed { operation, code } => {
                self.host_failed(connection, operation, code, effects)
            }
            GatewayEvent::HostClosed { lease_id, code } => {
                self.host_closed(connection, lease_id, code, effects)
            }
            GatewayEvent::HostFrame {
                lease_id,
                binding,
                datagram,
            } => self.host_inbound(connection, lease_id, binding, datagram, effects),
            GatewayEvent::Frame { binding, datagram } => {
                if self
                    .participants
                    .get(&connection)
                    .is_none_or(|p| !p.bindings.is_live(binding))
                    || self.host_binding_owned(connection, binding)
                    || datagram.proto != binding.proto
                    || datagram.dst_port != binding.local_port
                {
                    return;
                }
                if let Ok(bytes) = datagram.encode() {
                    effects.push(emit(
                        connection,
                        ServerEvent::Frame {
                            bytes,
                            generation: binding.generation,
                        },
                        !wire::unreliable(binding.proto),
                        None,
                    ))
                }
            }
            GatewayEvent::SocketError {
                binding,
                node,
                remote_port,
                code,
                wire_id,
            } => {
                if !self.host_binding_owned(connection, binding) {
                    self.socket_error(
                        connection,
                        binding,
                        node,
                        remote_port,
                        code,
                        wire_id,
                        effects,
                    );
                }
            }
            GatewayEvent::LeaseReady {
                operation,
                lease_id,
            } => {
                let pending = self
                    .participants
                    .get_mut(&connection)
                    .and_then(|p| p.pending.remove(&operation));
                let Some(pending) = pending else {
                    effects.push(Effect::NativeOperation {
                        connection,
                        input: GatewayInput::ReleaseUdpPeer { lease_id },
                    });
                    return;
                };
                let p = self.participants.get_mut(&connection).unwrap();
                if !p.bindings.is_live(pending.binding) || p.next_udp_lease > u32::MAX as u64 {
                    effects.push(Effect::NativeOperation {
                        connection,
                        input: GatewayInput::ReleaseUdpPeer { lease_id },
                    });
                    if p.bindings.is_live(pending.binding) {
                        effects.push(lease_reply(connection, pending.request_id, 10055))
                    }
                    return;
                }
                let id = p.next_udp_lease as u32;
                p.next_udp_lease += 1;
                p.active.insert(
                    id,
                    Active {
                        request_id: pending.request_id,
                        binding: pending.binding,
                        native_id: lease_id,
                    },
                );
                effects.push(emit(
                    connection,
                    json_event(
                        "udpPeerLeased",
                        vec![json!(pending.request_id), json!({"leaseId":id})],
                    ),
                    true,
                    None,
                ));
            }
            GatewayEvent::LeaseFailed { operation, code } => {
                if let Some(p) = self.participants.get_mut(&connection) {
                    if let Some(pending) = p.pending.remove(&operation) {
                        if p.bindings.is_live(pending.binding) {
                            effects.push(lease_reply(connection, pending.request_id, code));
                        }
                    }
                }
            }
        }
    }
    fn resolve_error(
        &self,
        connection: ConnId,
        id: u32,
        error: ResolveError,
        effects: &mut Vec<Effect>,
    ) {
        effects.push(emit(
            connection,
            json_event("resolved", vec![json!(id), json!({"error":error})]),
            true,
            None,
        ))
    }
    fn routes_resolved(
        &mut self,
        connection: ConnId,
        operation: u64,
        resolutions: Vec<(usize, Result<Vec<NativeAddress>, ResolveError>)>,
        effects: &mut Vec<Effect>,
    ) {
        let Some(p) = self.participants.get_mut(&connection) else {
            return;
        };
        let Some(id) = p.resolving.iter().find_map(|(id, p)| {
            if p.operation == operation {
                Some(*id)
            } else {
                None
            }
        }) else {
            return;
        };
        let pending = p.resolving.remove(&id).unwrap();
        let mut expected = pending.route_ids.clone();
        expected.sort_unstable();
        let mut actual: Vec<_> = resolutions.iter().map(|(id, _)| *id).collect();
        actual.sort_unstable();
        if actual != expected {
            self.resolve_error(
                connection,
                id,
                ResolveError::new(
                    ResolveCode::NoRecovery,
                    "Resolver returned unexpected routes",
                ),
                effects,
            );
            return;
        }
        for (route, result) in resolutions {
            if let Err(error) = self.routes.pin(route, result) {
                self.resolve_error(
                    connection,
                    id,
                    ResolveError::new(ResolveCode::TryAgain, &error.to_string()),
                    effects,
                );
                return;
            }
        }
        let reply = match self.routes.resolve(&pending.request) {
            Ok(result) => json!({"result":result}),
            Err(error) => json!({"error":error}),
        };
        effects.push(emit(
            connection,
            json_event("resolved", vec![json!(id), reply]),
            true,
            None,
        ));
    }
    fn socket_error(
        &self,
        connection: ConnId,
        binding: BindingToken,
        node: Node,
        remote_port: u16,
        code: u32,
        wire_id: Option<u32>,
        effects: &mut Vec<Effect>,
    ) {
        if self
            .participants
            .get(&connection)
            .is_none_or(|p| !p.bindings.is_live(binding))
        {
            return;
        }
        let mut error = json!({"node":node,"localPort":binding.local_port,"remotePort":remote_port,"proto":binding.proto,"code":code});
        if let Some(g) = binding.generation {
            error["bindingGeneration"] = json!(g)
        }
        if let Some(id) = wire_id {
            error["wireId"] = json!(id)
        }
        effects.push(emit(
            connection,
            json_event("socketError", vec![error]),
            true,
            None,
        ))
    }
    fn disconnect(
        &mut self,
        connection: ConnId,
        now_ms: u64,
        reason: &'static str,
        effects: &mut Vec<Effect>,
    ) {
        if self.participants.contains_key(&connection) {
            effects.push(Effect::Disconnect { connection, reason });
            self.retire(connection, now_ms, effects);
        }
    }
    fn retire(&mut self, connection: ConnId, now_ms: u64, effects: &mut Vec<Effect>) {
        let Some(p) = self.participants.remove(&connection) else {
            return;
        };
        for pending in p.resolving.values() {
            effects.push(Effect::CancelResolve {
                connection,
                operation: pending.operation,
            });
        }
        for operation in p.host.pending_operations() {
            effects.push(Effect::NativeOperation {
                connection,
                input: GatewayInput::CancelOperation { operation },
            });
        }
        for operation in p.pending.keys() {
            effects.push(Effect::NativeOperation {
                connection,
                input: GatewayInput::CancelOperation {
                    operation: *operation,
                },
            })
        }
        // Close owns every native lease/flow, including ACKs already queued by the adapter.
        effects.push(Effect::NativeOperation {
            connection,
            input: GatewayInput::Close,
        });
        if let Some(room) = self.rooms.get_mut(&p.join.room) {
            if let Some(peer) = room.get_mut(&p.join.node) {
                if peer.connection != Some(connection) {
                    return;
                }
                peer.connection = None;
                peer.expires_at = now_ms.saturating_add(self.limits.reconnect_grace_ms);
            }
            for recipient in room.values().filter_map(|p| p.connection) {
                effects.push(emit(
                    recipient,
                    json_event("peerLeft", vec![json!({"node":p.join.node})]),
                    true,
                    None,
                ));
            }
        }
    }
    fn prune(&mut self, now_ms: u64) {
        self.rooms.retain(|_, room| {
            room.retain(|_, peer| peer.connection.is_some() || peer.expires_at > now_ms);
            !room.is_empty()
        });
    }
}
