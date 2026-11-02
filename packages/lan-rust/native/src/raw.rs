//! Bounded IPC for the existing optional raw/scoped-UDP native helper.
//! Controls are admitted in DATA order; only DATA and UDP tuple reservations
//! have helper acknowledgements. Close always waits for actual child retirement.
use crate::{
    NativeError,
    budget::{Budget, Permit},
};
use bytes::Bytes;
use std::{
    collections::HashMap,
    io,
    net::SocketAddr,
    path::Path,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command as Process,
    sync::{Notify, mpsc, oneshot, watch},
    time::{Instant, timeout},
};
pub const RAW_WINDOW: usize = 262144;
pub const RAW_MAX_PACKET: usize = 65535;
#[derive(Clone, Copy, Debug)]
pub enum RawMode {
    Raw { protocol: u8, header_included: bool },
    Udp,
}
#[derive(Clone, Debug)]
pub struct RawOptions {
    pub timeout: Duration,
}
impl Default for RawOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(10),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UdpTuple {
    pub guest_port: u16,
    pub remote_port: u16,
    pub native_port: u16,
}
#[derive(Clone, Debug, Default)]
pub struct RawStatus {
    pub connected: bool,
    pub closed: bool,
    pub pid: Option<u32>,
    pub tuple: Option<UdpTuple>,
    pub error: Option<NativeError>,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct RawLoss {
    pub packets: u64,
    pub bytes: u64,
}
struct Returns {
    bytes: AtomicUsize,
    wake: Notify,
}
pub struct RawPacket {
    pub bytes: Bytes,
    _credit: Credit,
}
struct Credit {
    _permit: Permit,
    bytes: usize,
    returns: Arc<Returns>,
}
impl Drop for Credit {
    fn drop(&mut self) {
        self.returns.bytes.fetch_add(self.bytes, Ordering::AcqRel);
        self.returns.wake.notify_one();
    }
}
pub struct RawEvents {
    pub packets: mpsc::Receiver<RawPacket>,
    pub losses: watch::Receiver<RawLoss>,
}
struct Completion {
    outcome: Result<(), NativeError>,
    _permit: Permit,
}
pub struct RawSendTicket {
    receiver: oneshot::Receiver<Completion>,
}
impl RawSendTicket {
    pub async fn completion(self) -> Result<(), NativeError> {
        self.receiver
            .await
            .map_err(|_| NativeError::new(10054, "native raw completion retired"))?
            .outcome
    }
}
struct Inner {
    commands: mpsc::Sender<Command>,
    cancel: watch::Sender<bool>,
    status: watch::Receiver<RawStatus>,
    tx: Arc<Budget>,
    controls: Arc<Budget>,
    timeout: Duration,
}
impl Drop for Inner {
    fn drop(&mut self) {
        let _ = self.cancel.send(true);
    }
}
#[derive(Clone)]
pub struct NativeRaw {
    inner: Arc<Inner>,
}
enum Command {
    Send {
        bytes: Bytes,
        reply: oneshot::Sender<Completion>,
        permit: Permit,
    },
    Control {
        kind: u32,
        body: Vec<u8>,
        permit: Permit,
    },
}
struct Output {
    bytes: Vec<u8>,
    credit: bool,
    _permit: Option<Permit>,
}
enum Event {
    Frame(u32, Vec<u8>),
    Packet(Vec<u8>, Permit),
    Dropped(usize),
    CreditWritten,
    End,
    Error(NativeError),
}
struct Pending {
    reply: oneshot::Sender<Completion>,
    permit: Permit,
    deadline: Instant,
}
struct Driver {
    input: mpsc::Receiver<Command>,
    cancel: watch::Receiver<bool>,
    writer: mpsc::Sender<Output>,
    events: mpsc::Receiver<Event>,
    state: watch::Sender<RawStatus>,
    packets: mpsc::Sender<RawPacket>,
    losses: watch::Sender<RawLoss>,
    pending: HashMap<u32, Pending>,
    next: u64,
    startup: Option<Instant>,
    tuple_pending: Option<(u16, u16, Instant)>,
    timeout: Duration,
    returns: Arc<Returns>,
    receive_credit: usize,
    credit_pending: bool,
}
fn invalid() -> NativeError {
    NativeError::new(10022, "invalid native raw helper record")
}
fn word(body: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(body[offset..offset + 4].try_into().unwrap())
}
fn frame(kind: u32, body: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(8 + body.len());
    bytes.extend_from_slice(&kind.to_le_bytes());
    bytes.extend_from_slice(&(body.len() as u32).to_le_bytes());
    bytes.extend_from_slice(body);
    bytes
}
impl NativeRaw {
    pub fn start(
        path: &Path,
        endpoint: SocketAddr,
        mode: RawMode,
        options: RawOptions,
    ) -> Result<(Self, RawEvents), NativeError> {
        if options.timeout.is_zero() {
            return Err(NativeError::new(10022, "invalid native raw timeout"));
        }
        let host = match endpoint {
            SocketAddr::V6(v) if v.scope_id() != 0 => format!("{}%{}", v.ip(), v.scope_id()),
            _ => endpoint.ip().to_string(),
        };
        let family = if endpoint.is_ipv4() { 4 } else { 6 };
        let args = match mode {
            RawMode::Raw {
                protocol,
                header_included,
            } => vec![
                format!("raw{family}"),
                host,
                protocol.to_string(),
                if header_included { "1" } else { "0" }.into(),
            ],
            RawMode::Udp => vec![format!("udp{family}"), host, endpoint.port().to_string()],
        };
        let mut child = Process::new(path)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| NativeError::new(10045, "native raw helper unavailable"))?;
        let (commands, input) = mpsc::channel(128);
        let (cancel, cancelling) = watch::channel(false);
        let (state, status) = watch::channel(RawStatus {
            pid: child.id(),
            ..RawStatus::default()
        });
        let (packets, packet_events) = mpsc::channel(256);
        let (losses, loss_events) = watch::channel(RawLoss::default());
        let tx = Budget::new(64, RAW_WINDOW);
        let controls = Budget::new(63, 8192);
        let returns = Arc::new(Returns {
            bytes: AtomicUsize::new(RAW_WINDOW),
            wake: Notify::new(),
        });
        let inner = Arc::new(Inner {
            commands,
            cancel,
            status,
            tx: tx.clone(),
            controls: controls.clone(),
            timeout: options.timeout,
        });
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let (writer, mut outputs) = mpsc::channel::<Output>(128);
        let (send, events) = mpsc::channel(32);
        let write_events = send.clone();
        let write_task = tokio::spawn(async move {
            while let Some(output) = outputs.recv().await {
                if let Err(error) = stdin.write_all(&output.bytes).await {
                    let _ = write_events
                        .send(Event::Error(NativeError::io(
                            error,
                            "native raw input pipe failed",
                        )))
                        .await;
                    return;
                }
                if output.credit && write_events.send(Event::CreditWritten).await.is_err() {
                    return;
                }
            }
        });
        let receive_budget = Budget::new(256, RAW_WINDOW);
        let read_task = tokio::spawn(async move {
            loop {
                let mut header = [0u8; 8];
                if let Err(error) = stdout.read_exact(&mut header).await {
                    let event = if error.kind() == io::ErrorKind::UnexpectedEof {
                        Event::End
                    } else {
                        Event::Error(NativeError::io(error, "native raw output pipe failed"))
                    };
                    let _ = send.send(event).await;
                    return;
                }
                let kind = word(&header, 0);
                let length = word(&header, 4) as usize;
                let valid = match kind {
                    10 => length == 0,
                    14 | 15 => length == 4,
                    17 => length <= RAW_MAX_PACKET,
                    18 => length == 12,
                    _ => false,
                };
                if !valid {
                    let _ = send.send(Event::Error(invalid())).await;
                    return;
                }
                // Admission precedes variable packet allocation. At exhaustion,
                // consume exactly one bounded record and coalesce UDP/raw loss.
                let permit = if kind == 17 {
                    receive_budget.reserve(length).ok()
                } else {
                    None
                };
                let mut body = vec![0; length];
                if let Err(error) = stdout.read_exact(&mut body).await {
                    let _ = send
                        .send(Event::Error(NativeError::io(
                            error,
                            "truncated native raw record",
                        )))
                        .await;
                    return;
                }
                let event = if kind == 17 {
                    if let Some(permit) = permit {
                        Event::Packet(body, permit)
                    } else {
                        Event::Dropped(length)
                    }
                } else {
                    Event::Frame(kind, body)
                };
                if send.send(event).await.is_err() {
                    return;
                }
            }
        });
        let mut driver = Driver {
            input,
            cancel: cancelling,
            writer,
            events,
            state,
            packets,
            losses,
            pending: HashMap::new(),
            next: 1,
            startup: Some(Instant::now() + options.timeout),
            tuple_pending: None,
            timeout: options.timeout,
            returns,
            receive_credit: 0,
            credit_pending: false,
        };
        tokio::spawn(async move {
            let result = driver.run().await;
            tx.close();
            controls.close();
            driver.input.close();
            let error = result
                .clone()
                .err()
                .unwrap_or_else(|| NativeError::new(10004, "native raw socket closed"));
            for (_, pending) in driver.pending.drain() {
                let _ = pending.reply.send(Completion {
                    outcome: Err(error.clone()),
                    _permit: pending.permit,
                });
            }
            while let Ok(command) = driver.input.try_recv() {
                if let Command::Send { reply, permit, .. } = command {
                    let _ = reply.send(Completion {
                        outcome: Err(error.clone()),
                        _permit: permit,
                    });
                }
            }
            // Cancellation is independent of pipe capacity and pending ACKs.
            let _ = child.start_kill();
            let retired = child.wait().await;
            write_task.abort();
            read_task.abort();
            let _ = write_task.await;
            let _ = read_task.await;
            let terminal = result.err().or_else(|| {
                retired
                    .err()
                    .map(|error| NativeError::io(error, "native raw child retirement failed"))
            });
            driver.state.send_modify(|state| {
                state.closed = true;
                state.error = terminal;
            });
        });
        Ok((
            Self { inner },
            RawEvents {
                packets: packet_events,
                losses: loss_events,
            },
        ))
    }
    pub fn status(&self) -> RawStatus {
        self.inner.status.borrow().clone()
    }
    pub fn subscribe(&self) -> watch::Receiver<RawStatus> {
        self.inner.status.clone()
    }
    pub async fn when_connected(&self) -> Result<(), NativeError> {
        let mut status = self.subscribe();
        timeout(self.inner.timeout, async {
            loop {
                let value = status.borrow().clone();
                if let Some(error) = value.error {
                    return Err(error);
                }
                if value.closed {
                    return Err(NativeError::new(10054, "native raw closed before connect"));
                }
                if value.connected {
                    return Ok(());
                }
                status
                    .changed()
                    .await
                    .map_err(|_| NativeError::new(10054, "native raw driver stopped"))?;
            }
        })
        .await
        .map_err(|_| NativeError::new(10060, "native raw connect timed out"))?
    }
    pub fn try_send(&self, bytes: &[u8]) -> Result<RawSendTicket, NativeError> {
        if self.inner.status.borrow().closed {
            return Err(NativeError::new(10057, "native raw socket closed"));
        }
        if bytes.len() > RAW_MAX_PACKET {
            return Err(NativeError::new(10040, "native raw packet too large"));
        }
        let permit = self.inner.tx.reserve(bytes.len())?;
        let slot = self
            .inner
            .commands
            .try_reserve()
            .map_err(|_| NativeError::new(10055, "native raw command admission exhausted"))?;
        let (reply, receiver) = oneshot::channel();
        slot.send(Command::Send {
            bytes: Bytes::copy_from_slice(bytes),
            reply,
            permit,
        });
        Ok(RawSendTicket { receiver })
    }
    fn control(&self, kind: u32, body: Vec<u8>) -> Result<(), NativeError> {
        let permit = self.inner.controls.reserve(body.len() + 8)?;
        self.inner
            .commands
            .try_send(Command::Control { kind, body, permit })
            .map_err(|_| NativeError::new(10055, "native raw control admission exhausted"))
    }
    /// Ordered admission, without a helper-level acknowledgement.
    pub fn set_guest_addresses(
        &self,
        source: &[u8],
        destination: &[u8],
    ) -> Result<(), NativeError> {
        if source.len() != destination.len() || !matches!(source.len(), 4 | 16) {
            return Err(invalid());
        }
        let mut body = vec![0; 36];
        body[..4].copy_from_slice(&(if source.len() == 4 { 4u32 } else { 6 }).to_le_bytes());
        body[4..4 + source.len()].copy_from_slice(source);
        body[20..20 + destination.len()].copy_from_slice(destination);
        self.control(8, body)
    }
    pub fn set_ip_options(&self, ttl: i32, tos: u32) -> Result<(), NativeError> {
        if !(-1..=255).contains(&ttl) || tos > 255 {
            return Err(invalid());
        }
        let mut body = Vec::with_capacity(8);
        body.extend_from_slice(&ttl.to_le_bytes());
        body.extend_from_slice(&tos.to_le_bytes());
        self.control(7, body)
    }
    /// Reservation readiness is observed in status.tuple, never inferred from admission.
    pub fn set_udp_tuple(&self, guest_port: u16, remote_port: u16) -> Result<(), NativeError> {
        let mut body = Vec::with_capacity(8);
        body.extend_from_slice(&(guest_port as u32).to_le_bytes());
        body.extend_from_slice(&(remote_port as u32).to_le_bytes());
        self.control(9, body)
    }
    pub fn abort(&self) {
        self.inner.tx.close();
        self.inner.controls.close();
        let _ = self.inner.cancel.send(true);
    }
    pub async fn wait_closed(&self) -> Result<(), NativeError> {
        let mut status = self.subscribe();
        loop {
            let value = status.borrow().clone();
            if value.closed {
                return value.error.map_or(Ok(()), Err);
            }
            status
                .changed()
                .await
                .map_err(|_| NativeError::new(10054, "native raw retirement observer stopped"))?;
        }
    }
}
impl Driver {
    fn enqueue(
        &self,
        kind: u32,
        body: &[u8],
        credit: bool,
        permit: Option<Permit>,
    ) -> Result<(), NativeError> {
        self.writer
            .try_send(Output {
                bytes: frame(kind, body),
                credit,
                _permit: permit,
            })
            .map_err(|_| NativeError::new(10055, "native raw pipe admission exhausted"))
    }
    fn credit(&mut self) -> Result<(), NativeError> {
        if self.credit_pending {
            return Ok(());
        }
        let bytes = self.returns.bytes.swap(0, Ordering::AcqRel);
        if bytes == 0 {
            return Ok(());
        }
        if bytes > RAW_WINDOW.saturating_sub(self.receive_credit) {
            return Err(invalid());
        }
        self.receive_credit += bytes;
        self.credit_pending = true;
        self.enqueue(4, &(bytes as u32).to_le_bytes(), true, None)
    }
    fn command(&mut self, command: Command) -> Result<(), NativeError> {
        match command {
            Command::Control { kind, body, permit } => {
                if kind == 9 {
                    if self.tuple_pending.is_some() || self.state.borrow().tuple.is_some() {
                        return Err(invalid());
                    }
                    self.tuple_pending = Some((
                        word(&body, 0) as u16,
                        word(&body, 4) as u16,
                        Instant::now() + self.timeout,
                    ));
                }
                self.enqueue(kind, &body, false, Some(permit))
            }
            Command::Send {
                bytes,
                reply,
                permit,
            } => {
                if self.next > u32::MAX as u64 {
                    let error = NativeError::new(10055, "native raw request identity exhausted");
                    let _ = reply.send(Completion {
                        outcome: Err(error.clone()),
                        _permit: permit,
                    });
                    return Err(error);
                }
                let id = self.next as u32;
                self.next += 1;
                let mut body = Vec::with_capacity(4 + bytes.len());
                body.extend_from_slice(&id.to_le_bytes());
                body.extend_from_slice(&bytes);
                self.pending.insert(
                    id,
                    Pending {
                        reply,
                        permit,
                        deadline: Instant::now() + self.timeout,
                    },
                );
                self.enqueue(1, &body, false, None)
            }
        }
    }
    fn event(&mut self, event: Event) -> Result<(), NativeError> {
        match event {
            Event::CreditWritten => self.credit_pending = false,
            Event::Error(error) => return Err(error),
            Event::End => return Err(NativeError::new(10054, "native raw helper exited")),
            Event::Packet(body, permit) => {
                if body.len() > self.receive_credit {
                    return Err(invalid());
                }
                self.receive_credit -= body.len();
                let size = body.len();
                let packet = RawPacket {
                    bytes: Bytes::from(body),
                    _credit: Credit {
                        _permit: permit,
                        bytes: size,
                        returns: self.returns.clone(),
                    },
                };
                if self.packets.try_send(packet).is_err() {
                    self.losses.send_modify(|loss| {
                        loss.packets = loss.packets.saturating_add(1);
                        loss.bytes = loss.bytes.saturating_add(size as u64)
                    });
                }
            }
            Event::Dropped(size) => {
                if size > self.receive_credit {
                    return Err(invalid());
                }
                self.receive_credit -= size;
                self.returns.bytes.fetch_add(size, Ordering::AcqRel);
                self.losses.send_modify(|loss| {
                    loss.packets = loss.packets.saturating_add(1);
                    loss.bytes = loss.bytes.saturating_add(size as u64)
                });
            }
            Event::Frame(kind, body) => match kind {
                10 => {
                    if self.startup.take().is_none() {
                        return Err(invalid());
                    }
                    self.state.send_modify(|s| s.connected = true);
                }
                14 => {
                    return Err(NativeError::new(
                        word(&body, 0),
                        "native raw socket operation failed",
                    ));
                }
                15 => {
                    let Some(pending) = self.pending.remove(&word(&body, 0)) else {
                        return Err(invalid());
                    };
                    let _ = pending.reply.send(Completion {
                        outcome: Ok(()),
                        _permit: pending.permit,
                    });
                }
                18 => {
                    let g = word(&body, 0);
                    let r = word(&body, 4);
                    let n = word(&body, 8);
                    if g > 65535 || r > 65535 || n == 0 || n > 65535 {
                        return Err(invalid());
                    }
                    let Some((guest, remote, _)) = self.tuple_pending.take() else {
                        return Err(invalid());
                    };
                    if g != guest as u32 || r != remote as u32 {
                        return Err(invalid());
                    }
                    self.state.send_modify(|s| {
                        s.tuple = Some(UdpTuple {
                            guest_port: g as u16,
                            remote_port: r as u16,
                            native_port: n as u16,
                        })
                    });
                }
                _ => return Err(invalid()),
            },
        }
        Ok(())
    }
    async fn run(&mut self) -> Result<(), NativeError> {
        self.credit()?;
        loop {
            let mut deadline = self.startup;
            if let Some((_, _, until)) = self.tuple_pending {
                deadline = Some(deadline.map_or(until, |old| old.min(until)));
            }
            for pending in self.pending.values() {
                deadline = Some(deadline.map_or(pending.deadline, |old| old.min(pending.deadline)));
            }
            tokio::select! {
                biased;
                changed=self.cancel.changed()=>if changed.is_err()||*self.cancel.borrow_and_update(){return Ok(())},
                _=async{if let Some(until)=deadline{tokio::time::sleep_until(until).await}else{std::future::pending::<()>().await}}=>
                    return Err(NativeError::new(10060,"native raw helper operation timed out")),
                event=self.events.recv()=>match event{Some(event)=>self.event(event)?,None=>return Err(NativeError::new(10054,"native raw pipe tasks stopped"))},
                command=self.input.recv()=>match command{Some(command)=>self.command(command)?,None=>return Ok(())},
                _=self.returns.wake.notified(),if !self.credit_pending=>{},
            }
            self.credit()?;
        }
    }
}
