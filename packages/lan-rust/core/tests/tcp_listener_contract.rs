use bottleship_lan_core::{config::GatewayConfig, wire::TcpHostRequest};
use serde_json::{json, Value};

fn policy() -> Value {
    json!({"id":"dp4", "bindHost":"127.0.0.1", "advertisedHost":"127.0.0.1",
        "port":0, "allowedHosts":["127.0.0.1"]})
}
fn cfg(listener: Value) -> GatewayConfig {
    serde_json::from_value(json!({"tcpListeners":[listener]})).unwrap()
}
#[test]
fn listener_is_opt_in_and_defaults_are_bounded() {
    let empty = GatewayConfig::default();
    assert!(empty.tcp_listeners.is_empty());
    assert!(empty.validate().is_ok());
    let config = cfg(policy());
    assert!(config.validate().is_ok());
    let item = &config.tcp_listeners[0];
    assert_eq!((item.max_owners, item.max_pending, item.startup_timeout_ms), (1, 64, 10000));
}
#[test]
fn listener_rejects_invalid_acl_limits_and_duplicate_ids() {
    let cases = [
        ("bindHost", json!("localhost")), ("bindHost", json!("224.0.0.1")),
        ("advertisedHost", json!("0.0.0.0")), ("advertisedHost", json!("255.255.255.255")),
        ("allowedHosts", json!([])), ("allowedHosts", json!(["localhost"])),
        ("allowedHosts", json!(["127.0.0.1", "127.0.0.1"])),
        ("maxOwners", json!(0)), ("maxOwners", json!(65)),
        ("maxPending", json!(0)), ("maxPending", json!(129)),
        ("startupTimeoutMs", json!(0)), ("startupTimeoutMs", json!(120001)),
        ("id", json!("bad id")),
    ];
    for (key, value) in cases {
        let mut p = policy(); p[key] = value;
        assert!(cfg(p).validate().is_err(), "invalid {key}");
    }
    let duplicates: GatewayConfig = serde_json::from_value(
        json!({"tcpListeners":[policy(),policy()]})).unwrap();
    assert!(duplicates.validate().is_err());
    let mut over_capacity = cfg(policy());
    over_capacity.max_tcp_connections = 63;
    assert!(over_capacity.validate().is_err());
}
#[test]
fn tcp_host_request_requires_generation_port_protocol_and_listener_identity() {
    let request = json!({"proto":2,"localPort":47624,"bindingGeneration":1,"listenerId":"dp4"});
    let decoded = TcpHostRequest::decode(&request).unwrap();
    assert_eq!((decoded.proto, decoded.local_port, decoded.binding_generation), (2, 47624, 1));
    assert_eq!(decoded.listener_id, "dp4");
    for (key, value) in [
        ("proto", json!(1)), ("proto", json!(2.5)),
        ("localPort", json!(0)), ("localPort", json!(65536)),
        ("bindingGeneration", json!(0)), ("bindingGeneration", json!(4294967296u64)),
        ("listenerId", json!("")), ("listenerId", json!("bad/id")),
        ("listenerId", json!("a".repeat(65))),
    ] {
        let mut bad = request.clone(); bad[key] = value;
        assert!(TcpHostRequest::decode(&bad).is_err(), "invalid {key}");
    }
}
