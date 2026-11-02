//! Internal, bounded ownership of accepted TCP sockets until guest SYNACK.
//! This is not exposed as a LAN capability; the caller must own the physical
//! listener lease and enforce its source policy before calling admit().
use bottleship_lan_core::{
    gateway::BindingToken,
    wire::{Datagram, Node, TCP_WINDOW, TcpFrame},
};
use bottleship_lan_native::{NativeError, tcp_listener::AcceptedTcp};
use bytes::Bytes;
use std::{
    collections::HashMap,
    sync::{Arc, atomic::{AtomicU32, Ordering}},
    time::Duration,
};
use tokio::{net::TcpStream, time::Instant};

/// Shared with outbound flows: ids never wrap or get reused in this pool.
#[derive(Default)]
pub(crate) struct TcpIds(AtomicU32);
impl TcpIds {
    pub fn next(&self) -> Result<u32, NativeError> {
        self.0.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map(|id| id + 1)
            .map_err(|_| NativeError::new(10055, "TCP flow identity exhausted"))
    }
}
struct Pending {
    binding: BindingToken,
    listener_epoch: u64,
    peer_node: Node,
    peer_port: u16,
    stream: TcpStream,
    permit: Option<bottleship_lan_native::tcp_quota::TcpQuotaPermit>,
    deadline: Instant,
}
/// Established transport owner. Caller must admit it to the real TCP pool or
/// drop it; dropping closes the original stream.
pub(crate) struct AcceptedFlow {
    pub binding: BindingToken,
    pub listener_epoch: u64,
    pub peer_node: Node,
    pub peer_port: u16,
    pub native_id: u32,
    pub guest_id: u32,
    pub guest_credit: u32,
    pub guest_options: u32,
    pub stream: TcpStream,
    pub permit: Option<bottleship_lan_native::tcp_quota::TcpQuotaPermit>,
}
pub(crate) struct PendingTcpAccepts {
    ids: Arc<TcpIds>,
    limit: usize,
    timeout: Duration,
    pending: HashMap<u32, Pending>,
}
impl PendingTcpAccepts {
    pub fn new(ids: Arc<TcpIds>, limit: usize, timeout: Duration) -> Self {
        Self { ids, limit, timeout, pending: HashMap::new() }
    }
    /// Accept consumes the socket on success and failure; a refused stream is closed.
    pub fn admit(&mut self, accepted: AcceptedTcp, binding: BindingToken) -> Result<Datagram, NativeError> {
        self.sweep();
        if binding.proto != 2 || binding.local_port == 0 || binding.generation.is_none_or(|g| g == 0)
            || accepted.epoch == 0 || accepted.id == 0 || accepted.peer.port() == 0 {
            return Err(NativeError::new(10022, "invalid inbound TCP identity"));
        }
        if self.pending.len() >= self.limit {
            return Err(NativeError::new(10055, "inbound TCP pending limit reached"));
        }
        let native_id = self.ids.next()?;
        let ip = accepted.peer.ip().octets();
        let node = [2, 1, ip[0], ip[1], ip[2], ip[3]];
        let port = accepted.peer.port();
        self.pending.insert(native_id, Pending {
            binding, listener_epoch: accepted.epoch, peer_node: node, peer_port: port,
            stream: accepted.stream, permit: accepted.permit, deadline: Instant::now() + self.timeout,
        });
        Ok(Datagram {
            proto: 2, node, dst_port: binding.local_port, src_port: port,
            payload: TcpFrame { kind: 1, src_id: native_id, dst_id: 0, value: TCP_WINDOW, data: Bytes::new() }.encode(),
        })
    }
    /// Match only the original binding/epoch/peer/id. Invalid packets do not
    /// consume or mutate a pending socket; an expired one is closed.
    pub fn synack(&mut self, binding: BindingToken, listener_epoch: u64, datagram: &Datagram) -> Option<AcceptedFlow> {
        let frame = TcpFrame::decode(datagram.payload.clone()).ok()?;
        if frame.kind != 2 || frame.src_id == 0 || frame.dst_id == 0 || !frame.data.is_empty() { return None; }
        let pending = self.pending.get(&frame.dst_id)?;
        if pending.deadline <= Instant::now() {
            self.pending.remove(&frame.dst_id);
            return None;
        }
        if pending.binding != binding || pending.listener_epoch != listener_epoch || datagram.proto != 2
            || datagram.src_port != binding.local_port || datagram.dst_port != pending.peer_port
            || datagram.node != pending.peer_node { return None; }
        let pending = self.pending.remove(&frame.dst_id)?;
        Some(AcceptedFlow {
            binding, listener_epoch, peer_node: pending.peer_node, peer_port: pending.peer_port,
            native_id: frame.dst_id, guest_id: frame.src_id, guest_credit: (frame.value & 0x1fffffff).min(TCP_WINDOW),
            guest_options: frame.value & 0xe0000000, stream: pending.stream, permit: pending.permit,
        })
    }
    /// Retire only the socket addressed by a guest RST for this exact listener
    /// and peer. The guest id is not known until a SYNACK has been accepted.
    pub fn reset(&mut self, binding: BindingToken, listener_epoch: u64, datagram: &Datagram) -> bool {
        let Ok(frame) = TcpFrame::decode(datagram.payload.clone()) else { return false; };
        if frame.kind != 5 || frame.dst_id == 0 || !frame.data.is_empty() { return false; }
        let Some(pending) = self.pending.get(&frame.dst_id) else { return false; };
        if pending.binding != binding || pending.listener_epoch != listener_epoch || datagram.proto != 2
            || datagram.src_port != binding.local_port || datagram.dst_port != pending.peer_port
            || datagram.node != pending.peer_node { return false; }
        self.pending.remove(&frame.dst_id);
        true
    }
    pub fn cancel_listener(&mut self, binding: BindingToken, epoch: u64) {
        self.pending.retain(|_, pending| pending.binding != binding || pending.listener_epoch != epoch);
    }
    pub fn release_port(&mut self, proto: u8, port: u16, generation: u32) {
        self.pending.retain(|_, pending| !(pending.binding.proto == proto && pending.binding.local_port == port
            && pending.binding.generation.is_some_and(|g| g <= generation)));
    }
    pub fn sweep(&mut self) {
        let now = Instant::now();
        self.pending.retain(|_, pending| pending.deadline > now);
    }
    pub fn clear(&mut self) { self.pending.clear(); }
    pub fn cancel(&mut self, native_id: u32) -> bool { self.pending.remove(&native_id).is_some() }
    pub fn contains(&self, native_id: u32) -> bool { self.pending.contains_key(&native_id) }
    pub fn len(&self) -> usize { self.pending.len() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bottleship_lan_native::{
        tcp::{NativeTcp, TcpOptions},
        tcp_listener::{NativeTcpListener, TcpListenerConfig},
    };
    use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpStream, time::timeout};

    fn binding(generation: u32) -> BindingToken {
        BindingToken { proto: 2, local_port: 2310, generation: Some(generation) }
    }
    async fn incoming(listener: &NativeTcpListener) -> (TcpStream, AcceptedTcp) {
        let ready = timeout(Duration::from_secs(2), listener.when_ready()).await.unwrap().unwrap();
        let peer = timeout(Duration::from_secs(2), TcpStream::connect(std::net::SocketAddr::V4(ready.bound))).await.unwrap().unwrap();
        let accepted = timeout(Duration::from_secs(2), listener.accept()).await.unwrap().unwrap();
        (peer, accepted)
    }
    fn answer(syn: &Datagram, guest_id: u32) -> Datagram {
        let request = TcpFrame::decode(syn.payload.clone()).unwrap();
        Datagram {
            proto: syn.proto, node: syn.node, src_port: syn.dst_port, dst_port: syn.src_port,
            payload: TcpFrame { kind: 2, src_id: guest_id, dst_id: request.src_id, value: 4096, data: Bytes::new() }.encode(),
        }
    }
    #[tokio::test]
    async fn pending_identity_fences_synack_and_transfers_the_original_stream() {
        let listener = NativeTcpListener::start(TcpListenerConfig::default()).unwrap();
        let ids = Arc::new(TcpIds::default());
        assert_eq!(ids.next().unwrap(), 1);
        let mut pending = PendingTcpAccepts::new(ids, 2, Duration::from_secs(2));
        let (mut peer, accepted) = incoming(&listener).await;
        let epoch = accepted.epoch;
        let syn = pending.admit(accepted, binding(4)).unwrap();
        let request = TcpFrame::decode(syn.payload.clone()).unwrap();
        assert_eq!((request.kind, request.src_id, request.dst_id), (1, 2, 0));
        assert_eq!(request.value, TCP_WINDOW);
        let valid = answer(&syn, 33);
        assert!(pending.synack(binding(5), epoch, &valid).is_none());
        assert!(pending.synack(binding(4), epoch + 1, &valid).is_none());
        let mut forged = valid.clone(); forged.dst_port ^= 1;
        assert!(pending.synack(binding(4), epoch, &forged).is_none());
        assert_eq!(pending.len(), 1);
        peer.write_all(b"already-sent").await.unwrap();
        let flow = pending.synack(binding(4), epoch, &valid).unwrap();
        assert_eq!((flow.native_id, flow.guest_id, flow.guest_credit), (2, 33, 4096));
        assert_eq!(flow.peer_node, syn.node);
        assert_eq!(flow.peer_port, syn.src_port);
        assert_eq!(flow.binding, binding(4));
        assert_eq!(flow.listener_epoch, epoch);
        assert!(pending.synack(binding(4), epoch, &valid).is_none());
        let (actor, mut events) = NativeTcp::from_accepted(flow.stream, TcpOptions::default()).unwrap();
        let mut got = Vec::new();
        while got.len() < b"already-sent".len() {
            let packet = timeout(Duration::from_secs(2), events.reads.recv()).await.unwrap().unwrap();
            got.extend_from_slice(packet.data().unwrap());
        }
        assert_eq!(got, b"already-sent");
        actor.abort();
        timeout(Duration::from_secs(2), actor.wait_closed()).await.unwrap().unwrap();
        listener.abort();
        timeout(Duration::from_secs(2), listener.wait_closed()).await.unwrap().unwrap();
    }
    #[tokio::test]
    async fn reset_closes_only_the_exact_pending_listener_peer_and_id() {
        let listener = NativeTcpListener::start(TcpListenerConfig::default()).unwrap();
        let mut pending = PendingTcpAccepts::new(Arc::new(TcpIds::default()), 2, Duration::from_secs(2));
        let (mut peer, accepted) = incoming(&listener).await;
        let epoch = accepted.epoch;
        let syn = pending.admit(accepted, binding(4)).unwrap();
        let id = TcpFrame::decode(syn.payload.clone()).unwrap().src_id;
        let reset = Datagram { proto: 2, node: syn.node, src_port: syn.dst_port, dst_port: syn.src_port,
            payload: TcpFrame { kind: 5, src_id: 0, dst_id: id, value: 10054, data: Bytes::new() }.encode() };
        assert!(!pending.reset(binding(5), epoch, &reset));
        assert!(!pending.reset(binding(4), epoch + 1, &reset));
        let mut forged = reset.clone(); forged.dst_port ^= 1;
        assert!(!pending.reset(binding(4), epoch, &forged));
        assert_eq!(pending.len(), 1);
        assert!(pending.reset(binding(4), epoch, &reset));
        assert!(!pending.reset(binding(4), epoch, &reset));
        let mut byte = [0; 1];
        assert!(matches!(timeout(Duration::from_secs(2), peer.read(&mut byte)).await.unwrap(), Ok(0) | Err(_)));
        listener.abort();
        timeout(Duration::from_secs(2), listener.wait_closed()).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn capacity_listener_cancel_and_expiry_close_only_owned_pending_sockets() {
        let listener = NativeTcpListener::start(TcpListenerConfig::default()).unwrap();
        let mut pending = PendingTcpAccepts::new(Arc::new(TcpIds::default()), 1, Duration::from_millis(30));
        let (mut first, a) = incoming(&listener).await;
        let epoch = a.epoch;
        let syn = pending.admit(a, binding(8)).unwrap();
        let (mut refused, b) = incoming(&listener).await;
        assert_eq!(pending.admit(b, binding(8)).unwrap_err().code, 10055);
        let mut byte = [0; 1];
        let result = timeout(Duration::from_secs(2), refused.read(&mut byte)).await.unwrap();
        assert!(matches!(result, Ok(0) | Err(_)));
        pending.cancel_listener(binding(8), epoch + 1);
        assert_eq!(pending.len(), 1);
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(pending.synack(binding(8), epoch, &answer(&syn, 9)).is_none());
        assert_eq!(pending.len(), 0);
        let result = timeout(Duration::from_secs(2), first.read(&mut byte)).await.unwrap();
        assert!(matches!(result, Ok(0) | Err(_)));

        let (mut retired, c) = incoming(&listener).await;
        pending.admit(c, binding(9)).unwrap();
        pending.release_port(2, 2310, 8);
        assert_eq!(pending.len(), 1);
        pending.release_port(2, 2310, 9);
        assert_eq!(pending.len(), 0);
        let result = timeout(Duration::from_secs(2), retired.read(&mut byte)).await.unwrap();
        assert!(matches!(result, Ok(0) | Err(_)));
        listener.abort();
        timeout(Duration::from_secs(2), listener.wait_closed()).await.unwrap().unwrap();
    }
}

