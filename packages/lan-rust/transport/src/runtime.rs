use crate::{
    budget::{Budget, Lease, Leases},
    codec::{self, Header},
    *,
};
use bytes::Bytes;
use engineioxide::{
    DisconnectReason, Socket, Str, config::EngineIoConfig, handler::EngineIoHandler,
    service::EngineIoService,
};
use engineioxide_core::TransportType;
use http_body_util::Empty;
use hyper::{
    Request, Response,
    body::Incoming as HttpIncoming,
    service::{Service, service_fn},
};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::{
    collections::HashMap,
    convert::Infallible,
    io,
    net::SocketAddr,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Instant,
};
use tokio::{
    net::TcpListener,
    sync::{Notify, mpsc, oneshot},
};
use tokio_util::sync::CancellationToken;
type HttpBody = engineioxide::ResponseBody<engineioxide::ResponseBody<Empty<Bytes>>>;
type ESocket = Socket<SocketData>;
#[derive(Debug, Default)]
struct SocketData(Mutex<Option<Arc<Connection>>>);
#[derive(Debug)]
struct TcpState {
    cancel: CancellationToken,
    done: AtomicBool,
    changed: Notify,
    sessions: Arc<Budget>,
    bound: Mutex<Option<ConnId>>,
}
struct TcpDone(Arc<TcpState>);
impl Drop for TcpDone {
    fn drop(&mut self) {
        self.0.end();
    }
}
impl TcpState {
    fn end(&self) {
        self.done.store(true, Ordering::Release);
        self.changed.notify_waiters();
    }
    async fn closed(&self) {
        loop {
            let n = self.changed.notified();
            if self.done.load(Ordering::Acquire) {
                return;
            }
            n.await
        }
    }
}
#[derive(Clone, Debug)]
struct RequestContext {
    peer: SocketAddr,
    origin: Option<String>,
    tcp: Arc<TcpState>,
    reservation: Option<Arc<Leases>>,
}
#[derive(Debug)]
struct Pending {
    name: String,
    args: Vec<serde_json::Value>,
    expected: usize,
    binary: Vec<Bytes>,
    bytes: usize,
    deadline: Instant,
    lease: Leases,
}
#[derive(Debug)]
struct State {
    phase: u8,
    sequence: u64,
    pending: Option<Pending>,
}
#[derive(Debug)]
struct Connection {
    id: ConnId,
    socket: Weak<ESocket>,
    live: AtomicBool,
    retired: AtomicBool,
    changed: Notify,
    state: Mutex<State>,
    tcp: Mutex<Vec<Arc<TcpState>>>,
    reservation: Mutex<Option<Arc<Leases>>>,
    ingress: Arc<Budget>,
    output: Arc<Budget>,
    encoded: Arc<Budget>,
    cancel: CancellationToken,
}
#[derive(Debug)]
struct Shared {
    config: Config,
    next: AtomicU64,
    all: Mutex<HashMap<ConnId, Arc<Connection>>>,
    retiring: Mutex<HashMap<ConnId, Arc<Connection>>>,
    sids: Mutex<HashMap<String, Weak<Connection>>>,
    incoming: mpsc::Sender<Incoming>,
    session_budget: Arc<Budget>,
    tcp_budget: Arc<Budget>,
    ingress: Arc<Budget>,
    output: Arc<Budget>,
    shutdown: CancellationToken,
}
#[derive(Clone, Debug)]
pub struct TransportHandle {
    shared: Arc<Shared>,
}
pub struct BoundTransport {
    pub address: SocketAddr,
    pub handle: TransportHandle,
    pub incoming: IncomingReceiver,
    task: Option<tokio::task::JoinHandle<()>>,
}
#[derive(Clone, Debug)]
pub struct CloseReceipt {
    connection: Arc<Connection>,
}
impl CloseReceipt {
    pub async fn retired(&self) {
        loop {
            let n = self.connection.changed.notified();
            if self.connection.retired.load(Ordering::Acquire) {
                return;
            }
            n.await;
        }
    }
}
#[derive(Debug, Default)]
struct ReleaseState {
    released: AtomicBool,
    changed: Notify,
}
#[derive(Clone, Debug)]
pub struct DeliveryTicket(Arc<ReleaseState>);
impl DeliveryTicket {
    /// Ownership has left queues/sinks or was discarded by retirement. This is not a peer ACK.
    pub async fn released(&self) {
        loop {
            let n = self.0.changed.notified();
            if self.0.released.load(Ordering::Acquire) {
                return;
            }
            n.await
        }
    }
    pub fn is_released(&self) -> bool {
        self.0.released.load(Ordering::Acquire)
    }
}
#[derive(Debug)]
struct OutputLease {
    _leases: Vec<Lease>,
    ticket: Arc<ReleaseState>,
    connection: Weak<Connection>,
}
impl Drop for OutputLease {
    fn drop(&mut self) {
        self._leases.clear();
        self.ticket.released.store(true, Ordering::Release);
        self.ticket.changed.notify_waiters();
        if let Some(c) = self.connection.upgrade() {
            c.changed.notify_waiters();
        }
    }
}
impl Shared {
    fn enqueue_authorize(&self, c: &Arc<Connection>, kind: IncomingKind, lease: Leases) -> bool {
        // Same state lock as abort: Authorize can never be published behind Closed.
        let state = c.state.lock().unwrap();
        if !c.live.load(Ordering::Acquire) || state.phase != 2 {
            return false;
        }
        let hold = c.reservation.lock().unwrap().clone();
        self.incoming
            .try_send(Incoming {
                connection: c.id,
                kind,
                lease: Some(lease),
                _hold: hold,
            })
            .is_ok()
    }
    fn lifecycle(&self, c: &Arc<Connection>, kind: IncomingKind) -> bool {
        let hold = c.reservation.lock().unwrap().clone();
        self.incoming
            .try_send(Incoming {
                connection: c.id,
                kind,
                lease: None,
                _hold: hold,
            })
            .is_ok()
    }
    fn abort(&self, c: &Arc<Connection>, reason: String) {
        {
            let mut s = c.state.lock().unwrap();
            if !c.live.swap(false, Ordering::AcqRel) {
                return;
            }
            s.phase = 4;
            s.pending = None;
        }
        c.cancel.cancel();
        self.all.lock().unwrap().remove(&c.id);
        if let Some(socket) = c.socket.upgrade() {
            self.sids.lock().unwrap().remove(&socket.id.to_string());
            // Invalidate SID and wake every writer synchronously, independent of queue permits.
            socket.force_close(DisconnectReason::TransportClose);
        }
        for tcp in c.tcp.lock().unwrap().iter() {
            tcp.cancel.cancel();
        }
        let reason = reason.chars().take(256).collect();
        let _ = self.lifecycle(c, IncomingKind::Closed { reason });
    }
    fn attach_tcp(&self, c: &Arc<Connection>, tcp: &Arc<TcpState>) -> bool {
        let mut bound = tcp.bound.lock().unwrap();
        if bound.is_some_and(|id| id != c.id) {
            return false;
        }
        *bound = Some(c.id);
        let mut list = c.tcp.lock().unwrap();
        list.retain(|t| !t.done.load(Ordering::Acquire));
        if !list.iter().any(|t| Arc::ptr_eq(t, tcp)) {
            if list.len() >= self.config.max_requests_per_session {
                return false;
            }
            list.push(tcp.clone());
        }
        true
    }
    fn deliver(
        &self,
        c: &Arc<Connection>,
        name: String,
        args: Vec<Arg>,
        lease: Leases,
        state: &mut State,
    ) -> bool {
        state.sequence = match state.sequence.checked_add(1) {
            Some(s) => s,
            None => return false,
        };
        let hold = c.reservation.lock().unwrap().clone();
        self.incoming
            .try_send(Incoming {
                connection: c.id,
                kind: IncomingKind::Message {
                    sequence: state.sequence,
                    name,
                    args,
                },
                lease: Some(lease),
                _hold: hold,
            })
            .is_ok()
    }
}
impl TransportHandle {
    pub fn is_live(&self, id: ConnId) -> bool {
        self.shared
            .all
            .lock()
            .unwrap()
            .get(&id)
            .is_some_and(|c| c.live.load(Ordering::Acquire))
    }
    pub fn metrics(&self) -> Metrics {
        Metrics {
            sessions: self.shared.session_budget.used().records,
            tcp_connections: self.shared.tcp_budget.used().records,
            ingress: self.shared.ingress.used(),
            output: self.shared.output.used(),
        }
    }
    pub fn abort(&self, id: ConnId, reason: impl Into<String>) -> Option<CloseReceipt> {
        let c = self.shared.all.lock().unwrap().get(&id).cloned()?;
        self.shared.abort(&c, reason.into());
        Some(CloseReceipt { connection: c })
    }
    pub fn try_emit(&self, event: Egress) -> Result<DeliveryTicket, OutputRejected> {
        let reject = |reason| OutputRejected {
            recipient: event.recipient,
            sender: event.sender,
            reliable: event.reliable,
            reason,
        };
        let c = self
            .shared
            .all
            .lock()
            .unwrap()
            .get(&event.recipient)
            .cloned()
            .ok_or_else(|| reject("Connection retired"))?;
        if !c.live.load(Ordering::Acquire) || c.state.lock().unwrap().phase != 3 {
            return Err(reject("Namespace not active"));
        }
        let measured = codec::measure(&event.event).map_err(|_| reject("Invalid output event"))?;
        // Reserve before JSON serialization or the opaque Engine.IO queue.
        let logical = measured.logical.max(event.retained_bytes);
        let a = c
            .output
            .try_acquire(1, logical)
            .ok_or_else(|| reject("Output record/byte budget exhausted"))?;
        let b = c
            .encoded
            .try_acquire(0, measured.encoded_bound)
            .ok_or_else(|| reject("Encoded output budget exhausted"))?;
        let d = self
            .shared
            .output
            .try_acquire(1, logical.saturating_add(measured.encoded_bound))
            .ok_or_else(|| reject("Global output budget exhausted"))?;
        let encoded = codec::encode(&event.event).map_err(|_| reject("Invalid output event"))?;
        let ticket = Arc::new(ReleaseState::default());
        let owner = Arc::new(OutputLease {
            _leases: vec![a, b, d],
            ticket: ticket.clone(),
            connection: Arc::downgrade(&c),
        });
        let socket = c
            .socket
            .upgrade()
            .ok_or_else(|| reject("Connection retired"))?;
        socket
            .emit_tracked(encoded.header.into(), encoded.binary, owner)
            .map_err(|_| reject("Engine output queue refused"))?;
        Ok(DeliveryTicket(ticket))
    }
    fn request_shutdown(&self) -> Vec<Arc<Connection>> {
        self.shared.shutdown.cancel();
        let connections: Vec<_> = {
            let _registration = self.shared.all.lock().unwrap();
            self.shared
                .retiring
                .lock()
                .unwrap()
                .values()
                .cloned()
                .collect()
        };
        for c in &connections {
            self.shared.abort(c, "Server shutdown".into());
        }
        connections
    }
    pub async fn shutdown(&self) {
        for c in self.request_shutdown() {
            CloseReceipt { connection: c }.retired().await;
        }
    }
}
impl BoundTransport {
    pub async fn shutdown(mut self) {
        self.handle.shutdown().await;
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}
impl Drop for BoundTransport {
    fn drop(&mut self) {
        // Admission and SID retirement cannot depend on queue capacity or on
        // polling a shutdown future after its owning dispatcher was cancelled.
        self.handle.request_shutdown();
    }
}
#[derive(Debug)]
struct Handler(Arc<Shared>);
impl Handler {
    fn connection(socket: &Arc<ESocket>) -> Option<Arc<Connection>> {
        socket.data.0.lock().unwrap().clone()
    }
    fn fail(&self, c: &Arc<Connection>, reason: &str) {
        self.0.abort(c, reason.into());
    }
    fn authorize(
        self: &Arc<Self>,
        socket: Arc<ESocket>,
        c: Arc<Connection>,
        auth: serde_json::Value,
        lease: Leases,
    ) {
        let (tx, rx) = oneshot::channel();
        let Some(ctx) = socket.req_parts.extensions.get::<RequestContext>() else {
            self.fail(&c, "Missing admission context");
            return;
        };
        let request = RequestMeta {
            peer: ctx.peer,
            origin: ctx.origin.clone(),
        };
        if !self.0.enqueue_authorize(
            &c,
            IncomingKind::Authorize {
                auth,
                request,
                reply: tx,
            },
            lease,
        ) {
            self.fail(&c, "Authorization queue full or retired");
            return;
        }
        let handler = self.clone();
        // Exactly one bounded authorization task per admitted session; never one task per event.
        tokio::spawn(async move {
            let decision = tokio::select! {biased;_=c.cancel.cancelled()=>return,result=tokio::time::timeout(handler.0.config.authorization_timeout,rx)=>match result{Ok(Ok(value))=>value,_=>Err("Authorization timed out".into())}};
            if let Err(reason) = decision {
                if !c.live.load(Ordering::Acquire) {
                    return;
                }
                let reason: String = reason.chars().take(256).collect();
                let message = format!("4{}", serde_json::json!({"message":reason}));
                let ticket = Arc::new(ReleaseState::default());
                if let (Some(a), Some(b), Some(d)) = (
                    c.output.try_acquire(1, message.len()),
                    c.encoded.try_acquire(0, message.len() * 2 + 32),
                    handler.0.output.try_acquire(1, message.len() * 3 + 32),
                ) {
                    let owner = Arc::new(OutputLease {
                        _leases: vec![a, b, d],
                        ticket: ticket.clone(),
                        connection: Arc::downgrade(&c),
                    });
                    if socket
                        .emit_tracked(message.into(), Default::default(), owner)
                        .is_ok()
                    {
                        let _ = tokio::time::timeout(
                            Duration::from_millis(500),
                            DeliveryTicket(ticket).released(),
                        )
                        .await;
                    }
                }
                handler.fail(&c, "Authorization rejected or timed out");
                return;
            }
            let mut state = c.state.lock().unwrap();
            if !c.live.load(Ordering::Acquire) || state.phase != 2 {
                return;
            }
            let ack = serde_json::json!({"sid":c.id.to_string()}).to_string();
            if socket.emit(format!("0{ack}")).is_err() {
                drop(state);
                handler.fail(&c, "Namespace ACK queue full");
                return;
            }
            state.phase = 3;
            let activated = handler.0.lifecycle(&c, IncomingKind::Activated);
            drop(state);
            if !activated {
                handler.fail(&c, "Activation queue full");
            }
        });
    }
}
impl EngineIoHandler for Handler {
    type Data = SocketData;
    fn on_connect(self: Arc<Self>, socket: Arc<ESocket>) {
        let Some(ctx) = socket.req_parts.extensions.get::<RequestContext>().cloned() else {
            socket.force_close(DisconnectReason::TransportError);
            return;
        };
        let Some(reservation) = ctx.reservation else {
            socket.force_close(DisconnectReason::TransportError);
            return;
        };
        let id = self.0.next.fetch_add(1, Ordering::Relaxed);
        if id == 0 || id == u64::MAX {
            socket.force_close(DisconnectReason::ClosingServer);
            return;
        }
        let c = Arc::new(Connection {
            id,
            socket: Arc::downgrade(&socket),
            live: AtomicBool::new(true),
            retired: AtomicBool::new(false),
            changed: Notify::new(),
            state: Mutex::new(State {
                phase: 1,
                sequence: 0,
                pending: None,
            }),
            tcp: Mutex::new(vec![ctx.tcp.clone()]),
            reservation: Mutex::new(Some(reservation)),
            ingress: Budget::new(self.0.config.ingress_records, self.0.config.ingress_bytes),
            output: Budget::new(self.0.config.output_records, self.0.config.output_bytes),
            encoded: Budget::new(usize::MAX, self.0.config.encoded_output_bytes),
            cancel: CancellationToken::new(),
        });
        *ctx.tcp.bound.lock().unwrap() = Some(id);
        {
            let mut all = self.0.all.lock().unwrap();
            if self.0.shutdown.is_cancelled() {
                socket.force_close(DisconnectReason::ClosingServer);
                return;
            }
            *socket.data.0.lock().unwrap() = Some(c.clone());
            all.insert(id, c.clone());
            self.0.retiring.lock().unwrap().insert(id, c.clone());
            self.0
                .sids
                .lock()
                .unwrap()
                .insert(socket.id.to_string(), Arc::downgrade(&c));
        }
        let handler = self.clone();
        let watch = c.clone();
        tokio::spawn(async move {
            let start = Instant::now();
            let mut interval = tokio::time::interval(Duration::from_millis(100));
            loop {
                tokio::select! {biased;_=watch.cancel.cancelled()=>break,_=interval.tick()=>{}}
                let timed_out = {
                    let s = watch.state.lock().unwrap();
                    (s.phase < 3 && start.elapsed() > handler.0.config.authorization_timeout)
                        || s.pending
                            .as_ref()
                            .is_some_and(|p| Instant::now() > p.deadline)
                };
                if timed_out {
                    handler.fail(&watch, "Handshake/binary timeout");
                    break;
                }
            }
        });
        let retiring = self.0.clone();
        tokio::spawn(async move {
            socket.retired().await;
            drop(socket);
            let tcp = c.tcp.lock().unwrap().clone();
            for t in tcp {
                t.cancel.cancel();
                t.closed().await;
            }
            // Polling body Bytes may still be owned by Hyper until the TCP tasks have ended.
            loop {
                let changed = c.changed.notified();
                if c.output.used().records == 0 {
                    break;
                }
                changed.await;
            }
            c.reservation.lock().unwrap().take();
            c.retired.store(true, Ordering::Release);
            retiring.retiring.lock().unwrap().remove(&c.id);
            c.changed.notify_waiters();
        });
    }
    fn on_disconnect(&self, socket: Arc<ESocket>, reason: DisconnectReason) {
        if let Some(c) = Self::connection(&socket) {
            self.0.abort(&c, format!("{reason:?}"));
        }
    }
    fn on_message(self: &Arc<Self>, msg: Str, socket: Arc<ESocket>) {
        let Some(c) = Self::connection(&socket) else {
            return;
        };
        if !c.live.load(Ordering::Acquire) {
            return;
        }
        let Some(mut lease) = Leases::acquire(&c.ingress, &self.0.ingress, 1, 0) else {
            self.fail(&c, "Ingress record budget exhausted");
            return;
        };
        // Reserve a conservative parser expansion bound before serde allocates a tree.
        // BTreeMap nodes and Value/Vec capacities are charged separately after parsing.
        if msg.len() > codec::MAX_JSON {
            self.fail(&c, "Metadata too large");
            return;
        }
        let Some(_parser) = self.0.ingress.try_acquire(0, msg.len() * 256 + 4096) else {
            self.fail(&c, "Parser memory budget exhausted");
            return;
        };
        let parsed = match codec::header(msg.as_str()) {
            Ok(p) => p,
            Err(_) => {
                self.fail(&c, "Malformed Socket.IO packet");
                return;
            }
        };
        let charge = codec::retained_header(&parsed)
            + if matches!(&parsed,Header::Event{attachments,..} if *attachments>0) {
                codec::MAX_BINARY
            } else {
                0
            };
        let Some(mut memory) = Leases::acquire(&c.ingress, &self.0.ingress, 0, charge) else {
            self.fail(&c, "Ingress memory budget exhausted");
            return;
        };
        lease.0.append(&mut memory.0);
        let mut state = c.state.lock().unwrap();
        if state.pending.is_some() {
            drop(state);
            self.fail(&c, "Binary packet interrupted");
            return;
        }
        match parsed {
            Header::Connect(auth) if state.phase == 1 => {
                state.phase = 2;
                drop(state);
                self.authorize(socket, c, auth, lease);
            }
            Header::Disconnect => {
                drop(state);
                self.fail(&c, "Client namespace disconnect");
            }
            Header::Event {
                name,
                args,
                attachments,
            } if state.phase == 3 => {
                if attachments > 0 {
                    state.pending = Some(Pending {
                        name,
                        args,
                        expected: attachments,
                        binary: Vec::with_capacity(attachments),
                        bytes: 0,
                        deadline: Instant::now() + self.0.config.binary_timeout,
                        lease,
                    });
                } else {
                    let ok = codec::arguments(args, vec![])
                        .is_ok_and(|args| self.0.deliver(&c, name, args, lease, &mut state));
                    drop(state);
                    if !ok {
                        self.fail(&c, "Invalid arguments or full ingress queue");
                    }
                }
            }
            _ => {
                drop(state);
                self.fail(&c, "Unexpected namespace state");
            }
        }
    }
    fn on_binary(self: &Arc<Self>, data: Bytes, socket: Arc<ESocket>) {
        let Some(c) = Self::connection(&socket) else {
            return;
        };
        if !c.live.load(Ordering::Acquire) {
            return;
        }
        let mut state = c.state.lock().unwrap();
        let Some(mut pending) = state.pending.take() else {
            drop(state);
            self.fail(&c, "Unexpected binary packet");
            return;
        };
        pending.bytes = match pending
            .bytes
            .checked_add(data.len())
            .filter(|n| *n <= codec::MAX_BINARY)
        {
            Some(n) => n,
            None => {
                drop(state);
                self.fail(&c, "Binary byte budget exceeded");
                return;
            }
        };
        // Do not retain an opaque upstream read slab through a tiny Bytes slice.
        // The owned copy is made only after the whole binary-message budget was reserved.
        pending.binary.push(Bytes::copy_from_slice(&data));
        if pending.binary.len() == pending.expected {
            // The max-size reservation protected all attachment allocations.
            // Completed messages retain only their owned bytes, so one legal
            // stream window does not consume sixteen maximum-datagram slots.
            pending
                .lease
                .release_bytes(codec::MAX_BINARY - pending.bytes);
            let ok = codec::arguments(pending.args, pending.binary).is_ok_and(|args| {
                self.0
                    .deliver(&c, pending.name, args, pending.lease, &mut state)
            });
            drop(state);
            if !ok {
                self.fail(&c, "Invalid binary args or full ingress queue");
            }
        } else {
            state.pending = Some(pending);
        }
    }
}
fn error(status: u16) -> Response<HttpBody> {
    Response::builder()
        .status(status)
        .body(engineioxide::ResponseBody::empty_response())
        .unwrap()
}
fn query_sid(req: &Request<HttpIncoming>) -> Result<Option<&str>, ()> {
    let mut sid = None;
    for entry in req.uri().query().unwrap_or("").split('&') {
        let (key, value) = entry.split_once('=').unwrap_or((entry, ""));
        if key == "sid" {
            if sid.is_some() || value.parse::<engineioxide_core::Sid>().is_err() {
                return Err(());
            }
            sid = Some(value);
        }
    }
    Ok(sid)
}
fn origin(config: &Config, req: &Request<HttpIncoming>) -> Result<Option<String>, ()> {
    let Some(v) = req.headers().get(http::header::ORIGIN) else {
        return Ok(None);
    };
    let v = v.to_str().map_err(|_| ())?;
    if v.len() > 2048 {
        return Err(());
    }
    if config.origins.iter().any(|o| o == "*" || o == v) {
        Ok(Some(v.into()))
    } else {
        Err(())
    }
}
pub async fn bind(address: SocketAddr, config: Config) -> io::Result<BoundTransport> {
    if config
        .health_response
        .as_ref()
        .is_some_and(|b| b.len() > 4096)
        || config.max_connections == 0
        || config.max_connections > 65536
        || config.max_tcp_connections == 0
        || config.max_sessions_per_tcp == 0
        || config.max_requests_per_session == 0
        || config.ingress_records == 0
        || config.output_records == 0
        || (!config.allow_polling && !config.allow_websocket)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid transport limits",
        ));
    }
    let channel = config
        .global_ingress_records
        .checked_add(
            config
                .max_connections
                .checked_mul(3)
                .ok_or_else(|| io::Error::other("Capacity overflow"))?,
        )
        .ok_or_else(|| io::Error::other("Capacity overflow"))?;
    let (incoming, rx) = mpsc::channel(channel);
    let shared = Arc::new(Shared {
        next: AtomicU64::new(1),
        all: Mutex::new(HashMap::new()),
        retiring: Mutex::new(HashMap::new()),
        sids: Mutex::new(HashMap::new()),
        incoming,
        session_budget: Budget::new(config.max_connections, usize::MAX),
        tcp_budget: Budget::new(config.max_tcp_connections, usize::MAX),
        ingress: Budget::new(config.global_ingress_records, config.global_ingress_bytes),
        output: Budget::new(config.global_output_records, config.global_output_bytes),
        shutdown: CancellationToken::new(),
        config: config.clone(),
    });
    let mut engine = EngineIoConfig::default();
    engine.req_path = "/socket.io".into();
    engine.max_buffer_size = config.output_records + 4;
    engine.max_payload = 100000;
    engine.ws_max_message_size = codec::MAX_BINARY.max(codec::MAX_JSON) + 16;
    engine.ws_max_frame_size = engine.ws_max_message_size;
    engine.ping_interval = config.ping_interval;
    engine.ping_timeout = config.ping_timeout;
    engine.upgrade_timeout = config.authorization_timeout;
    engine.transports = if config.allow_polling {
        TransportType::Polling as u8
    } else {
        0
    } | if config.allow_websocket {
        TransportType::Websocket as u8
    } else {
        0
    };
    let service = EngineIoService::with_config(Arc::new(Handler(shared.clone())), engine);
    let listener = TcpListener::bind(address).await?;
    let address = listener.local_addr()?;
    let running = shared.clone();
    let task = tokio::spawn(async move {
        let mut tasks = tokio::task::JoinSet::new();
        loop {
            tokio::select! {biased;
             _=running.shutdown.cancelled()=>break,
             Some(_)=tasks.join_next()=>{},
             accepted=listener.accept()=>{
              let Ok((stream,peer))=accepted else{break};
              let Some(tcp_lease)=running.tcp_budget.try_acquire(1,0) else{drop(stream);continue};
              let tcp=Arc::new(TcpState{cancel:CancellationToken::new(),done:AtomicBool::new(false),changed:Notify::new(),sessions:Budget::new(config.max_sessions_per_tcp,usize::MAX),bound:Mutex::new(None)});
              let tcp_done=tcp.clone();let context=running.clone();let engine=service.clone();
              tasks.spawn(async move{
               let _done=TcpDone(tcp_done.clone());
               let close=tcp.cancel.clone();let shutdown=context.shutdown.clone();
               let svc=service_fn(move|mut req:Request<HttpIncoming>|{
                let engine=engine.clone();let context=context.clone();let tcp=tcp.clone();
                async move{
                 if req.uri().path()=="/health"&&req.method()==http::Method::GET{
                  return Ok::<_,Infallible>(match &context.config.health_response{Some(body)=>Response::builder().status(200).header(http::header::CONTENT_TYPE,"application/json").header(http::header::CACHE_CONTROL,"no-store").body(engineioxide::ResponseBody::custom_response(http_body_util::Full::new(body.clone()))).unwrap(),None=>error(404)});
                 }
                 if req.uri().path()!="/socket.io/"&&req.uri().path()!="/socket.io"{return Ok::<_,Infallible>(error(404))}
                 if req.headers().len()>64||req.headers().iter().map(|(n,v)|n.as_str().len()+v.as_bytes().len()).sum::<usize>()>16384{return Ok(error(431))}
                 let Ok(origin)=origin(&context.config,&req) else{return Ok(error(403))};
                 let sid=match query_sid(&req){Ok(sid)=>sid.map(str::to_owned),Err(())=>return Ok(error(400))};
                 let reservation=if let Some(sid)=sid {
                  let c=context.sids.lock().unwrap().get(&sid).and_then(Weak::upgrade);
                  if let Some(c)=c{if !c.live.load(Ordering::Acquire)||!context.attach_tcp(&c,&tcp){return Ok(error(400))}}
                  None
                 }else if req.method()==http::Method::GET{
                  let Some(leases)=Leases::acquire(&tcp.sessions,&context.session_budget,1,0) else{return Ok(error(503))};Some(Arc::new(leases))
                 }else{None};
                 req.extensions_mut().insert(RequestContext{peer,origin:origin.clone(),tcp,reservation});
                 let mut response=if req.method()==http::Method::OPTIONS{error(204)}else{engine.call(req).await?};
                 if let Some(origin)=origin{
                  if let Ok(value)=origin.parse(){response.headers_mut().insert(http::header::ACCESS_CONTROL_ALLOW_ORIGIN,value);}
                  response.headers_mut().insert(http::header::VARY,http::HeaderValue::from_static("Origin"));
                  response.headers_mut().insert(http::header::ACCESS_CONTROL_ALLOW_METHODS,http::HeaderValue::from_static("GET,POST,OPTIONS"));
                  response.headers_mut().insert(http::header::ACCESS_CONTROL_ALLOW_HEADERS,http::HeaderValue::from_static("Content-Type"));
                 }
                 Ok(response)
                }
               });
               let mut builder=hyper::server::conn::http1::Builder::new();builder.max_headers(64).max_buf_size(32768).timer(TokioTimer::new()).header_read_timeout(config.header_timeout);
               let connection=builder.serve_connection(TokioIo::new(stream),svc).with_upgrades();
               tokio::select!{biased;_=close.cancelled()=>{},_=shutdown.cancelled()=>{},_=connection=>{}}
               tcp_done.end();drop(tcp_lease);
              });
             }
            }
        }
        // Close all TCP tasks independently of their blocked writers.
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
    });
    Ok(BoundTransport {
        address,
        handle: TransportHandle { shared },
        incoming: rx,
        task: Some(task),
    })
}

#[cfg(test)]
mod ordering_tests {
    use super::*;
    #[test]
    fn prepared_authorization_after_abort_cannot_follow_closed() {
        let (tx, mut rx) = mpsc::channel(16);
        let config = Config::default();
        let shared = Arc::new(Shared {
            config,
            next: AtomicU64::new(2),
            all: Mutex::new(HashMap::new()),
            retiring: Mutex::new(HashMap::new()),
            sids: Mutex::new(HashMap::new()),
            incoming: tx,
            session_budget: Budget::new(1, 1),
            tcp_budget: Budget::new(1, 1),
            ingress: Budget::new(16, 4096),
            output: Budget::new(16, 4096),
            shutdown: CancellationToken::new(),
        });
        let c = Arc::new(Connection {
            id: 1,
            socket: Weak::new(),
            live: AtomicBool::new(true),
            retired: AtomicBool::new(false),
            changed: Notify::new(),
            state: Mutex::new(State {
                phase: 2,
                sequence: 0,
                pending: None,
            }),
            tcp: Mutex::new(vec![]),
            reservation: Mutex::new(None),
            ingress: Budget::new(16, 4096),
            output: Budget::new(16, 4096),
            encoded: Budget::new(16, 4096),
            cancel: CancellationToken::new(),
        });
        shared.all.lock().unwrap().insert(1, c.clone());
        let prepared = Arc::new(std::sync::Barrier::new(2));
        let resume = Arc::new(std::sync::Barrier::new(2));
        let join = {
            let shared = shared.clone();
            let c = c.clone();
            let prepared = prepared.clone();
            let resume = resume.clone();
            std::thread::spawn(move || {
                let lease = Leases::acquire(&c.ingress, &shared.ingress, 1, 128).unwrap();
                let (reply, _rx) = oneshot::channel();
                let kind = IncomingKind::Authorize {
                    auth: serde_json::Value::Null,
                    request: RequestMeta {
                        peer: "127.0.0.1:1".parse().unwrap(),
                        origin: None,
                    },
                    reply,
                };
                prepared.wait();
                resume.wait();
                shared.enqueue_authorize(&c, kind, lease)
            })
        };
        prepared.wait();
        shared.abort(&c, "Owner aborted before authorization publication".into());
        resume.wait();
        assert!(!join.join().unwrap());
        assert!(matches!(
            rx.try_recv().unwrap().kind,
            IncomingKind::Closed { .. }
        ));
        assert!(rx.try_recv().is_err());
        assert_eq!(shared.ingress.used(), Usage::default());
    }
}
