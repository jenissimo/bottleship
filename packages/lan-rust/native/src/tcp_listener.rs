//! Bounded physical IPv4 TCP listener. Accepted streams transfer to the caller;
//! closing the listener drops queued streams, but does not close transferred ones.
use crate::{NativeError, tcp_quota::{TcpQuota, TcpQuotaPermit}};
use std::{
    collections::VecDeque,
    future::poll_fn,
    task::Poll,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::watch,
    time::timeout,
};

static NEXT_EPOCH: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
pub struct TcpListenerConfig {
    pub bind: SocketAddrV4,
    pub advertised_ip: Ipv4Addr,
    pub allowed_hosts: Vec<Ipv4Addr>,
    pub max_pending: usize,
    pub startup_timeout: Duration,
}
impl Default for TcpListenerConfig {
    fn default() -> Self {
        Self {
            bind: SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0),
            advertised_ip: Ipv4Addr::LOCALHOST,
            allowed_hosts: vec![Ipv4Addr::LOCALHOST],
            max_pending: 64,
            startup_timeout: Duration::from_secs(5),
        }
    }
}
fn unicast(ip: Ipv4Addr) -> bool {
    !ip.is_unspecified() && !ip.is_multicast() && !ip.is_broadcast()
}
impl TcpListenerConfig {
    fn validate(&self) -> Result<(), NativeError> {
        if (!self.bind.ip().is_unspecified() && !unicast(*self.bind.ip()))
            || !unicast(self.advertised_ip)
            || self.allowed_hosts.is_empty()
            || self.allowed_hosts.len() > 32
            || self.allowed_hosts.iter().any(|ip| !unicast(*ip))
            || self.allowed_hosts.iter().enumerate().any(|(i, ip)| self.allowed_hosts[..i].contains(ip))
            || !(1..=1024).contains(&self.max_pending)
            || !(Duration::from_millis(1)..=Duration::from_secs(120)).contains(&self.startup_timeout)
        {
            return Err(NativeError::new(10022, "invalid native TCP listener configuration"));
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TcpListenerReady {
    pub bound: SocketAddrV4,
    pub advertised: SocketAddrV4,
}
#[derive(Clone, Debug, Default)]
pub struct TcpListenerStatus {
    pub ready: Option<TcpListenerReady>,
    pub closed: bool,
    pub error: Option<NativeError>,
    pub pending: usize,
    pub admitted: u64,
    pub refused_acl: u64,
    pub refused_full: u64,
}
/// Once returned by accept(), stream ownership is independent of this listener.
pub struct AcceptedTcp {
    pub epoch: u64,
    pub id: u64,
    pub peer: SocketAddrV4,
    pub stream: TcpStream,
    /// Optional shared quota, transferred with the accepted physical socket.
    pub permit: Option<TcpQuotaPermit>,
}
struct State {
    admitting: bool,
    next_id: u64,
    queue: VecDeque<AcceptedTcp>,
}
struct Shared {
    state: Mutex<State>,
    status: watch::Sender<TcpListenerStatus>,
}
impl Shared {
    fn stop(&self) {
        let mut state = self.state.lock().unwrap();
        state.admitting = false;
        state.queue.clear();
        self.status.send_modify(|status| status.pending = 0);
    }
}
struct Control {
    shared: Arc<Shared>,
    stop: watch::Sender<bool>,
    status: watch::Receiver<TcpListenerStatus>,
}
impl Drop for Control {
    fn drop(&mut self) {
        self.shared.stop();
        let _ = self.stop.send(true);
    }
}
#[derive(Clone)]
pub struct NativeTcpListener {
    inner: Arc<Control>,
}
struct Driver {
    shared: Arc<Shared>,
    socket: Option<TcpListener>,
}
impl Drop for Driver {
    fn drop(&mut self) {
        // Publish closed only after dropping the physical listener and queued sockets.
        self.socket.take();
        self.shared.stop();
        self.shared.status.send_modify(|status| status.closed = true);
    }
}
impl NativeTcpListener {
    pub fn start(config: TcpListenerConfig) -> Result<Self, NativeError> {
        Self::start_inner(config, None)
    }
    pub fn start_with_quota(config: TcpListenerConfig, quota: Arc<TcpQuota>) -> Result<Self, NativeError> {
        Self::start_inner(config, Some(quota))
    }
    fn start_inner(config: TcpListenerConfig, quota: Option<Arc<TcpQuota>>) -> Result<Self, NativeError> {
        config.validate()?;
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| NativeError::new(10050, "native TCP listener needs an async runtime"))?;
        let epoch = NEXT_EPOCH.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .map_err(|_| NativeError::new(10055, "native TCP listener epochs exhausted"))?;
        let (status, receiver) = watch::channel(TcpListenerStatus::default());
        let (stop, stopping) = watch::channel(false);
        let shared = Arc::new(Shared {
            state: Mutex::new(State { admitting: true, next_id: 1, queue: VecDeque::new() }),
            status,
        });
        // The guard is created before spawn, including if the task is never polled.
        let driver = Driver { shared: shared.clone(), socket: None };
        runtime.spawn(run(driver, config, epoch, stopping, quota));
        Ok(Self { inner: Arc::new(Control { shared, stop, status: receiver }) })
    }
    pub fn subscribe(&self) -> watch::Receiver<TcpListenerStatus> {
        self.inner.status.clone()
    }
    pub fn status(&self) -> TcpListenerStatus {
        self.inner.status.borrow().clone()
    }
    pub async fn when_ready(&self) -> Result<TcpListenerReady, NativeError> {
        let mut status = self.subscribe();
        loop {
            let current = status.borrow_and_update().clone();
            if current.closed {
                return Err(current.error.unwrap_or_else(|| NativeError::new(995, "TCP listener closed before readiness")));
            }
            if let Some(ready) = current.ready {
                if !self.inner.shared.state.lock().unwrap().admitting {
                    return Err(NativeError::new(995, "TCP listener readiness cancelled"));
                }
                return Ok(ready);
            }
            status.changed().await.map_err(|_| NativeError::new(10050, "TCP listener driver stopped"))?;
        }
    }
    pub async fn accept(&self) -> Result<AcceptedTcp, NativeError> {
        let mut status = self.subscribe();
        loop {
            status.borrow_and_update();
            {
                let mut state = self.inner.shared.state.lock().unwrap();
                if !state.admitting {
                    return Err(NativeError::new(995, "TCP listener is closing"));
                }
                if let Some(stream) = state.queue.pop_front() {
                    self.inner.shared.status.send_modify(|status| status.pending = state.queue.len());
                    return Ok(stream);
                }
            }
            status.changed().await.map_err(|_| NativeError::new(10050, "TCP listener driver stopped"))?;
        }
    }
    pub fn abort(&self) {
        self.inner.shared.stop();
        let _ = self.inner.stop.send(true);
    }
    pub async fn wait_closed(&self) -> Result<(), NativeError> {
        let mut status = self.subscribe();
        loop {
            let current = status.borrow_and_update().clone();
            if current.closed { return current.error.map_or(Ok(()), Err); }
            status.changed().await.map_err(|_| NativeError::new(10050, "TCP listener retirement observer stopped"))?;
        }
    }
}
// A pending accept never retains a permit: idle listeners cannot starve
// outbound connects or other listeners. Both the quota and poll_accept
// register the actor's waker before returning Pending.
async fn accept_with_quota(listener: &TcpListener, quota: Option<Arc<TcpQuota>>) -> std::io::Result<(TcpStream, SocketAddr, Option<TcpQuotaPermit>)> {
    let Some(quota) = quota else {
        let (stream, peer) = listener.accept().await?;
        return Ok((stream, peer, None));
    };
    let waiter = quota.waiter().ok_or_else(|| std::io::Error::other("TCP quota closed"))?;
    poll_fn(move |cx| match waiter.poll_accept(cx, |cx| listener.poll_accept(cx)) {
        Poll::Ready(Ok(((stream, peer), permit))) => Poll::Ready(Ok((stream, peer, Some(permit)))),
        Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
        Poll::Pending => Poll::Pending,
    }).await
}
async fn run(mut driver: Driver, config: TcpListenerConfig, epoch: u64, mut stop: watch::Receiver<bool>, quota: Option<Arc<TcpQuota>>) {
    let bound = tokio::select! {
        biased;
        _ = stop.changed() => return,
        result = timeout(config.startup_timeout, TcpListener::bind(SocketAddr::V4(config.bind))) => result,
    };
    let listener = match bound {
        Ok(Ok(listener)) => listener,
        Ok(Err(error)) => {
            driver.shared.status.send_modify(|status| status.error = Some(NativeError::io(error, "native TCP listener bind failed")));
            return;
        }
        Err(_) => {
            driver.shared.status.send_modify(|status| status.error = Some(NativeError::new(10060, "native TCP listener bind timed out")));
            return;
        }
    };
    let address = match listener.local_addr() {
        Ok(SocketAddr::V4(address)) => address,
        _ => {
            driver.shared.status.send_modify(|status| status.error = Some(NativeError::new(10049, "invalid TCP listener bound address")));
            return;
        }
    };
    driver.socket = Some(listener);
    {
        let state = driver.shared.state.lock().unwrap();
        if !state.admitting { return; }
        let ready = TcpListenerReady { bound: address, advertised: SocketAddrV4::new(config.advertised_ip, address.port()) };
        driver.shared.status.send_modify(|status| status.ready = Some(ready));
    }
    loop {
        let accepted = tokio::select! {
            biased;
            _ = stop.changed() => break,
            result = accept_with_quota(driver.socket.as_ref().unwrap(), quota.clone()) => result,
        };
        let (stream, peer, permit) = match accepted {
            Ok((stream, SocketAddr::V4(peer), permit)) => (stream, peer, permit),
            Ok((_stream, _, _)) => { driver.shared.status.send_modify(|status| status.refused_acl = status.refused_acl.saturating_add(1)); continue; }
            Err(error) => {
                driver.shared.status.send_modify(|status| status.error = Some(NativeError::io(error, "native TCP accept failed")));
                break;
            }
        };
        let mut state = driver.shared.state.lock().unwrap();
        if !state.admitting { drop(stream); break; }
        if !config.allowed_hosts.contains(peer.ip()) {
            driver.shared.status.send_modify(|status| status.refused_acl = status.refused_acl.saturating_add(1));
            continue;
        }
        if state.queue.len() >= config.max_pending || state.next_id == u64::MAX {
            driver.shared.status.send_modify(|status| status.refused_full = status.refused_full.saturating_add(1));
            continue;
        }
        let id = state.next_id;
        state.next_id += 1;
        state.queue.push_back(AcceptedTcp { epoch, id, peer, stream, permit });
        driver.shared.status.send_modify(|status| {
            status.pending = state.queue.len();
            status.admitted = status.admitted.saturating_add(1);
        });
    }
}
