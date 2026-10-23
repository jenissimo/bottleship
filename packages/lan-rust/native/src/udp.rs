//! Bounded ordinary UDP helper adapter. One helper owns one physical socket.
//! Empty datagrams cost a record. Admission permits survive SEND_RESULT until
//! the caller consumes/drops its completion; an accepted send is never replayed.
use crate::{
    NativeError,
    budget::{Budget, Permit},
};
use bytes::Bytes;
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::Path,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command as Process,
    sync::{Notify, mpsc, oneshot, watch},
    time::{Instant, timeout},
};

const HEADER: usize = 16;
const ADDRESS: usize = 24;
const MAX_PAYLOAD: usize = 65527;
const MAX_FRAME: usize = HEADER + 32 + MAX_PAYLOAD;
const BYTE_WINDOW: usize = 262144;
const RECORD_WINDOW: usize = 256;
const CONTROLS: usize = 64;
const PEERS: usize = 128;
const BIND: u8 = 1;
const PEER: u8 = 2;
const SEND: u8 = 3;
const CREDIT: u8 = 4;
const RETIRE: u8 = 5;
const CLOSE: u8 = 6;
const READY: u8 = 101;
const PEER_READY: u8 = 102;
const SEND_RESULT: u8 = 103;
const CREDIT_APPLIED: u8 = 104;
const RETIRED: u8 = 105;
const CLOSED: u8 = 106;
const RECEIVE: u8 = 107;
const PEER_ERROR: u8 = 108;
const LOSSES: u8 = 109;
const FAILURE: u8 = 110;
const CONTROL_CANCELLED: u8 = 114;
static GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
pub struct UdpOptions {
    pub operation_timeout: Duration,
    pub close_timeout: Duration,
}
impl Default for UdpOptions {
    fn default() -> Self {
        Self {
            operation_timeout: Duration::from_secs(5),
            close_timeout: Duration::from_secs(5),
        }
    }
}
#[derive(Clone, Debug, Default)]
pub struct UdpStatus {
    pub pid: u32,
    pub bound: Option<SocketAddr>,
    pub closing: bool,
    pub closed: bool,
    pub error: Option<NativeError>,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UdpLosses {
    pub rx_packets: u64,
    pub rx_bytes: u64,
    pub error_records: u64,
    pub unattributed_errors: u64,
}
#[derive(Clone, Debug)]
pub struct UdpPeerError {
    pub peer_id: u32,
    pub epoch: u32,
    pub endpoint: SocketAddr,
    pub code: u32,
    pub native_code: u32,
    pub origin: u32,
    pub kind: u32,
    pub icmp_code: u32,
    pub occurrences: u32,
}
#[derive(Clone, Copy, Debug)]
pub struct UdpSnapshot {
    pub pending_tx_records: usize,
    pub pending_tx_bytes: usize,
    pub peak_tx_records: usize,
    pub peak_tx_bytes: usize,
    pub pending_controls: usize,
    pub dropped_error_events: u64,
}
struct CreditReturns {
    bytes: AtomicUsize,
    packets: AtomicUsize,
    wake: Notify,
}
struct ReceiveCredit {
    shared: Arc<CreditReturns>,
    bytes: usize,
}
impl Drop for ReceiveCredit {
    fn drop(&mut self) {
        self.shared.bytes.fetch_add(self.bytes, Ordering::AcqRel);
        self.shared.packets.fetch_add(1, Ordering::AcqRel);
        self.shared.wake.notify_one();
    }
}
pub struct UdpDatagram {
    pub peer_id: u32,
    pub epoch: u32,
    pub endpoint: SocketAddr,
    pub bytes: Bytes,
    _credit: ReceiveCredit,
}
/// Drop each datagram after consumption to return one packet and its byte credit.
pub struct UdpEvents {
    pub datagrams: mpsc::Receiver<UdpDatagram>,
    pub errors: mpsc::Receiver<UdpPeerError>,
    pub losses: watch::Receiver<UdpLosses>,
}
struct Completion {
    outcome: Result<(), NativeError>,
    _permit: Permit,
}
pub struct SendTicket {
    receiver: oneshot::Receiver<Completion>,
}
impl SendTicket {
    pub async fn completion(self) -> Result<(), NativeError> {
        self.receiver
            .await
            .map_err(|_| NativeError::new(10050, "native completion channel closed"))?
            .outcome
    }
}
struct Inner {
    commands: mpsc::Sender<Command>,
    close: watch::Sender<u8>,
    status: watch::Receiver<UdpStatus>,
    tx: Arc<Budget>,
    controls: Arc<Budget>,
    dropped_errors: Arc<AtomicU64>,
    startup_timeout: Duration,
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.close.send_modify(|mode| *mode = 2);
    }
}
#[derive(Clone)]
pub struct BoundUdp {
    inner: Arc<Inner>,
}
impl BoundUdp {
    pub fn start(
        executable: impl AsRef<Path>,
        family: u8,
        options: UdpOptions,
    ) -> Result<(Self, UdpEvents), NativeError> {
        if !matches!(family, 4 | 6)
            || options.operation_timeout.is_zero()
            || options.close_timeout.is_zero()
        {
            return Err(NativeError::new(10022, "invalid bound UDP configuration"));
        }
        let generation = GENERATION.fetch_add(1, Ordering::Relaxed);
        if generation == 0 || generation > u32::MAX as u64 {
            return Err(NativeError::new(10055, "native binding identity exhausted"));
        }
        let mut child = Process::new(executable.as_ref())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| NativeError::new(10045, "bound UDP helper unavailable"))?;
        let pid = child.id().unwrap_or(0);
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (commands, receiver) = mpsc::channel(RECORD_WINDOW + CONTROLS);
        let (close, closing) = watch::channel(0);
        let (status_tx, status) = watch::channel(UdpStatus {
            pid,
            ..UdpStatus::default()
        });
        let (rx_tx, datagrams) = mpsc::channel(RECORD_WINDOW);
        let (err_tx, errors) = mpsc::channel(32);
        let (loss_tx, losses) = watch::channel(UdpLosses::default());
        let tx = Budget::new(RECORD_WINDOW, BYTE_WINDOW);
        let controls = Budget::new(CONTROLS - 1, (CONTROLS - 1) * 64);
        let dropped_errors = Arc::new(AtomicU64::new(0));
        let credits = Arc::new(CreditReturns {
            bytes: AtomicUsize::new(0),
            packets: AtomicUsize::new(0),
            wake: Notify::new(),
        });
        let (writer_tx, mut writer_rx) = mpsc::channel::<Vec<u8>>(RECORD_WINDOW + CONTROLS + 1);
        let (io_tx, io_rx) = mpsc::channel(32);
        let write_events = io_tx.clone();
        let writer = tokio::spawn(async move {
            let mut input = input;
            while let Some(frame) = writer_rx.recv().await {
                if let Err(error) = input.write_all(&frame).await {
                    let _ = write_events
                        .send(IoEvent::Error(NativeError::io(
                            error,
                            "native command pipe failed",
                        )))
                        .await;
                    break;
                }
            }
        });
        let reader = tokio::spawn(async move {
            let mut output = output;
            loop {
                let mut header = [0u8; HEADER];
                if let Err(error) = output.read_exact(&mut header).await {
                    let _ = io_tx
                        .send(if error.kind() == std::io::ErrorKind::UnexpectedEof {
                            IoEvent::End
                        } else {
                            IoEvent::Error(NativeError::io(error, "native output pipe failed"))
                        })
                        .await;
                    break;
                }
                let size = word(&header, 0) as usize;
                if !(HEADER..=MAX_FRAME).contains(&size)
                    || header[4] != 1
                    || header[6] != 0
                    || header[7] != 0
                    || word(&header, 12) != generation as u32
                {
                    let _ = io_tx.send(IoEvent::Error(protocol_error())).await;
                    break;
                }
                let mut body = vec![0; size - HEADER];
                if let Err(error) = output.read_exact(&mut body).await {
                    let _ = io_tx
                        .send(IoEvent::Error(NativeError::io(
                            error,
                            "truncated native frame",
                        )))
                        .await;
                    break;
                }
                if io_tx
                    .send(IoEvent::Frame {
                        opcode: header[5],
                        id: word(&header, 8),
                        body,
                    })
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        let handle = Self {
            inner: Arc::new(Inner {
                commands,
                close,
                status,
                tx: tx.clone(),
                controls: controls.clone(),
                dropped_errors: dropped_errors.clone(),
                startup_timeout: options.operation_timeout,
            }),
        };
        let driver = Driver {
            family,
            generation: generation as u32,
            next: 1,
            ending: false,
            close_sent: None,
            closed_seen: false,
            bound: None,
            peers: HashMap::new(),
            pending: HashMap::new(),
            credit_in_flight: false,
            receive_bytes: 0,
            receive_packets: 0,
            credits,
            writer: writer_tx,
            commands: receiver,
            closing,
            io: io_rx,
            status: status_tx,
            rx: rx_tx,
            errors: err_tx,
            losses: loss_tx,
            last_losses: UdpLosses::default(),
            dropped_errors,
            tx,
            controls,
            options: options.clone(),
        };
        tokio::spawn(async move {
            let mut driver = driver;
            let result = driver.run().await;
            driver.tx.close();
            driver.controls.close();
            driver.commands.close();
            let failure = result
                .clone()
                .err()
                .unwrap_or_else(|| NativeError::new(10004, "native UDP binding closed"));
            driver.fail_pending(failure);
            drop(driver.writer);
            if !driver.closed_seen {
                let _ = child.start_kill();
            }
            let ended = timeout(options.close_timeout, child.wait()).await;
            let mut error = result.err();
            match ended {
                Ok(Ok(status)) if driver.closed_seen && !status.success() => {
                    error = Some(NativeError::new(10050, "native helper exited with failure"))
                }
                Ok(Ok(_)) => {}
                _ => {
                    let _ = child.start_kill();
                    let _ = timeout(options.close_timeout, child.wait()).await;
                    error = Some(NativeError::new(10060, "native helper exit timed out"));
                }
            }
            writer.abort();
            reader.abort();
            let _ = writer.await;
            let _ = reader.await;
            driver.status.send_modify(|status| {
                status.closing = true;
                status.closed = true;
                status.error = error;
            });
        });
        Ok((
            handle,
            UdpEvents {
                datagrams,
                errors,
                losses,
            },
        ))
    }
    pub async fn bind(
        executable: impl AsRef<Path>,
        family: u8,
        options: UdpOptions,
    ) -> Result<(Self, UdpEvents), NativeError> {
        let (handle, events) = Self::start(executable, family, options)?;
        match handle.when_ready().await {
            Ok(_) => Ok((handle, events)),
            Err(error) => {
                handle.abort();
                let _ = handle.wait_closed().await;
                Err(error)
            }
        }
    }
    /// The caller retains this handle while startup is pending. Cancellation of
    /// this wait does not release its physical binding or policy ownership.
    pub async fn when_ready(&self) -> Result<SocketAddr, NativeError> {
        let mut state = self.inner.status.clone();
        timeout(self.inner.startup_timeout, async {
            loop {
                let current = state.borrow().clone();
                if let Some(error) = current.error {
                    return Err(error);
                }
                if let Some(bound) = current.bound {
                    return Ok(bound);
                }
                if current.closed {
                    return Err(NativeError::new(
                        10050,
                        "native binding closed before ready",
                    ));
                }
                state
                    .changed()
                    .await
                    .map_err(|_| NativeError::new(10050, "native driver stopped"))?;
            }
        })
        .await
        .map_err(|_| NativeError::new(10060, "native bind timed out"))?
    }
    pub fn status(&self) -> UdpStatus {
        self.inner.status.borrow().clone()
    }
    pub fn subscribe(&self) -> watch::Receiver<UdpStatus> {
        self.inner.status.clone()
    }
    pub fn snapshot(&self) -> UdpSnapshot {
        let tx = self.inner.tx.usage();
        UdpSnapshot {
            pending_tx_records: tx.records,
            pending_tx_bytes: tx.bytes,
            peak_tx_records: tx.peak_records,
            peak_tx_bytes: tx.peak_bytes,
            pending_controls: self.inner.controls.usage().records,
            dropped_error_events: self.inner.dropped_errors.load(Ordering::Relaxed),
        }
    }
    pub async fn register_peer(
        &self,
        peer_id: u32,
        epoch: u32,
        endpoint: SocketAddr,
    ) -> Result<(), NativeError> {
        if peer_id == 0 || epoch == 0 {
            return Err(protocol_error());
        }
        let endpoint = normalize_endpoint(endpoint)?;
        let permit = self.inner.controls.reserve(32)?;
        let (reply, result) = oneshot::channel();
        self.inner
            .commands
            .try_send(Command::Peer {
                peer_id,
                epoch,
                endpoint,
                reply,
                permit,
            })
            .map_err(|_| NativeError::new(10055, "native command queue unavailable"))?;
        result
            .await
            .map_err(|_| NativeError::new(10050, "native control channel closed"))?
    }
    pub async fn retire_peer(&self, peer_id: u32, epoch: u32) -> Result<(), NativeError> {
        let permit = self.inner.controls.reserve(8)?;
        let (reply, result) = oneshot::channel();
        self.inner
            .commands
            .try_send(Command::Retire {
                peer_id,
                epoch,
                reply,
                permit,
            })
            .map_err(|_| NativeError::new(10055, "native command queue unavailable"))?;
        result
            .await
            .map_err(|_| NativeError::new(10050, "native control channel closed"))?
    }
    pub fn try_send(
        &self,
        peer_id: u32,
        epoch: u32,
        payload: &[u8],
    ) -> Result<SendTicket, NativeError> {
        if payload.len() > MAX_PAYLOAD {
            return Err(NativeError::new(10040, "native UDP payload too large"));
        }
        let permit = self.inner.tx.reserve(payload.len())?;
        let slot = self
            .inner
            .commands
            .try_reserve()
            .map_err(|_| NativeError::new(10055, "native command queue unavailable"))?;
        // Copy only after whole-packet admission. A zero-length slice must not
        // retain an arbitrarily large parent Bytes allocation.
        let bytes = Bytes::copy_from_slice(payload);
        let (reply, receiver) = oneshot::channel();
        slot.send(Command::Send {
            peer_id,
            epoch,
            bytes,
            reply,
            permit,
        });
        Ok(SendTicket { receiver })
    }
    pub fn abort(&self) {
        self.inner.tx.close();
        self.inner.controls.close();
        self.inner.close.send_modify(|mode| *mode = 2);
    }
    pub async fn close(&self) -> Result<(), NativeError> {
        self.inner.tx.close();
        self.inner.controls.close();
        self.inner.close.send_modify(|mode| *mode = (*mode).max(1));
        self.wait_closed().await
    }
    pub async fn wait_closed(&self) -> Result<(), NativeError> {
        let mut status = self.inner.status.clone();
        loop {
            let current = status.borrow().clone();
            if current.closed {
                return current.error.map_or(Ok(()), Err);
            }
            status
                .changed()
                .await
                .map_err(|_| NativeError::new(10050, "native retirement observer stopped"))?;
        }
    }
}
enum Command {
    Peer {
        peer_id: u32,
        epoch: u32,
        endpoint: SocketAddr,
        reply: oneshot::Sender<Result<(), NativeError>>,
        permit: Permit,
    },
    Retire {
        peer_id: u32,
        epoch: u32,
        reply: oneshot::Sender<Result<(), NativeError>>,
        permit: Permit,
    },
    Send {
        peer_id: u32,
        epoch: u32,
        bytes: Bytes,
        reply: oneshot::Sender<Completion>,
        permit: Permit,
    },
}
enum IoEvent {
    Frame { opcode: u8, id: u32, body: Vec<u8> },
    End,
    Error(NativeError),
}
enum Control {
    Bind,
    Peer(u32, u32),
    Retire(u32, u32),
    Credit,
}
enum Pending {
    Control {
        expected: u8,
        opcode: u8,
        control: Control,
        reply: Option<oneshot::Sender<Result<(), NativeError>>>,
        _permit: Option<Permit>,
        deadline: Instant,
    },
    Send {
        peer_id: u32,
        epoch: u32,
        reply: oneshot::Sender<Completion>,
        permit: Permit,
        deadline: Instant,
    },
}
impl Pending {
    fn deadline(&self) -> Instant {
        match self {
            Self::Control { deadline, .. } | Self::Send { deadline, .. } => *deadline,
        }
    }
}
struct Peer {
    epoch: u32,
    endpoint: SocketAddr,
    active: bool,
}
struct Driver {
    family: u8,
    generation: u32,
    next: u64,
    ending: bool,
    close_sent: Option<(u32, Instant)>,
    closed_seen: bool,
    bound: Option<SocketAddr>,
    peers: HashMap<u32, Peer>,
    pending: HashMap<u32, Pending>,
    credit_in_flight: bool,
    receive_bytes: usize,
    receive_packets: usize,
    credits: Arc<CreditReturns>,
    writer: mpsc::Sender<Vec<u8>>,
    commands: mpsc::Receiver<Command>,
    closing: watch::Receiver<u8>,
    io: mpsc::Receiver<IoEvent>,
    status: watch::Sender<UdpStatus>,
    rx: mpsc::Sender<UdpDatagram>,
    errors: mpsc::Sender<UdpPeerError>,
    losses: watch::Sender<UdpLosses>,
    last_losses: UdpLosses,
    dropped_errors: Arc<AtomicU64>,
    tx: Arc<Budget>,
    controls: Arc<Budget>,
    options: UdpOptions,
}
impl Driver {
    fn identity(&mut self) -> Result<u32, NativeError> {
        if self.next > u32::MAX as u64 {
            return Err(NativeError::new(10055, "native command identity exhausted"));
        }
        let id = self.next as u32;
        self.next += 1;
        Ok(id)
    }
    fn enqueue(&self, opcode: u8, id: u32, body: &[u8]) -> Result<(), NativeError> {
        let frame = encode_frame(opcode, id, self.generation, body)?;
        self.writer
            .try_send(frame)
            .map_err(|_| NativeError::new(10055, "native command writer exhausted"))
    }
    fn request(
        &mut self,
        opcode: u8,
        expected: u8,
        control: Control,
        body: &[u8],
        reply: Option<oneshot::Sender<Result<(), NativeError>>>,
        permit: Option<Permit>,
    ) -> Result<(), NativeError> {
        let id = self.identity()?;
        self.pending.insert(
            id,
            Pending::Control {
                expected,
                opcode,
                control,
                reply,
                _permit: permit,
                deadline: Instant::now() + self.options.operation_timeout,
            },
        );
        self.enqueue(opcode, id, body)
    }
    async fn run(&mut self) -> Result<(), NativeError> {
        let initial = SocketAddr::new(
            if self.family == 4 {
                IpAddr::V4(Ipv4Addr::UNSPECIFIED)
            } else {
                IpAddr::V6(Ipv6Addr::UNSPECIFIED)
            },
            0,
        );
        self.request(
            BIND,
            READY,
            Control::Bind,
            &encode_address(initial, true)?,
            None,
            None,
        )?;
        loop {
            let mut deadline = self.pending.values().map(Pending::deadline).min();
            if let Some((_, until)) = self.close_sent {
                deadline = Some(deadline.map_or(until, |value| value.min(until)));
            }
            tokio::select! {
                biased;
                changed = self.closing.changed() => {
                    if changed.is_err() || *self.closing.borrow_and_update() == 2 { return Ok(()); }
                    if !self.ending {
                        self.ending = true; self.commands.close();
                        self.status.send_modify(|status| status.closing = true);
                    }
                }
                _ = async { if let Some(until) = deadline { tokio::time::sleep_until(until).await; } else { std::future::pending::<()>().await; } } =>
                    return Err(NativeError::new(10060, "native UDP operation timed out")),
                event = self.io.recv() => match event {
                    Some(IoEvent::Frame{opcode,id,body}) => { if self.event(opcode,id,body)? { return Ok(()); } }
                    Some(IoEvent::Error(error)) => return Err(error),
                    Some(IoEvent::End) | None => return Err(NativeError::new(10050, "native helper exited before CLOSED")),
                },
                command = self.commands.recv(), if self.close_sent.is_none() => {
                    if let Some(command) = command { self.command(command)?; }
                    else {
                        self.ending = true;
                        let id = self.identity()?;
                        self.close_sent = Some((id, Instant::now() + self.options.close_timeout));
                        self.enqueue(CLOSE, id, &[])?;
                    }
                }
                _ = self.credits.wake.notified(), if !self.ending && !self.credit_in_flight => { self.flush_credit()?; }
            }
            if !self.ending && !self.credit_in_flight {
                self.flush_credit()?;
            }
        }
    }
    fn command(&mut self, command: Command) -> Result<(), NativeError> {
        match command {
            Command::Peer {
                peer_id,
                epoch,
                endpoint,
                reply,
                permit,
            } => {
                let previous = self.peers.get(&peer_id);
                let invalid = if endpoint.is_ipv4() != (self.family == 4) {
                    Some(10022)
                } else if previous.is_none() && self.peers.len() >= PEERS {
                    Some(10055)
                } else if previous
                    .is_some_and(|peer| epoch <= peer.epoch || endpoint != peer.endpoint)
                {
                    Some(10022)
                } else {
                    None
                };
                if let Some(code) = invalid {
                    let _ = reply.send(Err(NativeError::new(code, "native peer identity refused")));
                    return Ok(());
                }
                self.peers.insert(
                    peer_id,
                    Peer {
                        epoch,
                        endpoint,
                        active: false,
                    },
                );
                let mut body = Vec::with_capacity(32);
                body.extend_from_slice(&peer_id.to_le_bytes());
                body.extend_from_slice(&epoch.to_le_bytes());
                body.extend_from_slice(&encode_address(endpoint, false)?);
                self.request(
                    PEER,
                    PEER_READY,
                    Control::Peer(peer_id, epoch),
                    &body,
                    Some(reply),
                    Some(permit),
                )?;
            }
            Command::Retire {
                peer_id,
                epoch,
                reply,
                permit,
            } => {
                let Some(peer) = self.peers.get_mut(&peer_id) else {
                    let _ = reply.send(Ok(()));
                    return Ok(());
                };
                if peer.epoch != epoch {
                    let _ = reply.send(Ok(()));
                    return Ok(());
                }
                peer.active = false;
                let mut body = Vec::with_capacity(8);
                body.extend_from_slice(&peer_id.to_le_bytes());
                body.extend_from_slice(&epoch.to_le_bytes());
                self.request(
                    RETIRE,
                    RETIRED,
                    Control::Retire(peer_id, epoch),
                    &body,
                    Some(reply),
                    Some(permit),
                )?;
            }
            Command::Send {
                peer_id,
                epoch,
                bytes,
                reply,
                permit,
            } => {
                let code = if !self
                    .peers
                    .get(&peer_id)
                    .is_some_and(|peer| peer.active && peer.epoch == epoch)
                {
                    10013
                } else if self.family == 4 && bytes.len() > 65507 {
                    10040
                } else {
                    0
                };
                if code != 0 {
                    let _ = reply.send(Completion {
                        outcome: Err(NativeError::new(code, "native UDP send refused")),
                        _permit: permit,
                    });
                    return Ok(());
                }
                let id = self.identity()?;
                let mut body = Vec::with_capacity(8 + bytes.len());
                body.extend_from_slice(&peer_id.to_le_bytes());
                body.extend_from_slice(&epoch.to_le_bytes());
                body.extend_from_slice(&bytes);
                self.pending.insert(
                    id,
                    Pending::Send {
                        peer_id,
                        epoch,
                        reply,
                        permit,
                        deadline: Instant::now() + self.options.operation_timeout,
                    },
                );
                self.enqueue(SEND, id, &body)?;
            }
        }
        Ok(())
    }
    fn flush_credit(&mut self) -> Result<(), NativeError> {
        if self.bound.is_none() {
            return Ok(());
        }
        let bytes = self.credits.bytes.swap(0, Ordering::AcqRel);
        let packets = self.credits.packets.swap(0, Ordering::AcqRel);
        if bytes == 0 && packets == 0 {
            return Ok(());
        }
        if bytes > BYTE_WINDOW.saturating_sub(self.receive_bytes)
            || packets > RECORD_WINDOW.saturating_sub(self.receive_packets)
        {
            return Err(protocol_error());
        }
        self.receive_bytes += bytes;
        self.receive_packets += packets;
        self.credit_in_flight = true;
        let mut body = Vec::with_capacity(8);
        body.extend_from_slice(&(bytes as u32).to_le_bytes());
        body.extend_from_slice(&(packets as u32).to_le_bytes());
        self.request(CREDIT, CREDIT_APPLIED, Control::Credit, &body, None, None)
    }
    fn event(&mut self, opcode: u8, id: u32, body: Vec<u8>) -> Result<bool, NativeError> {
        if opcode == FAILURE {
            if body.len() != 4 {
                return Err(protocol_error());
            }
            return Err(NativeError::new(
                word(&body, 0),
                "native UDP binding failed",
            ));
        }
        if opcode == CLOSED {
            if self.close_sent.map(|v| v.0) != Some(id)
                || body.len() != 88
                || !self.pending.is_empty()
                || word(&body, 84) != 0
            {
                return Err(protocol_error());
            }
            if self
                .bound
                .is_some_and(|address| decode_address(&body[40..64]).ok() != Some(address))
            {
                return Err(protocol_error());
            }
            self.closed_seen = true;
            return Ok(true);
        }
        if opcode == SEND_RESULT {
            let Some(Pending::Send {
                peer_id,
                epoch,
                reply,
                permit,
                ..
            }) = self.pending.remove(&id)
            else {
                return Err(protocol_error());
            };
            if body.len() != 24
                || word(&body, 0) != peer_id
                || word(&body, 4) != epoch
                || word(&body, 8) > 2
            {
                return Err(protocol_error());
            }
            let disposition = word(&body, 8);
            let code = word(&body, 12);
            let native_code = word(&body, 16);
            if disposition == 0 && (code != 0 || native_code != 0) {
                return Err(protocol_error());
            }
            let outcome = if disposition == 0 {
                Ok(())
            } else {
                Err(NativeError {
                    code: if code == 0 { 10050 } else { code },
                    native_code,
                    message: "native UDP send not accepted",
                })
            };
            let _ = reply.send(Completion {
                outcome,
                _permit: permit,
            });
            return Ok(false);
        }
        if let Some(pending) = self.pending.remove(&id) {
            let Pending::Control {
                expected,
                opcode: request,
                control,
                reply,
                ..
            } = pending
            else {
                return Err(protocol_error());
            };
            if opcode == CONTROL_CANCELLED {
                if body.len() != 8 || word(&body, 0) != request as u32 {
                    return Err(protocol_error());
                }
                if let Some(reply) = reply {
                    let _ = reply.send(Err(NativeError::new(
                        word(&body, 4),
                        "native control cancelled",
                    )));
                }
                if matches!(control, Control::Credit) {
                    self.credit_in_flight = false;
                }
                return Ok(false);
            }
            if opcode != expected {
                return Err(protocol_error());
            }
            let mut outcome = Ok(());
            match control {
                Control::Bind => {
                    if body.len() != 48
                        || [
                            word(&body, 24),
                            word(&body, 28),
                            word(&body, 32),
                            word(&body, 36),
                            word(&body, 40),
                            word(&body, 44),
                        ] != [0x3f, 256, 262144, 256, 64, 128]
                    {
                        return Err(protocol_error());
                    }
                    let address = decode_address(&body[..24])?;
                    if address.port() == 0 || address.is_ipv4() != (self.family == 4) {
                        return Err(protocol_error());
                    }
                    self.bound = Some(address);
                    self.status
                        .send_modify(|status| status.bound = Some(address));
                    self.credits.bytes.store(BYTE_WINDOW, Ordering::Release);
                    self.credits.packets.store(RECORD_WINDOW, Ordering::Release);
                }
                Control::Peer(peer_id, epoch) | Control::Retire(peer_id, epoch) => {
                    if body.len() != 12 || word(&body, 0) != peer_id || word(&body, 4) != epoch {
                        return Err(protocol_error());
                    }
                    let code = word(&body, 8);
                    if code != 0 {
                        outcome = Err(NativeError::new(code, "native peer operation refused"));
                    }
                    if matches!(control, Control::Peer(..)) && code == 0 {
                        if let Some(peer) = self.peers.get_mut(&peer_id) {
                            if peer.epoch == epoch && !self.ending {
                                peer.active = true;
                            }
                        }
                    }
                }
                Control::Credit => {
                    if body.len() != 8
                        || word(&body, 0) > BYTE_WINDOW as u32
                        || word(&body, 4) > RECORD_WINDOW as u32
                    {
                        return Err(protocol_error());
                    }
                    self.credit_in_flight = false;
                }
            }
            if let Some(reply) = reply {
                let _ = reply.send(outcome);
            }
            return Ok(false);
        }
        match opcode {
            RECEIVE => {
                if id != 0
                    || body.len() < 32
                    || self.receive_packets == 0
                    || body.len() - 32 > self.receive_bytes
                {
                    return Err(protocol_error());
                }
                let peer_id = word(&body, 0);
                let epoch = word(&body, 4);
                let endpoint = decode_address(&body[8..32])?;
                let size = body.len() - 32;
                self.receive_bytes -= size;
                self.receive_packets -= 1;
                let credit = ReceiveCredit {
                    shared: self.credits.clone(),
                    bytes: size,
                };
                if !self.ending
                    && self.peers.get(&peer_id).is_some_and(|peer| {
                        peer.active && peer.epoch == epoch && peer.endpoint == endpoint
                    })
                {
                    let bytes = Bytes::from(body).slice(32..);
                    let _ = self.rx.try_send(UdpDatagram {
                        peer_id,
                        epoch,
                        endpoint,
                        bytes,
                        _credit: credit,
                    });
                }
            }
            PEER_ERROR => {
                if id != 0 || body.len() != 56 {
                    return Err(protocol_error());
                }
                let peer_id = word(&body, 0);
                let epoch = word(&body, 4);
                let endpoint = decode_address(&body[8..32])?;
                if self.ending
                    || !self.peers.get(&peer_id).is_some_and(|peer| {
                        peer.active && peer.epoch == epoch && peer.endpoint == endpoint
                    })
                {
                    return Ok(false);
                }
                let error = UdpPeerError {
                    peer_id,
                    epoch,
                    endpoint,
                    code: word(&body, 32),
                    native_code: word(&body, 36),
                    origin: word(&body, 40),
                    kind: word(&body, 44),
                    icmp_code: word(&body, 48),
                    occurrences: word(&body, 52),
                };
                if error.occurrences == 0 || !matches!(error.code, 0 | 10054) {
                    return Err(protocol_error());
                }
                if self.errors.try_send(error).is_err() {
                    self.dropped_errors.fetch_add(1, Ordering::Relaxed);
                }
            }
            LOSSES => {
                if id != 0 || body.len() != 32 {
                    return Err(protocol_error());
                }
                let losses = UdpLosses {
                    rx_packets: wide(&body, 0),
                    rx_bytes: wide(&body, 8),
                    error_records: wide(&body, 16),
                    unattributed_errors: wide(&body, 24),
                };
                if losses.rx_packets < self.last_losses.rx_packets
                    || losses.rx_bytes < self.last_losses.rx_bytes
                    || losses.error_records < self.last_losses.error_records
                    || losses.unattributed_errors < self.last_losses.unattributed_errors
                {
                    return Err(protocol_error());
                }
                self.last_losses = losses;
                let _ = self.losses.send(losses);
            }
            _ => return Err(protocol_error()),
        }
        Ok(false)
    }
    fn fail_pending(&mut self, error: NativeError) {
        for (_, pending) in self.pending.drain() {
            match pending {
                Pending::Send { reply, permit, .. } => {
                    let _ = reply.send(Completion {
                        outcome: Err(error.clone()),
                        _permit: permit,
                    });
                }
                Pending::Control {
                    reply: Some(reply), ..
                } => {
                    let _ = reply.send(Err(error.clone()));
                }
                _ => {}
            }
        }
        while let Ok(command) = self.commands.try_recv() {
            match command {
                Command::Send { reply, permit, .. } => {
                    let _ = reply.send(Completion {
                        outcome: Err(error.clone()),
                        _permit: permit,
                    });
                }
                Command::Peer { reply, .. } | Command::Retire { reply, .. } => {
                    let _ = reply.send(Err(error.clone()));
                }
            }
        }
    }
}
fn protocol_error() -> NativeError {
    NativeError::new(10022, "invalid native UDP protocol")
}
fn word(body: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(body[offset..offset + 4].try_into().unwrap())
}
fn wide(body: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(body[offset..offset + 8].try_into().unwrap())
}
fn normalize_endpoint(endpoint: SocketAddr) -> Result<SocketAddr, NativeError> {
    if endpoint.port() == 0 {
        return Err(protocol_error());
    }
    match endpoint {
        SocketAddr::V4(address) => {
            if address.ip().octets()[0] >= 224 {
                return Err(NativeError::new(
                    10045,
                    "UDP endpoint requires another backend",
                ));
            }
            Ok(SocketAddr::new(
                IpAddr::V4(if address.ip().is_unspecified() {
                    Ipv4Addr::LOCALHOST
                } else {
                    *address.ip()
                }),
                address.port(),
            ))
        }
        SocketAddr::V6(address) => {
            if address.scope_id() != 0
                || address.ip().is_multicast()
                || address.ip().is_unicast_link_local()
                || address.ip().to_ipv4_mapped().is_some()
            {
                return Err(NativeError::new(
                    10045,
                    "UDP endpoint requires another backend",
                ));
            }
            Ok(SocketAddr::new(
                IpAddr::V6(if address.ip().is_unspecified() {
                    Ipv6Addr::LOCALHOST
                } else {
                    *address.ip()
                }),
                address.port(),
            ))
        }
    }
}
fn encode_address(endpoint: SocketAddr, bind: bool) -> Result<[u8; ADDRESS], NativeError> {
    if !bind && endpoint.port() == 0 {
        return Err(protocol_error());
    }
    let mut output = [0u8; ADDRESS];
    output[0] = if endpoint.is_ipv4() { 4 } else { 6 };
    output[2..4].copy_from_slice(&endpoint.port().to_be_bytes());
    match endpoint {
        SocketAddr::V4(v) => output[8..12].copy_from_slice(&v.ip().octets()),
        SocketAddr::V6(v) => {
            if v.scope_id() != 0 {
                return Err(protocol_error());
            }
            output[8..24].copy_from_slice(&v.ip().octets());
        }
    }
    Ok(output)
}
fn decode_address(bytes: &[u8]) -> Result<SocketAddr, NativeError> {
    if bytes.len() != ADDRESS || bytes[1] != 0 || word(bytes, 4) != 0 {
        return Err(protocol_error());
    }
    let port = u16::from_be_bytes(bytes[2..4].try_into().unwrap());
    let ip = match bytes[0] {
        4 => {
            if bytes[12..24].iter().any(|v| *v != 0) {
                return Err(protocol_error());
            }
            IpAddr::V4(Ipv4Addr::new(bytes[8], bytes[9], bytes[10], bytes[11]))
        }
        6 => IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(&bytes[8..24]).unwrap())),
        _ => return Err(protocol_error()),
    };
    Ok(SocketAddr::new(ip, port))
}
fn encode_frame(opcode: u8, id: u32, generation: u32, body: &[u8]) -> Result<Vec<u8>, NativeError> {
    if id == 0 || generation == 0 || body.len() > MAX_PAYLOAD + 8 {
        return Err(protocol_error());
    }
    let mut frame = Vec::with_capacity(HEADER + body.len());
    frame.extend_from_slice(&((HEADER + body.len()) as u32).to_le_bytes());
    frame.extend_from_slice(&[1, opcode, 0, 0]);
    frame.extend_from_slice(&id.to_le_bytes());
    frame.extend_from_slice(&generation.to_le_bytes());
    frame.extend_from_slice(body);
    Ok(frame)
}

#[cfg(test)]
mod tests;
