use super::*;

// Controlled blocking-worker seam, not a native DNS/Windows reference.
// No sleep is used as readiness; the worker explicitly acknowledges entry.
#[derive(Default)]
struct StartupResolverGate {
    entered: tokio::sync::Notify,
    released: Mutex<bool>,
    wake: std::sync::Condvar,
    active: std::sync::atomic::AtomicUsize,
}
impl StartupResolverGate {
    fn lookup(&self, _host: &str) -> Result<Vec<NativeAddress>, ResolveError> {
        use std::sync::atomic::Ordering::SeqCst;
        self.active.fetch_add(1, SeqCst);
        self.entered.notify_one();
        let released = self.released.lock().unwrap();
        let (released, _) = self
            .wake
            .wait_timeout_while(released, Duration::from_secs(2), |released| !*released)
            .unwrap();
        let observed_release = *released;
        self.active.fetch_sub(1, SeqCst);
        if observed_release {
            Ok(vec![NativeAddress::parse("127.0.0.1").unwrap()])
        } else {
            Err(ResolveError::new(
                ResolveCode::TryAgain,
                "Controlled worker release deadline",
            ))
        }
    }
    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.wake.notify_all();
    }
}
struct ReleaseStartupResolver(Arc<StartupResolverGate>);
impl Drop for ReleaseStartupResolver {
    fn drop(&mut self) {
        self.0.release();
    }
}
fn startup_dns_config(host: &str, routes: &[&str]) -> ServerConfig {
    let mut config = ServerConfig {
        host: host.to_owned(),
        port: 0,
        dns_timeout_ms: 20,
        max_dns_operations: 1,
        ..Default::default()
    };
    config.gateway.routes = routes
        .iter()
        .map(|host| {
            serde_json::from_value(serde_json::json!({
                "host": host, "ports": [9], "protocols": ["udp"]
            }))
            .unwrap()
        })
        .collect();
    config
}
async fn startup_health(address: SocketAddr) -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let observed = timeout(Duration::from_millis(100), async move {
        let mut socket = tokio::net::TcpStream::connect(address).await?;
        socket
            .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await?;
        let mut bytes = Vec::new();
        socket.take(4096).read_to_end(&mut bytes).await?;
        let body = b"{\"service\":\"bottleship-lan\",\"version\":1}";
        Ok::<bool, std::io::Error>(
            bytes.starts_with(b"HTTP/1.1 200")
                && bytes.windows(body.len()).any(|window| window == body),
        )
    })
    .await;
    matches!(observed, Ok(Ok(true)))
}
#[tokio::test]
async fn startup_route_dns_deadline_keeps_numeric_listener_available() {
    use std::sync::atomic::Ordering::SeqCst;
    let gate = Arc::new(StartupResolverGate::default());
    let release = ReleaseStartupResolver(gate.clone());
    let worker = gate.clone();
    let config = startup_dns_config("127.0.0.1", &["held-a.invalid", "held-b.invalid"]);
    let mut binding = tokio::spawn(async move {
        LanServer::bind_with_startup_resolver(config, move |host: &str| worker.lookup(host)).await
    });
    let entered = timeout(Duration::from_secs(1), gate.entered.notified())
        .await
        .is_ok();
    let observed = timeout(Duration::from_millis(250), &mut binding).await.ok();
    let ready_while_lookup_pending =
        matches!(observed.as_ref(), Some(Ok(Ok(_)))) && gate.active.load(SeqCst) == 1;
    let health_while_lookup_pending = match observed.as_ref() {
        Some(Ok(Ok(server))) => startup_health(server.address).await,
        _ => false,
    };
    let lookup_still_pending = gate.active.load(SeqCst) == 1;
    // Always release/join the controlled worker before any final assertion.
    drop(release);
    let joined = match observed {
        Some(joined) => joined,
        None => timeout(Duration::from_secs(3), &mut binding)
            .await
            .expect("Released bind retires"),
    };
    let server = joined
        .expect("Bind task did not panic")
        .expect("Numeric listener binds");
    timeout(Duration::from_secs(2), server.shutdown())
        .await
        .unwrap()
        .unwrap();
    assert!(
        entered,
        "Real blocking worker must enter before deadline observation"
    );
    assert!(
        ready_while_lookup_pending,
        "Configured route DNS must not gate service readiness beyond its deadline"
    );
    assert!(
        health_while_lookup_pending && lookup_still_pending,
        "Actual /health must work while the timed-out lookup still owns its worker"
    );
}
#[tokio::test]
async fn startup_listener_dns_deadline_returns_error_before_worker_return() {
    use std::sync::atomic::Ordering::SeqCst;
    let gate = Arc::new(StartupResolverGate::default());
    let release = ReleaseStartupResolver(gate.clone());
    let worker = gate.clone();
    let config = startup_dns_config("held-listener.invalid", &[]);
    let mut binding = tokio::spawn(async move {
        LanServer::bind_with_startup_resolver(config, move |host: &str| worker.lookup(host)).await
    });
    let entered = timeout(Duration::from_secs(1), gate.entered.notified())
        .await
        .is_ok();
    let observed = timeout(Duration::from_millis(250), &mut binding).await.ok();
    let listener_timeout_observed = matches!(observed.as_ref(), Some(Ok(Err(error)))
        if error.downcast_ref::<std::io::Error>().is_some_and(|error| error.kind() == std::io::ErrorKind::TimedOut));
    let lookup_still_pending = gate.active.load(SeqCst) == 1;
    drop(release);
    let joined = match observed {
        Some(joined) => joined,
        None => timeout(Duration::from_secs(3), &mut binding)
            .await
            .expect("Released bind retires"),
    };
    if let Ok(server) = joined.expect("Bind task did not panic") {
        timeout(Duration::from_secs(2), server.shutdown())
            .await
            .unwrap()
            .unwrap();
    }
    assert!(entered, "Real listener resolver worker must enter");
    assert!(
        listener_timeout_observed && lookup_still_pending,
        "Listener hostname wait must fail by its own deadline without claiming OS cancellation"
    );
}
#[tokio::test]
async fn cancelled_startup_waiter_keeps_permit_until_worker_really_returns() {
    let gate = Arc::new(StartupResolverGate::default());
    let release = ReleaseStartupResolver(gate.clone());
    let worker = gate.clone();
    let permits = Arc::new(Semaphore::new(1));
    let permit = permits.clone().acquire_owned().await.unwrap();
    let resolver = Arc::new(move |host: &str| worker.lookup(host));
    let mut waiter = tokio::spawn(resolve_owned(
        "held-permit.invalid".into(),
        permit,
        resolver,
    ));
    let entered = timeout(Duration::from_secs(1), gate.entered.notified())
        .await
        .is_ok();
    waiter.abort();
    let cancelled = matches!(timeout(Duration::from_secs(1), &mut waiter).await, Ok(Err(error)) if error.is_cancelled());
    let still_owned_by_worker = permits.available_permits() == 0;
    drop(release);
    let reclaimed = timeout(Duration::from_secs(3), permits.clone().acquire_owned()).await;
    let reclaimed = matches!(reclaimed, Ok(Ok(_)));
    assert!(
        entered && cancelled,
        "Observe actual waiter cancellation after actual worker entry"
    );
    assert!(
        still_owned_by_worker && reclaimed,
        "Cancellation fences waiting, never lends out a still-running OS work permit"
    );
}
