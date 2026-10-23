//! One physically bound IPv4 UDP Host listener with explicit source-IP policy.
//! Peer tokens are issued only for real received packets, never from a dummy send.
use crate::{
    NativeError,
    budget::{Budget, Permit},
};
use bytes::Bytes;
use std::{
    collections::HashMap,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    net::UdpSocket,
    sync::{mpsc, oneshot, watch},
    time::{Instant, MissedTickBehavior, timeout, timeout_at},
};

const MAX_DATAGRAM: usize = 65507;
static NEXT_EPOCH: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
pub struct ListenerConfig {
    pub bind: SocketAddrV4,
    pub advertised_ip: Ipv4Addr,
    pub allowed_hosts: Vec<Ipv4Addr>,
    pub max_peers: usize,
    pub idle_timeout: Duration,
    pub startup_timeout: Duration,
    pub send_timeout: Duration,
    pub tx_records: usize,
    pub tx_bytes: usize,
    pub rx_records: usize,
    pub rx_bytes: usize,
}
impl Default for ListenerConfig {
    fn default() -> Self {
        Self {
            bind: SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0),
            advertised_ip: Ipv4Addr::LOCALHOST,
            allowed_hosts: vec![Ipv4Addr::LOCALHOST],
            max_peers: 64,
            idle_timeout: Duration::from_secs(60),
            startup_timeout: Duration::from_secs(5),
            send_timeout: Duration::from_secs(5),
            tx_records: 64,
            tx_bytes: 1048576,
            rx_records: 64,
            rx_bytes: 1048576,
        }
    }
}
fn unicast(ip: Ipv4Addr) -> bool {
    !ip.is_unspecified() && !ip.is_multicast() && !ip.is_broadcast()
}
impl ListenerConfig {
    fn validate(&self) -> Result<(), NativeError> {
        if !unicast(self.advertised_ip)
            || (!self.bind.ip().is_unspecified() && !unicast(*self.bind.ip()))
            || self.allowed_hosts.is_empty()
            || self.allowed_hosts.len() > 32
            || self.allowed_hosts.iter().any(|ip| !unicast(*ip))
            || self
                .allowed_hosts
                .iter()
                .enumerate()
                .any(|(i, ip)| self.allowed_hosts[..i].contains(ip))
            || !(1..=128).contains(&self.max_peers)
            || !(Duration::from_millis(1)..=Duration::from_secs(3600)).contains(&self.idle_timeout)
            || !(Duration::from_millis(1)..=Duration::from_secs(120))
                .contains(&self.startup_timeout)
            || !(Duration::from_millis(1)..=Duration::from_secs(120)).contains(&self.send_timeout)
            || !(1..=65536).contains(&self.tx_records)
            || !(1..=65536).contains(&self.rx_records)
            || !(1..=67108864).contains(&self.tx_bytes)
            || !(1..=67108864).contains(&self.rx_bytes)
        {
            return Err(NativeError::new(
                10022,
                "invalid native UDP listener configuration",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ListenerReady {
    pub bound: SocketAddrV4,
    pub advertised: SocketAddrV4,
}
/// An epoch/id/endpoint triple is scoped to this exact physical listener lifetime.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ListenerPeer {
    pub id: u64,
    pub epoch: u64,
    pub endpoint: SocketAddrV4,
}
#[derive(Clone, Debug, Default)]
pub struct ListenerStatus {
    pub ready: Option<ListenerReady>,
    pub closed: bool,
    pub error: Option<NativeError>,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ListenerLosses {
    pub rx_packets: u64,
    pub rx_bytes: u64,
    pub unauthorized_packets: u64,
    pub peer_limit_packets: u64,
    pub expired_peers: u64,
    /// An unconnected OS receive error is not attributed to any tuple.
    pub unattributed_errors: u64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct ListenerUsage {
    pub records: usize,
    pub bytes: usize,
    pub peak_records: usize,
    pub peak_bytes: usize,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct ListenerMetrics {
    pub tx: ListenerUsage,
    pub rx: ListenerUsage,
    pub peers: usize,
}
pub struct ListenerDatagram {
    pub peer: ListenerPeer,
    pub bytes: Bytes,
    // Kept through actual consumer ownership; closed does not pretend that a
    // consumer's already-delivered memory has disappeared.
    _credit: Permit,
}
pub struct ListenerEvents {
    pub datagrams: mpsc::Receiver<ListenerDatagram>,
    pub status: watch::Receiver<ListenerStatus>,
    pub losses: watch::Receiver<ListenerLosses>,
}
pub struct ListenerTicket(oneshot::Receiver<Result<(), NativeError>>);
impl ListenerTicket {
    pub async fn completion(self) -> Result<(), NativeError> {
        self.0
            .await
            .unwrap_or_else(|_| Err(NativeError::new(995, "native UDP listener write discarded")))
    }
}
struct PeerState {
    token: ListenerPeer,
    seen: Instant,
}
struct State {
    admitting: bool,
    ready: Option<ListenerReady>,
    next_peer: u64,
    peers: HashMap<SocketAddrV4, PeerState>,
}
struct Shared {
    epoch: u64,
    config: ListenerConfig,
    state: Mutex<State>,
    tx_budget: Arc<Budget>,
    rx_budget: Arc<Budget>,
}
impl Shared {
    fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.admitting = false;
        self.tx_budget.close();
        self.rx_budget.close();
    }
    fn live_peer(&self, peer: ListenerPeer, now: Instant) -> bool {
        let state = self.state.lock().unwrap();
        state.admitting
            && peer.epoch == self.epoch
            && state.peers.get(&peer.endpoint).is_some_and(|p| {
                p.token == peer && now.duration_since(p.seen) < self.config.idle_timeout
            })
    }
}
struct Write {
    peer: ListenerPeer,
    bytes: Bytes,
    deadline: Instant,
    done: oneshot::Sender<Result<(), NativeError>>,
    _credit: Permit,
}
struct Control {
    shared: Arc<Shared>,
    writes: mpsc::Sender<Write>,
    stop: watch::Sender<bool>,
    status: watch::Receiver<ListenerStatus>,
}
impl Drop for Control {
    fn drop(&mut self) {
        self.shared.close();
        let _ = self.stop.send(true);
    }
}
/// Clones share one socket. Dropping the last handle requests physical retirement.
#[derive(Clone)]
pub struct NativeUdpListener {
    inner: Arc<Control>,
}
impl NativeUdpListener {
    pub fn start(config: ListenerConfig) -> Result<(Self, ListenerEvents), NativeError> {
        config.validate()?;
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| NativeError::new(10050, "native UDP listener needs an async runtime"))?;
        let epoch = NEXT_EPOCH
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .map_err(|_| NativeError::new(10055, "native UDP listener epochs exhausted"))?;
        let (writes, receiver) = mpsc::channel(config.tx_records);
        let (datagrams, datagram_receiver) = mpsc::channel(config.rx_records);
        let (status, status_receiver) = watch::channel(ListenerStatus::default());
        let (losses, loss_receiver) = watch::channel(ListenerLosses::default());
        let (stop, stopping) = watch::channel(false);
        let shared = Arc::new(Shared {
            epoch,
            tx_budget: Budget::new(config.tx_records, config.tx_bytes),
            rx_budget: Budget::new(config.rx_records, config.rx_bytes),
            state: Mutex::new(State {
                admitting: true,
                ready: None,
                next_peer: 1,
                peers: HashMap::new(),
            }),
            config,
        });
        // Construct ownership before spawn: even a never-polled future must
        // close admission and publish retirement when its runtime is destroyed.
        let driver = Driver {
            shared: shared.clone(),
            writes: receiver,
            socket: None,
            status: status.clone(),
            armed: true,
        };
        runtime.spawn(run(driver, datagrams, status, losses, stopping));
        let listener = Self {
            inner: Arc::new(Control {
                shared,
                writes,
                stop,
                status: status_receiver.clone(),
            }),
        };
        Ok((
            listener,
            ListenerEvents {
                datagrams: datagram_receiver,
                status: status_receiver,
                losses: loss_receiver,
            },
        ))
    }
    pub async fn when_ready(&self) -> Result<ListenerReady, NativeError> {
        let mut status = self.inner.status.clone();
        loop {
            let current = status.borrow_and_update().clone();
            if current.closed {
                return Err(current.error.unwrap_or_else(|| {
                    NativeError::new(995, "native UDP listener closed before readiness")
                }));
            }
            if let Some(ready) = current.ready {
                // The terminal watch acknowledges physical retirement later;
                // abort fences a READY continuation immediately under this lock.
                let state = self.inner.shared.state.lock().unwrap();
                if !state.admitting {
                    return Err(NativeError::new(
                        995,
                        "native UDP listener readiness cancelled",
                    ));
                }
                return Ok(ready);
            }
            status
                .changed()
                .await
                .map_err(|_| NativeError::new(10050, "native UDP listener driver stopped"))?;
        }
    }
    /// Read-only lookup of a real received tuple; it never admits or refreshes a peer.
    pub fn peer_for_endpoint(&self, endpoint: SocketAddrV4) -> Option<ListenerPeer> {
        let shared = &self.inner.shared;
        let state = shared.state.lock().unwrap();
        if !state.admitting || state.ready.is_none() {
            return None;
        }
        let peer = state.peers.get(&endpoint)?;
        (peer.token.epoch == shared.epoch
            && Instant::now().duration_since(peer.seen) < shared.config.idle_timeout)
            .then_some(peer.token)
    }
    pub fn try_send(
        &self,
        peer: ListenerPeer,
        bytes: &[u8],
    ) -> Result<ListenerTicket, NativeError> {
        if bytes.len() > MAX_DATAGRAM {
            return Err(NativeError::new(
                10040,
                "native UDP listener datagram too large",
            ));
        }
        let shared = &self.inner.shared;
        let mut state = shared.state.lock().unwrap();
        if !state.admitting {
            return Err(NativeError::new(10058, "native UDP listener is closing"));
        }
        if state.ready.is_none() {
            return Err(NativeError::new(10035, "native UDP listener is not ready"));
        }
        let now = Instant::now();
        let Some(known) = state.peers.get_mut(&peer.endpoint) else {
            return Err(NativeError::new(
                10013,
                "native UDP listener tuple was not received",
            ));
        };
        if peer.epoch != shared.epoch
            || known.token != peer
            || now.duration_since(known.seen) >= shared.config.idle_timeout
        {
            return Err(NativeError::new(10057, "native UDP listener peer expired"));
        }
        let credit = shared.tx_budget.reserve(bytes.len())?;
        let (done, completion) = oneshot::channel();
        let write = Write {
            peer,
            bytes: Bytes::copy_from_slice(bytes),
            deadline: now + shared.config.send_timeout,
            done,
            _credit: credit,
        };
        self.inner
            .writes
            .try_send(write)
            .map_err(|_| NativeError::new(10055, "native UDP listener TX queue exhausted"))?;
        known.seen = now;
        Ok(ListenerTicket(completion))
    }
    pub fn abort(&self) {
        self.inner.shared.close();
        let _ = self.inner.stop.send(true);
    }
    pub async fn close(&self) -> Result<(), NativeError> {
        self.abort();
        self.wait_closed().await
    }
    pub async fn wait_closed(&self) -> Result<(), NativeError> {
        let mut status = self.inner.status.clone();
        loop {
            let current = status.borrow_and_update().clone();
            if current.closed {
                return current.error.map_or(Ok(()), Err);
            }
            status
                .changed()
                .await
                .map_err(|_| NativeError::new(10050, "native UDP listener driver stopped"))?;
        }
    }
    pub fn metrics(&self) -> ListenerMetrics {
        let usage = |budget: &Arc<Budget>| {
            let u = budget.usage();
            ListenerUsage {
                records: u.records,
                bytes: u.bytes,
                peak_records: u.peak_records,
                peak_bytes: u.peak_bytes,
            }
        };
        ListenerMetrics {
            tx: usage(&self.inner.shared.tx_budget),
            rx: usage(&self.inner.shared.rx_budget),
            peers: self.inner.shared.state.lock().unwrap().peers.len(),
        }
    }
}
fn expire(shared: &Shared, losses: &watch::Sender<ListenerLosses>, now: Instant) {
    let count = {
        let mut state = shared.state.lock().unwrap();
        let before = state.peers.len();
        state
            .peers
            .retain(|_, p| now.duration_since(p.seen) < shared.config.idle_timeout);
        before - state.peers.len()
    };
    if count != 0 {
        losses.send_modify(|l| l.expired_peers = l.expired_peers.saturating_add(count as u64));
    }
}
fn receive(
    shared: &Shared,
    output: &mpsc::Sender<ListenerDatagram>,
    losses: &watch::Sender<ListenerLosses>,
    data: &[u8],
    endpoint: SocketAddrV4,
) {
    if endpoint.port() == 0 || !shared.config.allowed_hosts.contains(endpoint.ip()) {
        losses.send_modify(|l| l.unauthorized_packets = l.unauthorized_packets.saturating_add(1));
        return;
    }
    let dropped = || {
        losses.send_modify(|l| {
            l.rx_packets = l.rx_packets.saturating_add(1);
            l.rx_bytes = l.rx_bytes.saturating_add(data.len() as u64);
        })
    };
    let Ok(credit) = shared.rx_budget.reserve(data.len()) else {
        dropped();
        return;
    };
    let now = Instant::now();
    expire(shared, losses, now);
    let token = {
        let mut state = shared.state.lock().unwrap();
        if !state.admitting {
            return;
        }
        if let Some(peer) = state.peers.get_mut(&endpoint) {
            peer.seen = now;
            peer.token
        } else {
            if state.peers.len() >= shared.config.max_peers {
                losses
                    .send_modify(|l| l.peer_limit_packets = l.peer_limit_packets.saturating_add(1));
                dropped();
                return;
            }
            let id = state.next_peer;
            let Some(next) = id.checked_add(1) else {
                dropped();
                return;
            };
            state.next_peer = next;
            let token = ListenerPeer {
                id,
                epoch: shared.epoch,
                endpoint,
            };
            state.peers.insert(endpoint, PeerState { token, seen: now });
            token
        }
    };
    if output
        .try_send(ListenerDatagram {
            peer: token,
            bytes: Bytes::copy_from_slice(data),
            _credit: credit,
        })
        .is_err()
    {
        dropped();
    }
}
fn cancel_write(write: Write) {
    let Write {
        done,
        bytes,
        _credit,
        ..
    } = write;
    drop(bytes);
    drop(_credit);
    let _ = done.send(Err(NativeError::new(
        995,
        "native UDP listener write cancelled",
    )));
}
struct Driver {
    shared: Arc<Shared>,
    writes: mpsc::Receiver<Write>,
    socket: Option<UdpSocket>,
    status: watch::Sender<ListenerStatus>,
    armed: bool,
}
impl Driver {
    fn retire(&mut self) {
        self.shared.close();
        self.writes.close();
        while let Ok(write) = self.writes.try_recv() {
            cancel_write(write);
        }
        drop(self.socket.take());
        self.shared.state.lock().unwrap().peers.clear();
    }
}
impl Drop for Driver {
    fn drop(&mut self) {
        if self.armed {
            self.retire();
            self.status.send_modify(|s| {
                s.closed = true;
                s.error = Some(NativeError::new(
                    10050,
                    "native UDP listener driver stopped",
                ));
            });
        }
    }
}
enum Selected {
    Write(Option<Write>),
    Received(std::io::Result<(usize, SocketAddr)>),
    Sweep,
    ReceiverClosed,
}
async fn drive(
    shared: &Arc<Shared>,
    writes: &mut mpsc::Receiver<Write>,
    datagrams: &mpsc::Sender<ListenerDatagram>,
    losses: &watch::Sender<ListenerLosses>,
    stop: &mut watch::Receiver<bool>,
    socket: &UdpSocket,
) -> Result<(), NativeError> {
    let mut buffer = vec![0u8; 65536];
    let mut sweep = tokio::time::interval(shared.config.idle_timeout.min(Duration::from_secs(1)));
    sweep.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        if *stop.borrow() {
            return Ok(());
        }
        let selected = tokio::select! {
            biased;
            _ = stop.changed() => return Ok(()),
            selected = async { tokio::select! {
                write = writes.recv() => Selected::Write(write),
                packet = socket.recv_from(&mut buffer) => Selected::Received(packet),
                _ = sweep.tick() => Selected::Sweep,
                _ = datagrams.closed() => Selected::ReceiverClosed,
            }} => selected,
        };
        match selected {
            Selected::Write(None) | Selected::ReceiverClosed => return Ok(()),
            Selected::Sweep => expire(shared, losses, Instant::now()),
            Selected::Received(Ok((size, SocketAddr::V4(endpoint)))) if size <= MAX_DATAGRAM => {
                receive(shared, datagrams, losses, &buffer[..size], endpoint)
            }
            Selected::Received(Ok(_)) => {}
            Selected::Received(Err(error)) => {
                let error = NativeError::io(error, "native UDP listener receive failed");
                if matches!(error.code, 10054 | 10061) {
                    losses.send_modify(|l| {
                        l.unattributed_errors = l.unattributed_errors.saturating_add(1)
                    });
                } else {
                    return Err(error);
                }
            }
            Selected::Write(Some(write)) => {
                let result = if !shared.live_peer(write.peer, Instant::now()) {
                    Err(NativeError::new(
                        10057,
                        "native UDP listener peer expired before send",
                    ))
                } else {
                    tokio::select! {
                        biased;
                        _ = stop.changed() => Err(NativeError::new(995, "native UDP listener write cancelled")),
                        result = timeout_at(write.deadline, socket.send_to(&write.bytes, write.peer.endpoint)) => match result {
                            Ok(Ok(size)) if size == write.bytes.len() => Ok(()),
                            Ok(Ok(_)) => Err(NativeError::new(10040, "native UDP listener partial datagram")),
                            Ok(Err(error)) => Err(NativeError::io(error, "native UDP listener send failed")),
                            Err(_) => Err(NativeError::new(10060, "native UDP listener write timed out")),
                        }
                    }
                };
                let Write {
                    done,
                    bytes,
                    _credit,
                    ..
                } = write;
                drop(bytes);
                drop(_credit);
                let _ = done.send(result);
            }
        }
    }
}
async fn run(
    mut driver: Driver,
    datagrams: mpsc::Sender<ListenerDatagram>,
    status: watch::Sender<ListenerStatus>,
    losses: watch::Sender<ListenerLosses>,
    mut stop: watch::Receiver<bool>,
) {
    let shared = driver.shared.clone();
    let result = async {
        if *stop.borrow() { return Ok(()); }
        let bound = tokio::select! {
            biased;
            _ = stop.changed() => return Ok(()),
            result = timeout(shared.config.startup_timeout, UdpSocket::bind(shared.config.bind)) => match result {
                Ok(Ok(socket)) => socket,
                Ok(Err(error)) => return Err(NativeError::io(error, "native UDP listener bind failed")),
                Err(_) => return Err(NativeError::new(10060, "native UDP listener bind timed out")),
            }
        };
        let bound_address = match bound.local_addr().map_err(|e| NativeError::io(e, "native UDP listener local address failed"))? {
            SocketAddr::V4(address) => address,
            _ => return Err(NativeError::new(10049, "native UDP listener family mismatch")),
        };
        let ready = ListenerReady { bound: bound_address, advertised: SocketAddrV4::new(shared.config.advertised_ip, bound_address.port()) };
        driver.socket = Some(bound);
        {
            let mut state = shared.state.lock().unwrap();
            if !state.admitting { return Ok(()); }
            state.ready = Some(ready);
        }
        status.send_modify(|s| s.ready = Some(ready));
        drive(&shared, &mut driver.writes, &datagrams, &losses, &mut stop, driver.socket.as_ref().unwrap()).await
    }.await;
    driver.retire(); // Actual kernel socket and queued TX retire before acknowledgement.
    status.send_modify(|s| {
        s.closed = true;
        s.error = result.err();
    });
    driver.armed = false;
}
