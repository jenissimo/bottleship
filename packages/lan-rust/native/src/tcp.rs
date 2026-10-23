//! Ordered TCP I/O with whole-call TX admission and explicit receive ownership.
use crate::{
    NativeError,
    budget::{Budget, Permit},
};
use bytes::Bytes;
use std::{
    net::{Shutdown, SocketAddr},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    net::TcpStream,
    sync::{Notify, mpsc, oneshot, watch},
    time::timeout,
};
mod helper;

pub const TCP_WINDOW: usize = 262144;
pub const TCP_SEGMENT: usize = 16384;
#[derive(Clone, Debug)]
pub struct TcpOptions {
    pub helper: Option<PathBuf>,
    pub inline: bool,
    pub keep_alive: bool,
    pub no_delay: bool,
    pub timeout: Duration,
}
impl Default for TcpOptions {
    fn default() -> Self {
        Self {
            helper: None,
            inline: false,
            keep_alive: false,
            no_delay: false,
            timeout: Duration::from_secs(10),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TcpOption {
    Inline,
    KeepAlive,
    NoDelay,
}
impl TcpOption {
    fn native(self) -> u32 {
        match self {
            Self::Inline => 0,
            Self::KeepAlive => 1,
            Self::NoDelay => 2,
        }
    }
}
#[derive(Clone, Debug, Default)]
pub struct TcpStatus {
    pub connected: bool,
    pub remote_eof: bool,
    pub write_finished: bool,
    pub closed: bool,
    pub inline: bool,
    pub keep_alive: bool,
    pub no_delay: bool,
    pub pid: Option<u32>,
    pub error: Option<NativeError>,
}
pub struct ReadCredit {
    permit: Option<Permit>,
    returned: Option<Arc<helper::Returns>>,
    bytes: usize,
    wake: Arc<Notify>,
}
impl Drop for ReadCredit {
    fn drop(&mut self) {
        self.permit.take();
        if let Some(credit) = &self.returned {
            credit.bytes.fetch_add(self.bytes, Ordering::AcqRel);
        }
        self.wake.notify_one();
    }
}
pub enum TcpRead {
    Data { bytes: Bytes, _credit: ReadCredit },
    Urgent { byte: u8, _credit: ReadCredit },
}
impl TcpRead {
    pub fn data(&self) -> Option<&Bytes> {
        match self {
            Self::Data { bytes, .. } => Some(bytes),
            _ => None,
        }
    }
    pub fn urgent(&self) -> Option<u8> {
        match self {
            Self::Urgent { byte, .. } => Some(*byte),
            _ => None,
        }
    }
}
pub struct TcpEvents {
    pub reads: mpsc::Receiver<TcpRead>,
}
struct Completion {
    outcome: Result<(), NativeError>,
    _permit: Permit,
}
pub struct WriteTicket {
    receiver: oneshot::Receiver<Completion>,
}
impl WriteTicket {
    pub async fn completion(self) -> Result<(), NativeError> {
        self.receiver
            .await
            .map_err(|_| NativeError::new(10054, "native write completion retired"))?
            .outcome
    }
}
struct Inner {
    commands: mpsc::Sender<Command>,
    cancel: watch::Sender<bool>,
    status: watch::Receiver<TcpStatus>,
    tx: Arc<Budget>,
    controls: Arc<Budget>,
    fin: AtomicBool,
    admission: std::sync::Mutex<()>,
    startup_timeout: Duration,
}
impl Drop for Inner {
    fn drop(&mut self) {
        let _ = self.cancel.send(true);
    }
}
#[derive(Clone)]
pub struct NativeTcp {
    inner: Arc<Inner>,
}
struct Common {
    status: watch::Sender<TcpStatus>,
    cancel: watch::Sender<bool>,
    tx: Arc<Budget>,
    controls: Arc<Budget>,
    reads: mpsc::Sender<TcpRead>,
    wake: Arc<Notify>,
}
enum Command {
    Write {
        bytes: Bytes,
        urgent: bool,
        reply: oneshot::Sender<Completion>,
        permit: Permit,
    },
    Option {
        option: TcpOption,
        enabled: bool,
        reply: oneshot::Sender<Result<(), NativeError>>,
        _permit: Permit,
    },
    Finish {
        reply: oneshot::Sender<Result<(), NativeError>>,
        _permit: Permit,
    },
}
impl NativeTcp {
    pub fn start(
        endpoint: SocketAddr,
        options: TcpOptions,
    ) -> Result<(Self, TcpEvents), NativeError> {
        if options.timeout.is_zero() {
            return Err(NativeError::new(10022, "invalid native TCP timeout"));
        }
        if options.inline && options.helper.is_none() {
            return Err(NativeError::new(
                10045,
                "inline urgent data requires the native helper",
            ));
        }
        let (commands, input) = mpsc::channel(321);
        let (cancel, cancelling) = watch::channel(false);
        let (state, status) = watch::channel(TcpStatus {
            inline: options.inline,
            keep_alive: options.keep_alive,
            no_delay: options.no_delay,
            ..TcpStatus::default()
        });
        let (reads, events) = mpsc::channel(256);
        let tx = Budget::new(256, TCP_WINDOW);
        let controls = Budget::new(63, 8192);
        let common = Arc::new(Common {
            status: state,
            cancel: cancel.clone(),
            tx: tx.clone(),
            controls: controls.clone(),
            reads,
            wake: Arc::new(Notify::new()),
        });
        let handle = Self {
            inner: Arc::new(Inner {
                commands,
                cancel,
                status,
                tx,
                controls,
                fin: AtomicBool::new(false),
                admission: std::sync::Mutex::new(()),
                startup_timeout: options.timeout,
            }),
        };
        if let Some(path) = options.helper.as_deref() {
            helper::spawn(path, endpoint, &options, common, input, cancelling)?;
        } else {
            tokio::spawn(start_plain(
                endpoint,
                options.clone(),
                common,
                input,
                cancelling,
            ));
        }
        Ok((handle, TcpEvents { reads: events }))
    }
    pub async fn connect(
        endpoint: SocketAddr,
        options: TcpOptions,
    ) -> Result<(Self, TcpEvents), NativeError> {
        let (handle, events) = Self::start(endpoint, options)?;
        match handle.when_connected().await {
            Ok(()) => Ok((handle, events)),
            Err(error) => {
                handle.abort();
                let _ = handle.wait_closed().await;
                Err(error)
            }
        }
    }
    pub async fn when_connected(&self) -> Result<(), NativeError> {
        let mut status = self.inner.status.clone();
        let result = timeout(self.inner.startup_timeout, async {
            loop {
                let state = status.borrow().clone();
                if let Some(error) = state.error {
                    return Err(error);
                }
                if state.connected {
                    return Ok(());
                }
                if state.closed {
                    return Err(NativeError::new(10054, "native TCP closed before connect"));
                }
                status
                    .changed()
                    .await
                    .map_err(|_| NativeError::new(10054, "native TCP driver stopped"))?;
            }
        })
        .await;
        result.map_err(|_| NativeError::new(10060, "native TCP connect timed out"))?
    }
    pub fn status(&self) -> TcpStatus {
        self.inner.status.borrow().clone()
    }
    pub fn subscribe(&self) -> watch::Receiver<TcpStatus> {
        self.inner.status.clone()
    }
    pub fn try_write(&self, bytes: &[u8]) -> Result<WriteTicket, NativeError> {
        self.submit(bytes, false)
    }
    pub fn try_urgent(&self, byte: u8) -> Result<WriteTicket, NativeError> {
        self.submit(&[byte], true)
    }
    fn submit(&self, bytes: &[u8], urgent: bool) -> Result<WriteTicket, NativeError> {
        // One linearization point for cloned handles: an admitted DATA record
        // must precede FIN even if the caller is descheduled during reservation.
        let _admission = self.inner.admission.lock().unwrap();
        if !self.inner.status.borrow().connected {
            return Err(NativeError::new(10057, "native TCP is not connected"));
        }
        if self.inner.fin.load(Ordering::Acquire) {
            return Err(NativeError::new(10058, "native TCP write side is closing"));
        }
        if bytes.len() > TCP_WINDOW {
            return Err(NativeError::new(10055, "native TCP write exceeds window"));
        }
        if urgent && self.inner.status.borrow().pid.is_none() {
            return Err(NativeError::new(
                10045,
                "out-of-line urgent data requires native helper",
            ));
        }
        let records = bytes.len().div_ceil(TCP_SEGMENT).max(1);
        let permit = self.inner.tx.reserve_many(records, bytes.len())?;
        let slot = self
            .inner
            .commands
            .try_reserve()
            .map_err(|_| NativeError::new(10055, "native TCP command queue unavailable"))?;
        let (reply, receiver) = oneshot::channel();
        slot.send(Command::Write {
            bytes: Bytes::copy_from_slice(bytes),
            urgent,
            reply,
            permit,
        });
        Ok(WriteTicket { receiver })
    }
    pub async fn set_option(&self, option: TcpOption, enabled: bool) -> Result<(), NativeError> {
        let permit = self.inner.controls.reserve(12)?;
        let (reply, result) = oneshot::channel();
        self.inner
            .commands
            .try_send(Command::Option {
                option,
                enabled,
                reply,
                _permit: permit,
            })
            .map_err(|_| NativeError::new(10055, "native TCP option queue unavailable"))?;
        result
            .await
            .map_err(|_| NativeError::new(10054, "native option completion retired"))?
    }
    pub async fn finish(&self) -> Result<(), NativeError> {
        let result = {
            let _admission = self.inner.admission.lock().unwrap();
            if self.inner.fin.load(Ordering::Acquire) {
                None
            } else {
                let permit = self.inner.controls.reserve(8)?;
                let (reply, result) = oneshot::channel();
                self.inner
                    .commands
                    .try_send(Command::Finish {
                        reply,
                        _permit: permit,
                    })
                    .map_err(|_| NativeError::new(10055, "native TCP FIN queue unavailable"))?;
                self.inner.fin.store(true, Ordering::Release);
                Some(result)
            }
        };
        if let Some(result) = result {
            return result
                .await
                .map_err(|_| NativeError::new(10054, "native FIN completion retired"))?;
        } else {
            let mut state = self.inner.status.clone();
            loop {
                let status = state.borrow().clone();
                if let Some(error) = status.error {
                    return Err(error);
                }
                if status.write_finished {
                    return Ok(());
                }
                if status.closed {
                    return Err(NativeError::new(10054, "native TCP closed before FIN"));
                }
                state
                    .changed()
                    .await
                    .map_err(|_| NativeError::new(10054, "native TCP driver stopped"))?;
            }
        }
    }
    pub fn abort(&self) {
        self.inner.tx.close();
        self.inner.controls.close();
        let _ = self.inner.cancel.send(true);
    }
    pub async fn wait_closed(&self) -> Result<(), NativeError> {
        let mut state = self.inner.status.clone();
        loop {
            let status = state.borrow().clone();
            if status.closed {
                return status.error.map_or(Ok(()), Err);
            }
            state
                .changed()
                .await
                .map_err(|_| NativeError::new(10054, "native TCP retirement observer stopped"))?;
        }
    }
}
fn report_error(common: &Common, error: NativeError) {
    common.status.send_modify(|status| {
        if status.error.is_none() {
            status.error = Some(error)
        }
    });
    let _ = common.cancel.send(true);
}
fn retire_command(command: Command, error: &NativeError) {
    match command {
        Command::Write { reply, permit, .. } => {
            let _ = reply.send(Completion {
                outcome: Err(error.clone()),
                _permit: permit,
            });
        }
        Command::Option { reply, .. } | Command::Finish { reply, .. } => {
            let _ = reply.send(Err(error.clone()));
        }
    }
}
async fn start_plain(
    endpoint: SocketAddr,
    options: TcpOptions,
    common: Arc<Common>,
    mut input: mpsc::Receiver<Command>,
    mut cancel: watch::Receiver<bool>,
) {
    let connected = tokio::select! {
        biased;
        _=cancel.changed()=>None,
        result=timeout(options.timeout,TcpStream::connect(endpoint))=>Some(result),
    };
    let outcome = match connected {
        None => Err(NativeError::new(10004, "native TCP connect cancelled")),
        Some(Err(_)) => Err(NativeError::new(10060, "native TCP connect timed out")),
        Some(Ok(Err(error))) => Err(NativeError::io(error, "native TCP connect failed")),
        Some(Ok(Ok(stream))) => Ok(stream),
    };
    let stream = match outcome {
        Ok(stream) => stream,
        Err(error) => {
            common.tx.close();
            common.controls.close();
            input.close();
            while let Ok(command) = input.try_recv() {
                retire_command(command, &error);
            }
            common.status.send_modify(|status| {
                status.closed = true;
                if error.code != 10004 {
                    status.error = Some(error);
                }
            });
            return;
        }
    };
    let configured = stream
        .set_nodelay(options.no_delay)
        .and_then(|_| socket2::SockRef::from(&stream).set_keepalive(options.keep_alive));
    if let Err(error) = configured {
        drop(stream);
        let error = NativeError::io(error, "native TCP socket options failed");
        common.tx.close();
        common.controls.close();
        input.close();
        while let Ok(command) = input.try_recv() {
            retire_command(command, &error);
        }
        common.status.send_modify(|status| {
            status.closed = true;
            status.error = Some(error);
        });
        return;
    }
    common.status.send_modify(|status| status.connected = true);
    plain(Arc::new(stream), common, input, cancel).await;
}
async fn plain(
    stream: Arc<TcpStream>,
    common: Arc<Common>,
    mut input: mpsc::Receiver<Command>,
    mut cancelling: watch::Receiver<bool>,
) {
    let receive_budget = Budget::new(256, TCP_WINDOW);
    let reader_socket = stream.clone();
    let reader_common = common.clone();
    let mut read_cancel = cancelling.clone();
    let mut reader = tokio::spawn(async move {
        loop {
            let usage = receive_budget.usage();
            if usage.records >= 256 || usage.bytes >= TCP_WINDOW {
                tokio::select! {biased;_=read_cancel.changed()=>return,_=reader_common.wake.notified()=>{}}
                continue;
            }
            let capacity = TCP_SEGMENT.min(TCP_WINDOW - usage.bytes);
            let mut permit = match receive_budget.reserve(capacity) {
                Ok(p) => p,
                Err(error) => {
                    report_error(&reader_common, error);
                    return;
                }
            };
            let mut bytes = [0u8; TCP_SEGMENT];
            let ready = tokio::select! {biased;_=read_cancel.changed()=>return,result=reader_socket.readable()=>result};
            if let Err(error) = ready {
                report_error(
                    &reader_common,
                    NativeError::io(error, "native TCP read failed"),
                );
                return;
            }
            match reader_socket.try_read(&mut bytes[..capacity]) {
                Ok(0) => {
                    reader_common
                        .status
                        .send_modify(|status| status.remote_eof = true);
                    return;
                }
                Ok(size) => {
                    permit.shrink_bytes(size);
                    let packet = TcpRead::Data {
                        bytes: Bytes::copy_from_slice(&bytes[..size]),
                        _credit: ReadCredit {
                            permit: Some(permit),
                            returned: None,
                            bytes: size,
                            wake: reader_common.wake.clone(),
                        },
                    };
                    if reader_common.reads.try_send(packet).is_err() {
                        report_error(
                            &reader_common,
                            NativeError::new(10055, "native TCP receive record window exhausted"),
                        );
                        return;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => {
                    report_error(
                        &reader_common,
                        NativeError::io(error, "native TCP read failed"),
                    );
                    return;
                }
            }
        }
    });
    let mut reader_done = false;
    let mut write_done = false;
    loop {
        if reader_done && write_done {
            break;
        }
        tokio::select! {
            biased;
            changed=cancelling.changed()=>{if changed.is_err()||*cancelling.borrow_and_update(){break}}
            result=&mut reader,if !reader_done=>{
                reader_done=true;if result.is_err(){report_error(&common,NativeError::new(10050,"native TCP read task failed"));break}
            }
            command=input.recv()=>match command{
                Some(Command::Write{bytes,urgent,reply,permit})=>{
                    let outcome=if urgent{Err(NativeError::new(10045,"urgent send requires native helper"))}else{
                        let mut offset=0;let mut failure=None;
                        while offset<bytes.len(){
                            let ready=tokio::select!{biased;_=cancelling.changed()=>{failure=Some(NativeError::new(10004,"native TCP write aborted"));break}
                                result=stream.writable()=>result};
                            if let Err(error)=ready{failure=Some(NativeError::io(error,"native TCP write failed"));break}
                            match stream.try_write(&bytes[offset..]){
                                Ok(0)=>{failure=Some(NativeError::new(10054,"native TCP write made no progress"));break}
                                Ok(size)=>offset+=size,
                                Err(error)if error.kind()==std::io::ErrorKind::WouldBlock=>{},
                                Err(error)=>{failure=Some(NativeError::io(error,"native TCP write failed"));break}
                            }
                        }
                        failure.map_or(Ok(()),Err)
                    };
                    if let Err(error)=&outcome{report_error(&common,error.clone());}
                    let _=reply.send(Completion{outcome,_permit:permit});
                }
                Some(Command::Option{option,enabled,reply,..})=>{
                    let outcome=match option{
                        TcpOption::Inline=>Err(NativeError::new(10045,"inline urgent option requires native helper")),
                        TcpOption::KeepAlive=>socket2::SockRef::from(&*stream).set_keepalive(enabled).map_err(|e|NativeError::io(e,"SO_KEEPALIVE failed")),
                        TcpOption::NoDelay=>stream.set_nodelay(enabled).map_err(|e|NativeError::io(e,"TCP_NODELAY failed")),
                    };
                    if outcome.is_ok(){common.status.send_modify(|status|match option{TcpOption::Inline=>status.inline=enabled,
                        TcpOption::KeepAlive=>status.keep_alive=enabled,TcpOption::NoDelay=>status.no_delay=enabled});}
                    let _=reply.send(outcome);
                }
                Some(Command::Finish{reply,..})=>{
                    let outcome=socket2::SockRef::from(&*stream).shutdown(Shutdown::Write).map_err(|e|NativeError::io(e,"native TCP FIN failed"));
                    if outcome.is_ok(){write_done=true;common.status.send_modify(|status|status.write_finished=true);}
                    else if let Err(error)=&outcome{report_error(&common,error.clone());}
                    let _=reply.send(outcome);
                }
                None=>break,
            }
        }
    }
    common.tx.close();
    common.controls.close();
    input.close();
    let _ = socket2::SockRef::from(&*stream).shutdown(Shutdown::Both);
    if !reader_done {
        reader.abort();
        let _ = reader.await;
    }
    drop(stream);
    let error = common
        .status
        .borrow()
        .error
        .clone()
        .unwrap_or_else(|| NativeError::new(10004, "native TCP closed"));
    while let Ok(command) = input.try_recv() {
        retire_command(command, &error);
    }
    common.status.send_modify(|status| status.closed = true);
}
