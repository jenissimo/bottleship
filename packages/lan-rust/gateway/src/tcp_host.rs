//! TCP listener owners. Not exposed until Core enables the listener protocol.
use crate::Internal;
use bottleship_lan_core::{
    ConnId,
    config::TcpListenerConfig,
    gateway::{BindingToken, DestinationPolicy},
};
use bottleship_lan_native::{
    NativeError,
    tcp_quota::TcpQuota,
    tcp_listener::{AcceptedTcp, NativeTcpListener, TcpListenerConfig as NativeConfig},
};
use std::{collections::HashMap, net::SocketAddrV4, sync::{Arc, Mutex}, time::Duration};
use tokio::{sync::{mpsc, Semaphore}, task::JoinHandle};

struct Ingress {
    active: bool,
    pending: HashMap<u64, AcceptedTcp>,
}
struct Listener {
    ingress: Arc<Mutex<Ingress>>,
    binding: BindingToken,
    handle: NativeTcpListener,
    forward: JoinHandle<()>,
    epoch: Option<u64>,
    policy: Arc<Mutex<DestinationPolicy>>,
    leases: Vec<u64>,
}
impl Drop for Listener {
    fn drop(&mut self) {
        self.handle.abort();
        self.forward.abort();
        let mut ingress = self.ingress.lock().unwrap_or_else(|e| e.into_inner());
        ingress.active = false;
        ingress.pending.clear();
        drop(ingress);
        let leases = std::mem::take(&mut self.leases);
        let policy = self.policy.clone();
        if self.handle.status().closed {
            let mut policy = policy.lock().unwrap_or_else(|e| e.into_inner());
            for id in leases { policy.release(id); }
        } else {
            let handle = self.handle.clone();
            tokio::spawn(async move {
                let _ = handle.wait_closed().await;
                let mut policy = policy.lock().unwrap_or_else(|e| e.into_inner());
                for id in leases { policy.release(id); }
            });
        }
    }
}

pub(crate) struct TcpHostPool {
    connection: ConnId,
    policy: Arc<Mutex<DestinationPolicy>>,
    events: mpsc::Sender<Internal>,
    queue_slots: Arc<Semaphore>,
    socket_quota: Arc<TcpQuota>,
    flows: HashMap<u64, Listener>,
    next: u64,
}
impl TcpHostPool {
    pub fn new(connection: ConnId, policy: Arc<Mutex<DestinationPolicy>>, events: mpsc::Sender<Internal>, queue_limit: usize, socket_quota: Arc<TcpQuota>) -> Self {
        Self { connection, policy, events, queue_slots: Arc::new(Semaphore::new(queue_limit)), socket_quota, flows: HashMap::new(), next: 0 }
    }
    pub async fn open(&mut self, binding: BindingToken, config: TcpListenerConfig) -> Result<(u64, SocketAddrV4), NativeError> {
        config.validate().map_err(|_| NativeError::new(10022, "invalid TCP listener policy"))?;
        if binding.proto != 2 || binding.local_port == 0 || binding.generation.is_none_or(|g| g == 0) {
            return Err(NativeError::new(10022, "invalid TCP listener binding"));
        }
        if self.flows.values().any(|f| f.binding == binding) {
            return Err(NativeError::new(10048, "TCP binding already has a listener"));
        }
        if self.flows.len() >= 32 {
            return Err(NativeError::new(10055, "TCP listener limit reached"));
        }
        let id = self.next.checked_add(1).ok_or_else(|| NativeError::new(10055, "TCP listener identity exhausted"))?;
        self.next = id;
        let leases = {
            let mut policy = self.policy.lock().unwrap_or_else(|e| e.into_inner());
            let owner = policy.acquire_host_listener(&format!("tcp:{}", config.id), self.connection, config.max_owners)
                .ok_or_else(|| NativeError::new(10048, "TCP listener owner limit reached"))?;
            let mut leases = vec![owner];
            for host in &config.allowed_hosts {
                match policy.acquire(host, self.connection, false) {
                    Some(id) => leases.push(id),
                    None => {
                        for id in leases { policy.release(id); }
                        return Err(NativeError::new(10048, "TCP listener source policy conflict"));
                    }
                }
            }
            leases
        };
        let native = NativeConfig {
            bind: SocketAddrV4::new(config.bind_host.parse().unwrap(), config.port),
            advertised_ip: config.advertised_host.parse().unwrap(),
            allowed_hosts: config.allowed_hosts.iter().map(|s| s.parse().unwrap()).collect(),
            max_pending: config.max_pending,
            startup_timeout: Duration::from_millis(config.startup_timeout_ms),
        };
        let handle = match NativeTcpListener::start_with_quota(native, self.socket_quota.clone()) {
            Ok(handle) => handle,
            Err(error) => {
                let mut policy = self.policy.lock().unwrap_or_else(|e| e.into_inner());
                for id in leases { policy.release(id); }
                return Err(error);
            }
        };
        let listener = handle.clone();
        let tx = self.events.clone();
        let slots = self.queue_slots.clone();
        let ingress = Arc::new(Mutex::new(Ingress { active: true, pending: HashMap::new() }));
        let forwarding = ingress.clone();
        let forward = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok(accepted) => {
                        let accepted_id = accepted.id;
                        {
                            let mut owner = forwarding.lock().unwrap_or_else(|e| e.into_inner());
                            if !owner.active { break; }
                            owner.pending.insert(accepted_id, accepted);
                        }
                        // The cancellable owner retains the socket until the actor takes it.
                        let Ok(slot) = slots.clone().acquire_owned().await else { break; };
                        if tx.send(Internal::TcpHostAccepted { id, binding, accepted_id, _slot: slot }).await.is_err() {
                            forwarding.lock().unwrap_or_else(|e| e.into_inner()).pending.remove(&accepted_id);
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = tx.send(Internal::TcpHostClosed { id, code: error.code }).await;
                        break;
                    }
                }
            }
        });
        // Register before awaiting: cancellation of open leaves an owned entry which
        // the actor must cancel by exact binding and await physical retirement.
        self.flows.insert(id, Listener { ingress, binding, handle: handle.clone(), forward, epoch: None, policy: self.policy.clone(), leases });
        match handle.when_ready().await {
            Ok(ready) => Ok((id, ready.advertised)),
            Err(error) => { self.remove(id).await; Err(error) }
        }
    }
    pub fn take_accepted(&self, id: u64, binding: BindingToken, accepted_id: u64) -> Option<AcceptedTcp> {
        let flow = self.flows.get(&id)?;
        if flow.binding != binding { return None; }
        let mut ingress = flow.ingress.lock().unwrap_or_else(|e| e.into_inner());
        if !ingress.active { return None; }
        ingress.pending.remove(&accepted_id)
    }
    pub fn accept_epoch(&mut self, id: u64, binding: BindingToken, epoch: u64) -> bool {
        let Some(flow) = self.flows.get_mut(&id) else { return false; };
        if flow.binding != binding || epoch == 0 || flow.handle.status().closed { return false; }
        match flow.epoch {
            Some(old) => old == epoch,
            None => { flow.epoch = Some(epoch); true }
        }
    }
    pub fn epoch(&self, id: u64, binding: BindingToken) -> Option<u64> {
        let flow = self.flows.get(&id)?;
        if flow.binding != binding || flow.handle.status().closed { return None; }
        flow.epoch
    }
    pub fn contains_binding(&self, binding: BindingToken) -> bool {
        self.flows.values().any(|flow| flow.binding == binding)
    }
    pub fn identity(&self, id: u64) -> Option<(BindingToken, Option<u64>)> {
        self.flows.get(&id).map(|f| (f.binding, f.epoch))
    }
    pub fn ids_for_port(&self, proto: u8, port: u16, generation: u32) -> Vec<u64> {
        self.flows.iter().filter(|(_, f)| f.binding.proto == proto && f.binding.local_port == port
            && f.binding.generation.is_some_and(|g| g <= generation)).map(|(id, _)| *id).collect()
    }
    pub async fn remove(&mut self, id: u64) {
        if let Some(mut flow) = self.flows.remove(&id) {
            {
                let mut ingress = flow.ingress.lock().unwrap_or_else(|e| e.into_inner());
                ingress.active = false;
                ingress.pending.clear();
            }
            flow.handle.abort();
            flow.forward.abort();
            // The forward task can briefly own an accepted socket before registry
            // insertion. Joining proves that such an in-flight socket is dropped.
            let _ = (&mut flow.forward).await;
            let _ = flow.handle.wait_closed().await;
            drop(flow);
        }
    }
    pub async fn cancel_binding(&mut self, binding: BindingToken) {
        let ids: Vec<_> = self.flows.iter().filter(|(_, f)| f.binding == binding).map(|(id, _)| *id).collect();
        for id in ids { self.remove(id).await; }
    }
    pub fn abort(&self) { for flow in self.flows.values() { flow.handle.abort(); } }
    pub async fn close(&mut self) {
        self.abort();
        let ids: Vec<_> = self.flows.keys().copied().collect();
        for id in ids { self.remove(id).await; }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{io::AsyncReadExt, net::TcpStream, time::timeout};

    fn config(port: u16) -> TcpListenerConfig {
        TcpListenerConfig { id: "test".into(), bind_host: "127.0.0.1".into(),
            advertised_host: "127.0.0.1".into(), port, allowed_hosts: vec!["127.0.0.1".into()],
            max_owners: 1, max_pending: 2, startup_timeout_ms: 2000 }
    }
    fn binding(g: u32) -> BindingToken {
        BindingToken { proto: 2, local_port: 2310, generation: Some(g) }
    }
    #[tokio::test]
    async fn owner_and_epoch_are_exact_and_close_releases_physical_bind_and_leases() {
        let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
        let (tx, mut rx) = mpsc::channel(4);
        let mut pool = TcpHostPool::new(7, policy.clone(), tx, 2, TcpQuota::new(2));
        let (id, address) = pool.open(binding(4), config(0)).await.unwrap();
        assert_eq!(policy.lock().unwrap().active_leases(), 2);
        let mut peer = TcpStream::connect(address).await.unwrap();
        let accepted = match timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap() {
            Internal::TcpHostAccepted { id: got, binding: b, accepted_id, .. } => {
                assert_eq!(got, id); assert_eq!(b, binding(4));
                pool.take_accepted(got, b, accepted_id).unwrap()
            }
            _ => panic!("expected accepted socket"),
        };
        assert!(!pool.accept_epoch(id, binding(5), accepted.epoch));
        assert!(pool.accept_epoch(id, binding(4), accepted.epoch));
        assert!(!pool.accept_epoch(id, binding(4), accepted.epoch + 1));
        assert_eq!(pool.epoch(id, binding(4)), Some(accepted.epoch));
        drop(accepted);
        let mut byte = [0; 1];
        assert!(matches!(timeout(Duration::from_secs(2), peer.read(&mut byte)).await.unwrap(), Ok(0) | Err(_)));
        pool.remove(id).await;
        assert_eq!(policy.lock().unwrap().active_leases(), 0);
        let (new_id, _) = pool.open(binding(5), config(address.port())).await.unwrap();
        assert_ne!(id, new_id);
        assert_eq!(pool.identity(id), None);
        pool.close().await;
        assert_eq!(policy.lock().unwrap().active_leases(), 0);
    }
    #[tokio::test]
    async fn close_revokes_socket_even_when_actor_event_is_still_queued() {
        let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
        let quota = TcpQuota::new(1);
        let (tx, mut rx) = mpsc::channel(4);
        let mut pool = TcpHostPool::new(7, policy.clone(), tx, 1, quota.clone());
        let (id, address) = pool.open(binding(4), config(0)).await.unwrap();
        let mut peer = TcpStream::connect(address).await.unwrap();
        // Hold the queued notification without taking the socket from its owner.
        let queued = timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap();
        let accepted_id = match &queued {
            Internal::TcpHostAccepted { id: got, accepted_id, .. } => {
                assert_eq!(*got, id); *accepted_id
            }
            _ => panic!("expected queued accept"),
        };
        assert_eq!(quota.available(), 0);
        pool.remove(id).await;
        let mut byte = [0; 1];
        assert!(matches!(timeout(Duration::from_secs(2), peer.read(&mut byte)).await.unwrap(), Ok(0) | Err(_)));
        assert!(pool.take_accepted(id, binding(4), accepted_id).is_none());
        assert_eq!(quota.available(), 1);
        assert_eq!(policy.lock().unwrap().active_leases(), 0);
        let (new_id, _) = pool.open(binding(5), config(address.port())).await.unwrap();
        assert_ne!(new_id, id);
        drop(queued);
        pool.close().await;
    }
    #[tokio::test]
    async fn exclusive_source_conflict_prevents_physical_listener() {
        let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
        let other = policy.lock().unwrap().acquire("127.0.0.1", 8, true).unwrap();
        let (tx, _rx) = mpsc::channel(4);
        let mut pool = TcpHostPool::new(7, policy.clone(), tx, 2, TcpQuota::new(2));
        assert_eq!(pool.open(binding(4), config(0)).await.unwrap_err().code, 10048);
        assert_eq!(policy.lock().unwrap().active_leases(), 1);
        policy.lock().unwrap().release(other);
    }
}
