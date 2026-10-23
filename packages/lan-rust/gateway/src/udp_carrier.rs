use crate::plain_udp::{PlainTicket, PlainUdp, SendOutcome};
use bottleship_lan_native::{
    NativeError,
    udp::{BoundUdp, UdpLosses, UdpOptions, UdpPeerError, UdpStatus},
};
use bytes::Bytes;
use std::{net::SocketAddr, path::Path, sync::Arc, time::Duration};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};
pub(crate) struct Datagram {
    pub peer_id: u32,
    pub epoch: u32,
    pub endpoint: SocketAddr,
    pub bytes: Bytes,
    _guard: Box<dyn Send>,
}
pub(crate) struct Events {
    pub datagrams: mpsc::Receiver<Datagram>,
    pub errors: mpsc::Receiver<UdpPeerError>,
    pub losses: watch::Receiver<UdpLosses>,
}
enum Socket {
    Helper(BoundUdp),
    Plain(PlainUdp),
}
struct Inner {
    socket: Socket,
    bridge: JoinHandle<()>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        match &self.socket {
            Socket::Helper(h) => h.abort(),
            Socket::Plain(h) => h.abort(),
        }
        self.bridge.abort();
    }
}
#[derive(Clone)]
pub(crate) struct Carrier {
    inner: Arc<Inner>,
}
pub(crate) enum Ticket {
    Helper(bottleship_lan_native::udp::SendTicket),
    Plain(PlainTicket),
}
impl Ticket {
    pub async fn completion(self) -> SendOutcome {
        match self {
            Self::Helper(t) => match t.completion().await {
                Ok(()) => SendOutcome::Accepted,
                Err(e) => SendOutcome::Refused(e),
            },
            Self::Plain(t) => t.completion().await,
        }
    }
}
pub(crate) fn helper_supported(endpoint: SocketAddr) -> bool {
    match endpoint {
        SocketAddr::V4(v) => v.ip().octets()[0] < 224,
        SocketAddr::V6(v) => {
            v.scope_id() == 0
                && !v.ip().is_multicast()
                && !v.ip().is_unicast_link_local()
                && v.ip().to_ipv4_mapped().is_none()
        }
    }
}
impl Carrier {
    pub fn is_helper(&self) -> bool {
        matches!(&self.inner.socket, Socket::Helper(_))
    }
    pub fn start(
        helper: Option<&Path>,
        family: u8,
        timeout: Duration,
    ) -> Result<(Self, Events), NativeError> {
        let (datagrams, rx) = mpsc::channel(256);
        let (errors, error_rx) = mpsc::channel(32);
        if let Some(path) = helper {
            let (handle, mut native) = BoundUdp::start(
                path,
                family,
                UdpOptions {
                    operation_timeout: timeout,
                    close_timeout: timeout,
                },
            )?;
            let losses = native.losses.clone();
            let mut status = handle.subscribe();
            let bridge = tokio::spawn(async move {
                let mut reads = true;
                let mut errs = true;
                loop {
                    tokio::select! {
                     value=native.datagrams.recv(),if reads=>match value{Some(d)=>{
                      let packet=Datagram{peer_id:d.peer_id,epoch:d.epoch,endpoint:d.endpoint,bytes:d.bytes.clone(),_guard:Box::new(d)};
                      if datagrams.send(packet).await.is_err(){break}
                     },None=>reads=false},
                     value=native.errors.recv(),if errs=>match value{Some(e)=>if errors.send(e).await.is_err(){break},None=>errs=false},
                     changed=status.changed()=>{if changed.is_err()||status.borrow().closed{break}}
                    }
                }
            });
            Ok((
                Self {
                    inner: Arc::new(Inner {
                        socket: Socket::Helper(handle),
                        bridge,
                    }),
                },
                Events {
                    datagrams: rx,
                    errors: error_rx,
                    losses,
                },
            ))
        } else {
            let (handle, mut native) = PlainUdp::start(family, timeout)?;
            let losses = native.losses.clone();
            let mut status = handle.subscribe();
            drop(errors);
            let bridge = tokio::spawn(async move {
                loop {
                    tokio::select! {
                     value=native.datagrams.recv()=>match value{Some(d)=>{
                      let packet=Datagram{peer_id:d.peer_id,epoch:d.epoch,endpoint:d.endpoint,bytes:d.bytes.clone(),_guard:Box::new(d)};
                      if datagrams.send(packet).await.is_err(){break}
                     },None=>break},
                     changed=status.changed()=>{if changed.is_err()||status.borrow().closed{break}}
                    }
                }
            });
            Ok((
                Self {
                    inner: Arc::new(Inner {
                        socket: Socket::Plain(handle),
                        bridge,
                    }),
                },
                Events {
                    datagrams: rx,
                    errors: error_rx,
                    losses,
                },
            ))
        }
    }
    pub fn status(&self) -> UdpStatus {
        match &self.inner.socket {
            Socket::Helper(h) => h.status(),
            Socket::Plain(h) => h.status(),
        }
    }
    pub async fn when_ready(&self) -> Result<SocketAddr, NativeError> {
        match &self.inner.socket {
            Socket::Helper(h) => h.when_ready().await,
            Socket::Plain(h) => h.when_ready().await,
        }
    }
    pub async fn register_peer(
        &self,
        id: u32,
        epoch: u32,
        endpoint: SocketAddr,
    ) -> Result<(), NativeError> {
        match &self.inner.socket {
            Socket::Helper(h) => h.register_peer(id, epoch, endpoint).await,
            Socket::Plain(h) => h.register_peer(id, epoch, endpoint).await,
        }
    }
    pub async fn retire_peer(&self, id: u32, epoch: u32) -> Result<(), NativeError> {
        match &self.inner.socket {
            Socket::Helper(h) => h.retire_peer(id, epoch).await,
            Socket::Plain(h) => h.retire_peer(id, epoch).await,
        }
    }
    pub fn try_send(&self, id: u32, epoch: u32, payload: &[u8]) -> Result<Ticket, NativeError> {
        match &self.inner.socket {
            Socket::Helper(h) => h.try_send(id, epoch, payload).map(Ticket::Helper),
            Socket::Plain(h) => h.try_send(id, epoch, payload).map(Ticket::Plain),
        }
    }
    pub fn abort(&self) {
        match &self.inner.socket {
            Socket::Helper(h) => h.abort(),
            Socket::Plain(h) => h.abort(),
        }
    }
    pub async fn close(&self) -> Result<(), NativeError> {
        match &self.inner.socket {
            Socket::Helper(h) => h.close().await,
            Socket::Plain(h) => h.close().await,
        }
    }
    pub async fn wait_closed(&self) -> Result<(), NativeError> {
        match &self.inner.socket {
            Socket::Helper(h) => h.wait_closed().await,
            Socket::Plain(h) => h.wait_closed().await,
        }
    }
}
