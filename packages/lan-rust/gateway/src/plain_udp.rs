//! Ordinary unconnected Tokio UDP fallback. Exact tuple metadata is unavailable on I/O errors;
//! those errors are counted independently and never attributed to the current peer.
use crate::budget::{Budget, Permit};
use bottleship_lan_native::{
    NativeError,
    udp::{UdpLosses, UdpStatus},
};
use bytes::Bytes;
use socket2::{Domain, Protocol, Socket, Type};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    net::UdpSocket,
    sync::{mpsc, oneshot, watch},
    time::timeout,
};
#[derive(Clone, Copy)]
struct Peer {
    epoch: u32,
    endpoint: SocketAddr,
    active: bool,
}
struct Completion {
    outcome: SendOutcome,
    _permit: Permit,
}
pub(crate) enum SendOutcome {
    Accepted,
    Refused(NativeError),
    Unattributed(NativeError),
}
pub(crate) struct PlainTicket {
    receiver: oneshot::Receiver<Completion>,
}
impl PlainTicket {
    pub async fn completion(self) -> SendOutcome {
        match self.receiver.await {
            Ok(c) => c.outcome,
            Err(_) => SendOutcome::Refused(NativeError::new(10050, "ordinary UDP writer stopped")),
        }
    }
}
struct Send {
    peer_id: u32,
    epoch: u32,
    bytes: Bytes,
    reply: oneshot::Sender<Completion>,
    permit: Permit,
}
pub(crate) struct PlainDatagram {
    pub peer_id: u32,
    pub epoch: u32,
    pub endpoint: SocketAddr,
    pub bytes: Bytes,
    _permit: Permit,
}
pub(crate) struct PlainEvents {
    pub datagrams: mpsc::Receiver<PlainDatagram>,
    pub losses: watch::Receiver<UdpLosses>,
}
struct Inner {
    commands: mpsc::Sender<Send>,
    tx: Arc<Budget>,
    peers: Arc<Mutex<HashMap<u32, Peer>>>,
    closing: watch::Sender<u8>,
    status: watch::Receiver<UdpStatus>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.tx.close();
        let _ = self.closing.send(2);
    }
}
#[derive(Clone)]
pub(crate) struct PlainUdp {
    inner: Arc<Inner>,
}
fn ambiguous(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::ConnectionReset
    ) || matches!(error.raw_os_error(), Some(111 | 10054 | 10061))
}
fn protocol_error() -> NativeError {
    NativeError::new(10022, "ordinary UDP peer identity refused")
}
impl PlainUdp {
    pub fn start(family: u8, close_timeout: Duration) -> Result<(Self, PlainEvents), NativeError> {
        if !matches!(family, 4 | 6) {
            return Err(protocol_error());
        }
        let socket = Socket::new(
            if family == 4 {
                Domain::IPV4
            } else {
                Domain::IPV6
            },
            Type::DGRAM,
            Some(Protocol::UDP),
        )
        .map_err(|e| NativeError::io(e, "ordinary UDP socket creation failed"))?;
        if family == 6 {
            socket
                .set_only_v6(false)
                .map_err(|e| NativeError::io(e, "ordinary UDP dual-stack setup failed"))?;
        }
        socket
            .set_nonblocking(true)
            .map_err(|e| NativeError::io(e, "ordinary UDP nonblocking setup failed"))?;
        let any = SocketAddr::new(
            if family == 4 {
                IpAddr::V4(Ipv4Addr::UNSPECIFIED)
            } else {
                IpAddr::V6(Ipv6Addr::UNSPECIFIED)
            },
            0,
        );
        socket
            .bind(&any.into())
            .map_err(|e| NativeError::io(e, "ordinary UDP bind failed"))?;
        let socket = Arc::new(
            UdpSocket::from_std(socket.into())
                .map_err(|e| NativeError::io(e, "ordinary UDP runtime registration failed"))?,
        );
        let bound = socket
            .local_addr()
            .map_err(|e| NativeError::io(e, "ordinary UDP local address failed"))?;
        let peers = Arc::new(Mutex::new(HashMap::<u32, Peer>::new()));
        let tx = Budget::new(256, 262144);
        let rx = Budget::new(256, 262144);
        let (commands, mut command_rx) = mpsc::channel::<Send>(256);
        let (datagrams, packet_rx) = mpsc::channel(256);
        let (closing, mut read_closing) = watch::channel(0u8);
        let mut write_closing = read_closing.clone();
        let (status, status_rx) = watch::channel(UdpStatus {
            bound: Some(bound),
            ..Default::default()
        });
        let (losses, loss_rx) = watch::channel(UdpLosses::default());
        let writer_losses = losses.clone();
        let reader_losses = losses;
        let writer_socket = socket.clone();
        let writer_peers = peers.clone();
        let cancel = closing.clone();
        let reader_cancel = closing.clone();
        let writer = tokio::spawn(async move {
            let mut graceful = false;
            loop {
                if *write_closing.borrow() == 2 {
                    break;
                }
                let command = tokio::select! {
                 changed=write_closing.changed()=>{if changed.is_err()||*write_closing.borrow()==2{break}graceful=true;command_rx.close();continue},
                 command=command_rx.recv()=>match command{Some(c)=>c,None=>break}
                };
                let peer = writer_peers
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&command.peer_id)
                    .copied()
                    .filter(|p| p.active && p.epoch == command.epoch);
                let outcome = if let Some(peer) = peer {
                    let send = async {
                        // A failed syscall has not accepted the datagram. Only one bounded retry of
                        // the same B is allowed after an unattributed pending A error; success is final.
                        let mut retried = false;
                        loop {
                            match writer_socket.send_to(&command.bytes, peer.endpoint).await {
                                Ok(size) if size == command.bytes.len() => {
                                    break SendOutcome::Accepted;
                                }
                                Ok(_) => {
                                    break SendOutcome::Refused(NativeError::new(
                                        10050,
                                        "partial ordinary UDP send",
                                    ));
                                }
                                Err(error) if ambiguous(&error) => {
                                    writer_losses.send_modify(|l| {
                                        l.unattributed_errors =
                                            l.unattributed_errors.saturating_add(1)
                                    });
                                    let failure =
                                        NativeError::io(error, "unattributed ordinary UDP error");
                                    if retried {
                                        break SendOutcome::Unattributed(failure);
                                    }
                                    retried = true;
                                }
                                Err(error) => {
                                    break SendOutcome::Refused(NativeError::io(
                                        error,
                                        "ordinary UDP send refused",
                                    ));
                                }
                            }
                        }
                    };
                    let mut send = Box::pin(send);
                    tokio::select! {biased;_=write_closing.changed()=>{
                     if *write_closing.borrow()==2{SendOutcome::Refused(NativeError::new(10004,"ordinary UDP send aborted"))}
                     else{graceful=true;command_rx.close();match timeout(close_timeout,send.as_mut()).await{Ok(outcome)=>outcome,Err(_)=>{let _=cancel.send(2);SendOutcome::Refused(NativeError::new(10060,"ordinary UDP send timed out"))}}}
                    },outcome=send.as_mut()=>outcome}
                } else {
                    SendOutcome::Refused(NativeError::new(
                        10013,
                        "ordinary UDP tuple is not permitted",
                    ))
                };
                let _ = command.reply.send(Completion {
                    outcome,
                    _permit: command.permit,
                });
                if graceful && command_rx.is_empty() {
                    break;
                }
            }
            command_rx.close();
            while let Some(c) = command_rx.recv().await {
                let _ = c.reply.send(Completion {
                    outcome: SendOutcome::Refused(NativeError::new(
                        10004,
                        "ordinary UDP send cancelled",
                    )),
                    _permit: c.permit,
                });
            }
        });
        let reader_socket = socket.clone();
        let reader_peers = peers.clone();
        let reader = tokio::spawn(async move {
            let mut buffer = [0u8; 65536];
            loop {
                if *read_closing.borrow() != 0 {
                    break;
                }
                let received = tokio::select! {_=read_closing.changed()=>break,result=reader_socket.recv_from(&mut buffer)=>result};
                match received {
                    Ok((size, endpoint)) => {
                        let peer = reader_peers
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .iter()
                            .find(|(_, p)| p.active && p.endpoint == endpoint)
                            .map(|(id, p)| (*id, *p));
                        let Some((peer_id, peer)) = peer else {
                            continue;
                        };
                        let max = if family == 4 { 65507 } else { 65527 };
                        let permit = if size <= max {
                            rx.reserve(size).ok()
                        } else {
                            None
                        };
                        if let Some(permit) = permit {
                            let datagram = PlainDatagram {
                                peer_id,
                                epoch: peer.epoch,
                                endpoint,
                                bytes: Bytes::copy_from_slice(&buffer[..size]),
                                _permit: permit,
                            };
                            if datagrams.try_send(datagram).is_ok() {
                                continue;
                            }
                        }
                        reader_losses.send_modify(|l| {
                            l.rx_packets = l.rx_packets.saturating_add(1);
                            l.rx_bytes = l.rx_bytes.saturating_add(size as u64);
                        });
                    }
                    Err(error) => {
                        if ambiguous(&error) {
                            reader_losses.send_modify(|l| {
                                l.unattributed_errors = l.unattributed_errors.saturating_add(1)
                            });
                            continue;
                        }
                        let _ = reader_cancel.send(2);
                        return Some(NativeError::io(error, "ordinary UDP receive failed"));
                    }
                }
            }
            None
        });
        let mut coordinator_closing = closing.subscribe();
        let timeout_cancel = closing.clone();
        let writer_budget = tx.clone();
        tokio::spawn(async move {
            // No lifetime timeout. A deadline begins only when an explicit close starts.
            let mut writer = writer;
            let mut reader = reader;
            tokio::select! {
             result=&mut writer=>{let _=timeout_cancel.send(2);let read=reader.await;drop(socket);writer_budget.close();status.send_modify(|s|{s.closed=true;s.closing=true;s.error=read.ok().flatten().or_else(||result.err().map(|_|NativeError::new(10050,"ordinary UDP writer panicked")));});return},
             changed=coordinator_closing.changed()=>{if changed.is_err(){let _=timeout_cancel.send(2);}}
            }
            status.send_modify(|s| s.closing = true);
            let result = timeout(close_timeout, async {
                let a = (&mut writer).await;
                let b = (&mut reader).await;
                (a, b)
            })
            .await;
            let error = match result {
                Ok((_, result)) => result.ok().flatten(),
                Err(_) => {
                    let _ = timeout_cancel.send(2);
                    writer.abort();
                    reader.abort();
                    let _ = writer.await;
                    let _ = reader.await;
                    Some(NativeError::new(10060, "ordinary UDP close timed out"))
                }
            };
            drop(socket);
            writer_budget.close();
            status.send_modify(|s| {
                s.closed = true;
                s.closing = true;
                s.error = error;
            });
        });
        let handle = Self {
            inner: Arc::new(Inner {
                commands,
                tx,
                peers,
                closing,
                status: status_rx,
            }),
        };
        Ok((
            handle,
            PlainEvents {
                datagrams: packet_rx,
                losses: loss_rx,
            },
        ))
    }
    pub fn subscribe(&self) -> watch::Receiver<UdpStatus> {
        self.inner.status.clone()
    }
    pub fn status(&self) -> UdpStatus {
        self.inner.status.borrow().clone()
    }
    pub async fn when_ready(&self) -> Result<SocketAddr, NativeError> {
        self.status().bound.ok_or_else(protocol_error)
    }
    pub async fn register_peer(
        &self,
        peer_id: u32,
        epoch: u32,
        endpoint: SocketAddr,
    ) -> Result<(), NativeError> {
        if peer_id == 0 || epoch == 0 || endpoint.port() == 0 {
            return Err(protocol_error());
        }
        let mut peers = self.inner.peers.lock().unwrap_or_else(|e| e.into_inner());
        if peers.len() >= 128 && !peers.contains_key(&peer_id) {
            return Err(NativeError::new(10055, "ordinary UDP peer history full"));
        }
        if peers
            .get(&peer_id)
            .is_some_and(|p| epoch <= p.epoch || p.endpoint != endpoint)
            || peers
                .iter()
                .any(|(id, p)| *id != peer_id && p.endpoint == endpoint)
        {
            return Err(protocol_error());
        }
        peers.insert(
            peer_id,
            Peer {
                epoch,
                endpoint,
                active: true,
            },
        );
        Ok(())
    }
    pub async fn retire_peer(&self, peer_id: u32, epoch: u32) -> Result<(), NativeError> {
        if let Some(peer) = self
            .inner
            .peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(&peer_id)
        {
            if peer.epoch == epoch {
                peer.active = false;
            }
        }
        Ok(())
    }
    pub fn try_send(
        &self,
        peer_id: u32,
        epoch: u32,
        payload: &[u8],
    ) -> Result<PlainTicket, NativeError> {
        if payload.len() > 65527 {
            return Err(NativeError::new(10040, "ordinary UDP payload too large"));
        }
        let permit = self.inner.tx.reserve(payload.len())?;
        let slot = self
            .inner
            .commands
            .try_reserve()
            .map_err(|_| NativeError::new(10055, "ordinary UDP send queue full"))?;
        let (reply, receiver) = oneshot::channel();
        slot.send(Send {
            peer_id,
            epoch,
            bytes: Bytes::copy_from_slice(payload),
            reply,
            permit,
        });
        Ok(PlainTicket { receiver })
    }
    pub fn abort(&self) {
        self.inner.tx.close();
        let _ = self.inner.closing.send(2);
    }
    pub async fn close(&self) -> Result<(), NativeError> {
        self.inner.tx.close();
        self.inner.closing.send_modify(|s| *s = (*s).max(1));
        self.wait_closed().await
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
                .map_err(|_| NativeError::new(10050, "ordinary UDP coordinator ended"))?;
        }
    }
}
