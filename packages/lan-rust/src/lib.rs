//! Standalone Socket.IO LAN server. Guest Win32/DirectPlay emulation stays in the client.
pub mod config;
mod dispatch;
use bottleship_lan_core::{
    Command, ConnId, Core, Effect,
    config::GatewayConfig,
    gateway::DestinationPolicy,
    routes::{NativeAddress, ResolveCode, ResolveError, Routes},
};
use bottleship_lan_gateway::{
    Gateway, GatewayEvents, GatewayHandle, GatewayOptions, GatewayOutput,
};
use bottleship_lan_transport::{
    self as transport, BoundTransport, Egress, IncomingKind, TransportHandle,
};
use config::ServerConfig;
use std::{
    collections::{HashMap, VecDeque},
    net::{SocketAddr, ToSocketAddrs},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{Semaphore, mpsc, watch},
    task::{AbortHandle, JoinSet},
    time::{Instant, MissedTickBehavior, timeout},
};
pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub struct LanServer {
    pub address: SocketAddr,
    stop: watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<Result<(), String>>>,
}
impl Drop for LanServer {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}
impl LanServer {
    pub async fn bind(config: ServerConfig) -> Result<Self, Error> {
        config.validate().map_err(std::io::Error::other)?;
        let dns = Arc::new(Semaphore::new(config.max_dns_operations));
        let gateway = Arc::new(config.gateway.clone());
        let mut routes = Routes::new(config.gateway.clone())?;
        let mut startup = JoinSet::new();
        for (id, route) in config.gateway.routes.iter().enumerate() {
            let host = route.host.clone();
            let permits = dns.clone();
            startup.spawn(async move {
                let permit = permits
                    .acquire_owned()
                    .await
                    .map_err(|_| ResolveError::new(ResolveCode::NetworkDown, "Resolver stopped"));
                let result = match permit {
                    Ok(permit) => resolve_owned(host, permit).await,
                    Err(error) => Err(error),
                };
                (id, result)
            });
        }
        while let Some(result) = startup.join_next().await {
            let (id, result) = result?;
            routes.pin(id, result)?;
        }
        let core = Core::new(config.limits.clone(), routes)?;
        let address = tokio::net::lookup_host((config.host.as_str(), config.port))
            .await?
            .next()
            .ok_or_else(|| std::io::Error::other("Server host has no address"))?;
        let mut wire = transport::Config::default();
        wire.max_connections = config.max_connections;
        wire.max_tcp_connections = config.max_connections.saturating_mul(4).max(64);
        wire.origins = config.origins();
        wire.allow_polling = config.transports.iter().any(|t| t == "polling");
        wire.allow_websocket = config.transports.iter().any(|t| t == "websocket");
        wire.output_records = config.limits.max_buffered_frames;
        wire.output_bytes = config.limits.max_buffered_bytes;
        wire.encoded_output_bytes = config
            .limits
            .max_buffered_bytes
            .saturating_mul(2)
            .saturating_add(8192);
        wire.health_response = Some(bytes::Bytes::from_static(
            b"{\"service\":\"bottleship-lan\",\"version\":1}",
        ));
        let transport = transport::bind(address, wire).await?;
        let address = transport.address;
        let (stop, stopping) = watch::channel(false);
        let task = tokio::spawn(run(transport, core, gateway, dns, config, stopping));
        Ok(Self {
            address,
            stop,
            task: Some(task),
        })
    }
    pub async fn shutdown(mut self) -> Result<(), Error> {
        let _ = self.stop.send(true);
        match self.task.take().unwrap().await? {
            Ok(()) => Ok(()),
            Err(error) => Err(std::io::Error::other(error).into()),
        }
    }
}
type Resolution = Vec<(usize, Result<Vec<NativeAddress>, ResolveError>)>;
enum Event {
    Gateway(GatewayOutput),
    GatewayClosed {
        connection: ConnId,
        error: Option<String>,
    },
    Resolved {
        connection: ConnId,
        operation: u64,
        resolutions: Resolution,
    },
}
struct Dispatcher {
    core: Core,
    transport: TransportHandle,
    gateway_config: Arc<GatewayConfig>,
    gateways: HashMap<ConnId, GatewayHandle>,
    deferred: HashMap<ConnId, Vec<Effect>>,
    policy: Arc<Mutex<DestinationPolicy>>,
    events: mpsc::Sender<Event>,
    forwards: JoinSet<()>,
    retiring: JoinSet<()>,
    resolvers: JoinSet<()>,
    resolving: HashMap<(ConnId, u64), AbortHandle>,
    dns: Arc<Semaphore>,
    native: Arc<Semaphore>,
    started: Instant,
    dns_timeout: Duration,
    log_connections: bool,
}
impl Dispatcher {
    fn now(&self) -> u64 {
        self.started.elapsed().as_millis().min(u64::MAX as u128) as u64
    }
    fn closed(&mut self, connection: ConnId) -> Vec<Effect> {
        self.deferred.remove(&connection);
        let old: Vec<_> = self
            .resolving
            .keys()
            .filter(|(id, _)| *id == connection)
            .copied()
            .collect();
        for key in old {
            if let Some(task) = self.resolving.remove(&key) {
                task.abort();
            }
        }
        self.core.apply(Command::Closed {
            connection,
            now_ms: self.now(),
        })
    }
    fn close_transport(&mut self, connection: ConnId, reason: &str) {
        if let Some(receipt) = self.transport.abort(connection, reason.to_owned()) {
            if self.log_connections {
                eprintln!(
                    "{}",
                    serde_json::json!({"event":"connectionAbort","connection":connection,"reason":reason})
                );
            }
            self.retiring.spawn(async move {
                receipt.retired().await;
            });
        }
    }
    fn retire_gateway(&mut self, connection: ConnId) {
        if let Some(handle) = self.gateways.remove(&connection) {
            handle.abort();
            self.retiring.spawn(async move {
                let _ = handle.wait_closed().await;
            });
        }
    }
    fn native_operation(
        &mut self,
        connection: ConnId,
        input: bottleship_lan_core::GatewayInput,
    ) -> Result<(), String> {
        use bottleship_lan_core::GatewayInput;
        if matches!(input, GatewayInput::Close) {
            self.retire_gateway(connection);
            return Ok(());
        }
        if !self.gateways.contains_key(&connection) {
            if matches!(
                input,
                GatewayInput::CancelOperation { .. }
                    | GatewayInput::ReleaseUdpPeer { .. }
                    | GatewayInput::ReleaseUdpHost { .. }
                    | GatewayInput::ReleasePort { .. }
            ) {
                return Ok(());
            }
            let permit = self
                .native
                .clone()
                .try_acquire_owned()
                .map_err(|_| "Global native participant limit reached".to_string())?;
            let node = self
                .core
                .connection_node(connection)
                .ok_or_else(|| "Native operation has no authenticated participant".to_string())?;
            let (handle, events) = Gateway::spawn_with_node(
                connection,
                node,
                (*self.gateway_config).clone(),
                self.policy.clone(),
                GatewayOptions::default(),
            )
            .map_err(|error| error.to_string())?;
            let sender = self.events.clone();
            let waiting = handle.clone();
            self.forwards.spawn(async move {
                forward_gateway(connection, events, sender).await;
                let _ = waiting.wait_closed().await;
                drop(permit);
            });
            self.gateways.insert(connection, handle);
        }
        self.gateways[&connection]
            .try_submit(input)
            .map_err(|error| error.to_string())
    }
    fn effects(&mut self, effects: Vec<Effect>) -> Result<(), String> {
        let mut pending = VecDeque::from(effects);
        while let Some(effect) = pending.pop_front() {
            let next = match effect {
                Effect::Emit {
                    to,
                    event,
                    retained_bytes,
                    reliable,
                    source,
                } => {
                    match self.transport.try_emit(Egress {
                        recipient: to,
                        event,
                        retained_bytes,
                        reliable,
                        sender: source,
                    }) {
                        Ok(_) => vec![],
                        Err(rejected) => self.core.apply(Command::DeliveryRejected {
                            to: rejected.recipient,
                            source: rejected.sender,
                            reliable: rejected.reliable,
                            now_ms: self.now(),
                        }),
                    }
                }
                Effect::Disconnect { connection, reason } => {
                    self.close_transport(connection, reason);
                    self.deferred.remove(&connection);
                    vec![]
                }
                Effect::NativeOperation { connection, input } => {
                    if let Err(error) = self.native_operation(connection, input) {
                        self.close_transport(connection, &error);
                        self.closed(connection)
                    } else {
                        vec![]
                    }
                }
                Effect::ResolveRoutes {
                    connection,
                    operation,
                    request_id: _,
                    route_ids,
                } => self.resolve(connection, operation, route_ids)?,
                Effect::CancelResolve {
                    connection,
                    operation,
                } => {
                    if let Some(task) = self.resolving.remove(&(connection, operation)) {
                        task.abort();
                    }
                    vec![]
                }
            };
            if pending.len().saturating_add(next.len()) > 65536 {
                return Err("Core effect capacity exceeded".into());
            }
            pending.extend(next);
        }
        Ok(())
    }
    fn resolve(
        &mut self,
        connection: ConnId,
        operation: u64,
        route_ids: Vec<usize>,
    ) -> Result<Vec<Effect>, String> {
        let permit = match self.dns.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                return Ok(self.core.apply(Command::RoutesResolved {
                    connection,
                    operation,
                    resolutions: route_ids
                        .into_iter()
                        .map(|id| {
                            (
                                id,
                                Err(ResolveError::new(
                                    ResolveCode::TryAgain,
                                    "Resolver capacity exhausted",
                                )),
                            )
                        })
                        .collect(),
                }));
            }
        };
        let mut hosts = Vec::new();
        for id in route_ids {
            let host = self
                .gateway_config
                .routes
                .get(id)
                .ok_or_else(|| "Core requested an unconfigured resolver route".to_string())?
                .host
                .clone();
            hosts.push((id, host));
        }
        let sender = self.events.clone();
        let duration = self.dns_timeout;
        let ids: Vec<_> = hosts.iter().map(|(id, _)| *id).collect();
        // The permit is owned by the blocking resolver work, not the cancellable
        // waiter. Repeated cancel/retry cannot create unlimited detached lookups.
        let task = self.resolvers.spawn(async move {
            let lookup = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                hosts
                    .into_iter()
                    .map(|(id, host)| (id, resolve_sync(&host)))
                    .collect::<Resolution>()
            });
            let result = timeout(duration, lookup).await;
            let resolutions = match result {
                Ok(Ok(rows)) => rows,
                // On timeout, blocking work retains its process-wide permit.
                Err(_) => ids
                    .iter()
                    .map(|&id| {
                        (
                            id,
                            Err(ResolveError::new(
                                ResolveCode::TryAgain,
                                "Configured destination lookup timed out",
                            )),
                        )
                    })
                    .collect(),
                Ok(Err(_)) => ids
                    .iter()
                    .map(|&id| {
                        (
                            id,
                            Err(ResolveError::new(
                                ResolveCode::NoRecovery,
                                "Resolver worker failed",
                            )),
                        )
                    })
                    .collect(),
            };
            let _ = sender
                .send(Event::Resolved {
                    connection,
                    operation,
                    resolutions,
                })
                .await;
        });
        self.resolving.insert((connection, operation), task);
        Ok(vec![])
    }
}
async fn forward_gateway(
    connection: ConnId,
    mut events: GatewayEvents,
    sender: mpsc::Sender<Event>,
) {
    let unexpected = loop {
        if events.status.borrow().closed {
            break None;
        }
        tokio::select! {
            biased;
            changed=events.status.changed()=>if changed.is_err(){
                break (!events.status.borrow().closed).then(||"Native gateway driver stopped".to_string())
            },
            output=events.outputs.recv()=>match output{
                Some(output)=>if sender.send(Event::Gateway(output)).await.is_err(){return},
                None=>break (!events.status.borrow().closed).then(||"Native gateway output stopped".to_string()),
            }
        }
    };
    let error = events
        .status
        .borrow()
        .error
        .as_ref()
        .map(ToString::to_string)
        .or(unexpected);
    let _ = sender
        .send(Event::GatewayClosed { connection, error })
        .await;
}
async fn run(
    mut wire: BoundTransport,
    core: Core,
    gateway_config: Arc<GatewayConfig>,
    dns: Arc<Semaphore>,
    config: ServerConfig,
    mut stopping: watch::Receiver<bool>,
) -> Result<(), String> {
    let (events, mut incoming) = mpsc::channel(256);
    let mut dispatcher = Dispatcher {
        core,
        transport: wire.handle.clone(),
        gateway_config,
        gateways: HashMap::new(),
        deferred: HashMap::new(),
        policy: Arc::new(Mutex::new(DestinationPolicy::default())),
        events,
        forwards: JoinSet::new(),
        retiring: JoinSet::new(),
        resolvers: JoinSet::new(),
        resolving: HashMap::new(),
        dns,
        native: Arc::new(Semaphore::new(config.max_native_participants)),
        started: Instant::now(),
        dns_timeout: Duration::from_millis(config.dns_timeout_ms),
        log_connections: config.log_connections,
    };
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut failure = None;
    let mut turn = 0;
    loop {
        for tasks in [
            &mut dispatcher.forwards,
            &mut dispatcher.retiring,
            &mut dispatcher.resolvers,
        ] {
            while let Some(result) = tasks.try_join_next() {
                if let Err(error) = result {
                    failure = Some(format!("Server worker failed: {error}"));
                }
            }
        }
        if failure.is_some() || *stopping.borrow() {
            break;
        }
        let input = dispatch::next(
            &mut wire.incoming,
            &mut incoming,
            &mut tick,
            &mut stopping,
            turn,
        )
        .await;
        turn = (turn + 1) % 3;
        let result: Result<(), String> = match input {
            dispatch::Selected::Stop => break,
            dispatch::Selected::Wire(event) => match event {
                None => break,
                Some(mut event) => {
                    let connection = event.connection;
                    // Keep event's private ingress lease alive through all effects.
                    let kind = std::mem::replace(
                        &mut event.kind,
                        IncomingKind::Closed {
                            reason: String::new(),
                        },
                    );
                    match kind {
                        IncomingKind::Authorize { auth, reply, .. } => {
                            if !dispatcher.transport.is_live(connection) {
                                let _ = reply.send(Err("Connection retired".into()));
                                Ok(())
                            } else {
                                match dispatcher.core.join(connection, &auth, dispatcher.now()) {
                                    Err(error) => {
                                        let _ = reply.send(Err(error.to_string()));
                                        Ok(())
                                    }
                                    Ok(effects) => {
                                        let mut immediate = Vec::new();
                                        let mut delayed = Vec::new();
                                        for effect in effects {
                                            if matches!(&effect,Effect::Emit{to,..}if *to==connection)
                                            {
                                                delayed.push(effect)
                                            } else {
                                                immediate.push(effect)
                                            }
                                        }
                                        dispatcher.deferred.insert(connection, delayed);
                                        let result = dispatcher.effects(immediate);
                                        if reply.send(Ok(())).is_err() {
                                            let effects = dispatcher.closed(connection);
                                            let _ = dispatcher.effects(effects);
                                        }
                                        result
                                    }
                                }
                            }
                        }
                        IncomingKind::Activated => {
                            let ready = dispatcher.deferred.remove(&connection).unwrap_or_default();
                            dispatcher.effects(ready)
                        }
                        IncomingKind::Message {
                            sequence: _,
                            name,
                            args,
                        } => {
                            let effects = dispatcher.core.apply(Command::Wire {
                                connection,
                                name,
                                args,
                                now_ms: dispatcher.now(),
                            });
                            dispatcher.effects(effects)
                        }
                        IncomingKind::Closed { reason } => {
                            if dispatcher.log_connections {
                                eprintln!(
                                    "{}",
                                    serde_json::json!({"event":"connectionClosed","connection":connection,"reason":reason})
                                );
                            }
                            let effects = dispatcher.closed(connection);
                            dispatcher.effects(effects)
                        }
                    }
                }
            },
            dispatch::Selected::Event(event) => match event {
                None => break,
                Some(Event::Gateway(output)) => {
                    let effect = dispatcher.core.apply(Command::GatewayEvent {
                        connection: output.connection,
                        event: output.event.clone(),
                    });
                    let result = dispatcher.effects(effect);
                    drop(output);
                    result
                }
                Some(Event::GatewayClosed { connection, error }) => {
                    dispatcher.gateways.remove(&connection);
                    if let Some(error) = error {
                        dispatcher.close_transport(connection, &error);
                        let effects = dispatcher.closed(connection);
                        dispatcher.effects(effects)
                    } else {
                        Ok(())
                    }
                }
                Some(Event::Resolved {
                    connection,
                    operation,
                    resolutions,
                }) => {
                    if dispatcher
                        .resolving
                        .remove(&(connection, operation))
                        .is_some()
                    {
                        let effects = dispatcher.core.apply(Command::RoutesResolved {
                            connection,
                            operation,
                            resolutions,
                        });
                        dispatcher.effects(effects)
                    } else {
                        Ok(())
                    }
                }
            },
            dispatch::Selected::Tick => {
                let effects = dispatcher.core.apply(Command::Tick {
                    now_ms: dispatcher.now(),
                });
                dispatcher.effects(effects)
            }
        };
        if let Err(error) = result {
            failure = Some(error);
            break;
        }
    }
    let ids: Vec<_> = dispatcher.gateways.keys().copied().collect();
    for id in ids {
        dispatcher.retire_gateway(id);
    }
    dispatcher.resolvers.abort_all();
    while dispatcher.resolvers.join_next().await.is_some() {}
    dispatcher.resolving.clear();
    dispatcher.deferred.clear();
    dispatcher.forwards.abort_all();
    while dispatcher.forwards.join_next().await.is_some() {}
    drop(incoming);
    wire.shutdown().await;
    let retired = timeout(Duration::from_secs(15), async {
        while dispatcher.retiring.join_next().await.is_some() {}
    })
    .await;
    if retired.is_err() {
        dispatcher.retiring.abort_all();
        return Err("Native or transport retirement timed out".into());
    }
    failure.map_or(Ok(()), Err)
}
async fn resolve_owned(
    host: String,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<Vec<NativeAddress>, ResolveError> {
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        resolve_sync(&host)
    })
    .await
    .map_err(|_| ResolveError::new(ResolveCode::NoRecovery, "Resolver worker failed"))?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn failed_gateway_driver_is_reported_to_the_core_lane() {
        let (outputs, receiver) = mpsc::channel(1);
        let (status, observed) = watch::channel(bottleship_lan_gateway::GatewayStatus::default());
        let (send, mut events) = mpsc::channel(1);
        drop(outputs);
        drop(status);
        forward_gateway(
            7,
            GatewayEvents {
                outputs: receiver,
                status: observed,
            },
            send,
        )
        .await;
        assert!(
            matches!(
                events.try_recv(),
                Ok(Event::GatewayClosed {
                    connection: 7,
                    error: Some(_)
                })
            ),
            "Driver death must retire its authenticated participant"
        );
    }
}
fn resolve_error_code(error: &std::io::Error) -> ResolveCode {
    // GetAddrInfoW preserves WSA resolver status on Windows. Other platforms
    // expose resolver failures through ErrorKind; do not reinterpret errno as WSA.
    #[cfg(windows)]
    match error.raw_os_error() {
        Some(11001) => return ResolveCode::HostNotFound,
        Some(11002) => return ResolveCode::TryAgain,
        Some(11003) => return ResolveCode::NoRecovery,
        Some(11004) => return ResolveCode::NoData,
        _ => {}
    }
    match error.kind() {
        std::io::ErrorKind::NotFound => ResolveCode::HostNotFound,
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => ResolveCode::TryAgain,
        _ => ResolveCode::NoRecovery,
    }
}
fn resolve_sync(host: &str) -> Result<Vec<NativeAddress>, ResolveError> {
    if let Ok(address) = NativeAddress::parse(host) {
        return Ok(vec![address]);
    }
    let answer = (host, 0).to_socket_addrs().map_err(|error| {
        let code = resolve_error_code(&error);
        ResolveError::new(code, "Configured destination lookup failed")
    })?;
    let mut addresses = Vec::new();
    for address in answer {
        let parsed = NativeAddress {
            ip: address.ip(),
            scope_id: match address {
                SocketAddr::V6(v) => v.scope_id(),
                _ => 0,
            },
        };
        if !addresses.contains(&parsed) {
            addresses.push(parsed)
        }
        if addresses.len() == 32 {
            break;
        }
    }
    if addresses.is_empty() {
        Err(ResolveError::new(
            ResolveCode::NoData,
            "Configured destination has no addresses",
        ))
    } else {
        Ok(addresses)
    }
}
