use super::*;
use std::{
    collections::HashMap,
    io,
    path::Path,
    process::Stdio,
    sync::{Mutex, atomic::AtomicUsize},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command as Process,
    time::Instant,
};

pub(super) struct Returns {
    pub bytes: AtomicUsize,
}
struct Output {
    bytes: Vec<u8>,
    credit: bool,
}
enum Event {
    Frame(u32, Vec<u8>),
    CreditWritten,
    End,
    Error(NativeError),
}
struct WriteState {
    remaining: usize,
    reply: Option<oneshot::Sender<Completion>>,
    permit: Option<Permit>,
}
struct Batch {
    state: Mutex<WriteState>,
}
impl Batch {
    fn ack(&self) {
        let mut state = self.state.lock().unwrap();
        state.remaining -= 1;
        if state.remaining == 0 {
            if let (Some(reply), Some(permit)) = (state.reply.take(), state.permit.take()) {
                let _ = reply.send(Completion {
                    outcome: Ok(()),
                    _permit: permit,
                });
            }
        }
    }
    fn fail(&self, error: &NativeError) {
        let mut state = self.state.lock().unwrap();
        if let (Some(reply), Some(permit)) = (state.reply.take(), state.permit.take()) {
            let _ = reply.send(Completion {
                outcome: Err(error.clone()),
                _permit: permit,
            });
        }
    }
}
struct PendingOption {
    option: TcpOption,
    reply: oneshot::Sender<Result<(), NativeError>>,
    _permit: Permit,
    deadline: Instant,
}
struct Driver {
    common: Arc<Common>,
    input: mpsc::Receiver<Command>,
    cancel: watch::Receiver<bool>,
    writer: mpsc::Sender<Output>,
    events: mpsc::Receiver<Event>,
    writes: HashMap<u32, (Arc<Batch>, Instant)>,
    options: HashMap<u32, PendingOption>,
    finish: Option<(oneshot::Sender<Result<(), NativeError>>, Permit, Instant)>,
    next: u64,
    credits: Arc<Returns>,
    read_budget: Arc<Budget>,
    receive_credit: usize,
    credit_pending: bool,
    timeout: Duration,
    startup: Option<Instant>,
    closed_seen: bool,
}
fn word(body: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(body[offset..offset + 4].try_into().unwrap())
}
fn invalid() -> NativeError {
    NativeError::new(10022, "invalid native TCP helper record")
}
fn packet(kind: u32, body: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(8 + body.len());
    bytes.extend_from_slice(&kind.to_le_bytes());
    bytes.extend_from_slice(&(body.len() as u32).to_le_bytes());
    bytes.extend_from_slice(body);
    bytes
}
pub(super) fn spawn(
    path: &Path,
    endpoint: SocketAddr,
    options: &TcpOptions,
    common: Arc<Common>,
    input: mpsc::Receiver<Command>,
    cancel: watch::Receiver<bool>,
) -> Result<(), NativeError> {
    let host = match endpoint {
        SocketAddr::V6(address) if address.scope_id() != 0 => {
            format!("{}%{}", address.ip(), address.scope_id())
        }
        _ => endpoint.ip().to_string(),
    };
    let mut child = Process::new(path)
        .args([
            "tcp",
            &host,
            &endpoint.port().to_string(),
            if options.inline { "1" } else { "0" },
            if options.keep_alive { "1" } else { "0" },
            if options.no_delay { "1" } else { "0" },
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| NativeError::new(10045, "native TCP helper unavailable"))?;
    let pid = child.id();
    common.status.send_modify(|status| status.pid = pid);
    let mut stdout = child.stdout.take().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let (writer, mut writes) = mpsc::channel::<Output>(321);
    let (send, events) = mpsc::channel(32);
    let send_writer = send.clone();
    let write_task = tokio::spawn(async move {
        while let Some(output) = writes.recv().await {
            if let Err(error) = stdin.write_all(&output.bytes).await {
                let _ = send_writer
                    .send(Event::Error(NativeError::io(
                        error,
                        "native TCP input pipe failed",
                    )))
                    .await;
                return;
            }
            if output.credit && send_writer.send(Event::CreditWritten).await.is_err() {
                return;
            }
        }
    });
    let read_task = tokio::spawn(async move {
        loop {
            let mut header = [0u8; 8];
            if let Err(error) = stdout.read_exact(&mut header).await {
                let event = if error.kind() == io::ErrorKind::UnexpectedEof {
                    Event::End
                } else {
                    Event::Error(NativeError::io(error, "native TCP output pipe failed"))
                };
                let _ = send.send(event).await;
                return;
            }
            let kind = word(&header, 0);
            let length = word(&header, 4) as usize;
            if length > TCP_SEGMENT {
                let _ = send.send(Event::Error(invalid())).await;
                return;
            }
            let mut body = vec![0; length];
            if let Err(error) = stdout.read_exact(&mut body).await {
                let _ = send
                    .send(Event::Error(NativeError::io(
                        error,
                        "truncated native TCP record",
                    )))
                    .await;
                return;
            }
            if send.send(Event::Frame(kind, body)).await.is_err() {
                return;
            }
        }
    });
    let mut driver = Driver {
        common,
        input,
        cancel,
        writer,
        events,
        writes: HashMap::new(),
        options: HashMap::new(),
        finish: None,
        next: 1,
        credits: Arc::new(Returns {
            bytes: AtomicUsize::new(TCP_WINDOW),
        }),
        read_budget: Budget::new(256, TCP_WINDOW),
        receive_credit: 0,
        credit_pending: false,
        timeout: options.timeout,
        startup: Some(Instant::now() + options.timeout),
        closed_seen: false,
    };
    tokio::spawn(async move {
        let result = driver.run().await;
        driver.common.tx.close();
        driver.common.controls.close();
        driver.input.close();
        let error = result
            .clone()
            .err()
            .unwrap_or_else(|| NativeError::new(10004, "native TCP helper closed"));
        for (_, (batch, _)) in driver.writes.drain() {
            batch.fail(&error);
        }
        for (_, option) in driver.options.drain() {
            let _ = option.reply.send(Err(error.clone()));
        }
        if let Some((reply, _, _)) = driver.finish.take() {
            let _ = reply.send(Err(error.clone()));
        }
        while let Ok(command) = driver.input.try_recv() {
            retire_command(command, &error);
        }
        let mut terminal = result.err();
        if !driver.closed_seen {
            let _ = child.start_kill();
        }
        match timeout(Duration::from_secs(2), child.wait()).await {
            Ok(Ok(status)) if driver.closed_seen && !status.success() => {
                terminal = Some(NativeError::new(
                    10054,
                    "native TCP helper exited with failure",
                ))
            }
            Ok(Ok(_)) => {}
            _ => {
                let _ = child.start_kill();
                let _ = timeout(Duration::from_secs(2), child.wait()).await;
                terminal = Some(NativeError::new(
                    10060,
                    "native TCP helper retirement timed out",
                ));
            }
        }
        write_task.abort();
        read_task.abort();
        let _ = write_task.await;
        let _ = read_task.await;
        driver.common.status.send_modify(|status| {
            status.closed = true;
            if status.error.is_none() {
                status.error = terminal;
            }
        });
    });
    Ok(())
}
impl Driver {
    fn identity(&mut self) -> Result<u32, NativeError> {
        if self.next > u32::MAX as u64 {
            return Err(NativeError::new(
                10055,
                "native TCP request identity exhausted",
            ));
        }
        let id = self.next as u32;
        self.next += 1;
        Ok(id)
    }
    fn enqueue(&self, kind: u32, body: &[u8], credit: bool) -> Result<(), NativeError> {
        self.writer
            .try_send(Output {
                bytes: packet(kind, body),
                credit,
            })
            .map_err(|_| NativeError::new(10055, "native TCP pipe admission exhausted"))
    }
    fn credit(&mut self) -> Result<(), NativeError> {
        if self.credit_pending {
            return Ok(());
        }
        let bytes = self.credits.bytes.swap(0, Ordering::AcqRel);
        if bytes == 0 {
            return Ok(());
        }
        if bytes > TCP_WINDOW.saturating_sub(self.receive_credit) {
            return Err(invalid());
        }
        self.receive_credit += bytes;
        self.credit_pending = true;
        self.enqueue(4, &(bytes as u32).to_le_bytes(), true)
    }
    async fn run(&mut self) -> Result<(), NativeError> {
        self.credit()?;
        loop {
            let mut deadline = self.startup;
            for (_, until) in self.writes.values() {
                deadline = Some(deadline.map_or(*until, |old| old.min(*until)))
            }
            for option in self.options.values() {
                deadline = Some(deadline.map_or(option.deadline, |old| old.min(option.deadline)))
            }
            if let Some((_, _, until)) = &self.finish {
                deadline = Some(deadline.map_or(*until, |old| old.min(*until)))
            }
            tokio::select! {
                biased;
                changed=self.cancel.changed()=>{if changed.is_err()||*self.cancel.borrow_and_update(){return Ok(())}}
                _=async{if let Some(until)=deadline{tokio::time::sleep_until(until).await}else{std::future::pending::<()>().await}}=>
                    return Err(NativeError::new(10060,"native TCP helper operation timed out")),
                event=self.events.recv()=>match event{
                    Some(Event::Frame(kind,body))=>if self.event(kind,body)?{return Ok(())},
                    Some(Event::CreditWritten)=>self.credit_pending=false,
                    Some(Event::Error(error))=>return Err(error),
                    Some(Event::End)|None=>return Err(NativeError::new(10054,"native TCP helper exited before CLOSED")),
                },
                command=self.input.recv()=>match command{Some(command)=>self.command(command)?,None=>return Ok(())},
                _=self.common.wake.notified(),if !self.credit_pending=>{},
            }
            self.credit()?;
        }
    }
    fn command(&mut self, command: Command) -> Result<(), NativeError> {
        match command {
            Command::Write {
                bytes,
                urgent,
                reply,
                permit,
            } => {
                if bytes.is_empty() {
                    let _ = reply.send(Completion {
                        outcome: Ok(()),
                        _permit: permit,
                    });
                    return Ok(());
                }
                let count = bytes.len().div_ceil(TCP_SEGMENT);
                let batch = Arc::new(Batch {
                    state: Mutex::new(WriteState {
                        remaining: count,
                        reply: Some(reply),
                        permit: Some(permit),
                    }),
                });
                for part in bytes.chunks(TCP_SEGMENT) {
                    let id = match self.identity() {
                        Ok(id) => id,
                        Err(error) => {
                            batch.fail(&error);
                            return Err(error);
                        }
                    };
                    let mut body = Vec::with_capacity(4 + part.len());
                    body.extend_from_slice(&id.to_le_bytes());
                    body.extend_from_slice(part);
                    self.writes
                        .insert(id, (batch.clone(), Instant::now() + self.timeout));
                    self.enqueue(if urgent { 2 } else { 1 }, &body, false)?;
                }
            }
            Command::Option {
                option,
                enabled,
                reply,
                _permit,
            } => {
                let id = self.identity()?;
                let mut body = Vec::with_capacity(12);
                body.extend_from_slice(&id.to_le_bytes());
                body.extend_from_slice(&option.native().to_le_bytes());
                body.extend_from_slice(&(enabled as u32).to_le_bytes());
                self.options.insert(
                    id,
                    PendingOption {
                        option,
                        reply,
                        _permit,
                        deadline: Instant::now() + self.timeout,
                    },
                );
                self.enqueue(11, &body, false)?;
            }
            Command::Finish { reply, _permit } => {
                if self.finish.is_some() {
                    return Err(invalid());
                }
                self.finish = Some((reply, _permit, Instant::now() + self.timeout));
                self.enqueue(3, &[], false)?;
            }
        }
        Ok(())
    }
    fn event(&mut self, kind: u32, body: Vec<u8>) -> Result<bool, NativeError> {
        match kind {
            10 if body.is_empty() => {
                self.startup = None;
                self.common
                    .status
                    .send_modify(|status| status.connected = true);
            }
            11 if !body.is_empty() => {
                if body.len() > self.receive_credit {
                    return Err(invalid());
                }
                let permit = self.read_budget.reserve(body.len())?;
                let size = body.len();
                self.receive_credit -= size;
                let packet = TcpRead::Data {
                    bytes: Bytes::from(body),
                    _credit: ReadCredit {
                        permit: Some(permit),
                        returned: Some(self.credits.clone()),
                        bytes: size,
                        wake: self.common.wake.clone(),
                    },
                };
                self.common
                    .reads
                    .try_send(packet)
                    .map_err(|_| NativeError::new(10055, "native TCP receive records exhausted"))?;
            }
            12 if body.len() == 1 => {
                if self.receive_credit == 0 {
                    return Err(invalid());
                }
                let permit = self.read_budget.reserve(1)?;
                self.receive_credit -= 1;
                let packet = TcpRead::Urgent {
                    byte: body[0],
                    _credit: ReadCredit {
                        permit: Some(permit),
                        returned: Some(self.credits.clone()),
                        bytes: 1,
                        wake: self.common.wake.clone(),
                    },
                };
                self.common
                    .reads
                    .try_send(packet)
                    .map_err(|_| NativeError::new(10055, "native TCP urgent records exhausted"))?;
            }
            13 if body.is_empty() => self
                .common
                .status
                .send_modify(|status| status.remote_eof = true),
            14 if body.len() == 4 => {
                return Err(NativeError::new(
                    word(&body, 0),
                    "native TCP socket operation failed",
                ));
            }
            15 if body.len() == 4 => {
                let id = word(&body, 0);
                let Some((batch, _)) = self.writes.remove(&id) else {
                    return Err(invalid());
                };
                batch.ack();
            }
            16 if body.is_empty() => {
                if !self.writes.is_empty() {
                    return Err(invalid());
                }
                self.closed_seen = true;
                return Ok(true);
            }
            19 if body.is_empty() => {
                let Some((reply, _permit, _)) = self.finish.take() else {
                    return Err(invalid());
                };
                self.common
                    .status
                    .send_modify(|status| status.write_finished = true);
                let _ = reply.send(Ok(()));
            }
            20 if body.len() == 8 => {
                let option = word(&body, 0);
                let value = word(&body, 4);
                if !matches!(option, 1 | 2) || value > 1 {
                    return Err(invalid());
                }
                self.common.status.send_modify(|status| {
                    if option == 1 {
                        status.keep_alive = value != 0
                    } else {
                        status.no_delay = value != 0
                    }
                });
            }
            21 if body.len() == 12 => {
                let id = word(&body, 0);
                let option = word(&body, 4);
                let value = word(&body, 8);
                let Some(pending) = self.options.remove(&id) else {
                    return Err(invalid());
                };
                if pending.option.native() != option || value > 1 {
                    return Err(invalid());
                }
                self.common
                    .status
                    .send_modify(|status| match pending.option {
                        TcpOption::Inline => status.inline = value != 0,
                        TcpOption::KeepAlive => status.keep_alive = value != 0,
                        TcpOption::NoDelay => status.no_delay = value != 0,
                    });
                let _ = pending.reply.send(Ok(()));
            }
            _ => return Err(invalid()),
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests;
