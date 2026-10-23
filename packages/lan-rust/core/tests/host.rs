use bottleship_lan_core::{config::*, gateway::*, routes::*, wire::*, *};
use bytes::Bytes;
use serde_json::{Value, json};
fn config() -> GatewayConfig {
    serde_json::from_value(json!({"udpListeners":[{"id":"native","bindHost":"127.0.0.1","advertisedHost":"127.0.0.1","port":0,"allowedHosts":["127.0.0.1"]}]})).unwrap()
}
fn core() -> Core {
    let mut c = Core::new(Limits::default(), Routes::new(config()).unwrap()).unwrap();
    c.join(1, &auth(1), 0).unwrap();
    c
}
fn auth(id: u8) -> Value {
    json!({"version":1,"room":"host","clientId":format!("host-participant-{id:08}"),"node":[2,0,0,0,0,id]})
}
fn input(c: &mut Core, event: InboundEvent) -> Vec<Effect> {
    c.apply(Command::Input {
        connection: 1,
        event,
        now_ms: 0,
    })
}
fn open(c: &mut Core, id: u32, g: u32) -> (u64, BindingToken) {
    let e = input(
        c,
        InboundEvent::OpenUdpHost {
            id,
            request: UdpHostRequest {
                proto: 1,
                local_port: 2000,
                binding_generation: g,
                listener_id: "native".into(),
            },
        },
    );
    e.into_iter()
        .find_map(|e| match e {
            Effect::NativeOperation {
                input:
                    GatewayInput::OpenUdpHost {
                        operation, binding, ..
                    },
                ..
            } => Some((operation, binding)),
            _ => None,
        })
        .unwrap()
}
fn native(c: &mut Core, event: GatewayEvent) -> Vec<Effect> {
    c.apply(Command::GatewayEvent {
        connection: 1,
        event,
    })
}
fn ready(c: &mut Core, op: u64, id: u64) -> Vec<Effect> {
    native(
        c,
        GatewayEvent::HostReady {
            operation: op,
            lease_id: id,
            node: [2, 1, 127, 0, 0, 1],
            port: 45678,
        },
    )
}
fn data(node: Node, g: u32) -> InboundEvent {
    InboundEvent::Frame {
        datagram: Datagram {
            proto: 1,
            node,
            src_port: 2000,
            dst_port: 54321,
            payload: Bytes::from_static(b"reply"),
        },
        generation: Some(g),
    }
}
fn named(e: &[Effect], name: &str) -> Vec<Vec<Value>> {
    e.iter()
        .filter_map(|e| match e {
            Effect::Emit {
                event: ServerEvent::Json { name: n, args },
                ..
            } if *n == name => Some(args.clone()),
            _ => None,
        })
        .collect()
}
#[test]
fn capability_exposes_only_configured_acl_and_defaults() {
    let cfg = config();
    assert_eq!(cfg.udp_listeners[0].max_owners, 1);
    assert_eq!(cfg.udp_listeners[0].max_peers, 64);
    let mut c = Core::new(Limits::default(), Routes::new(cfg).unwrap()).unwrap();
    let e = c.join(1, &auth(1), 0).unwrap();
    let r = named(&e, "ready");
    assert_eq!(
        r[0][0]["udpHostListenV1"]["listeners"][0],
        json!({"id":"native","allowedNodes":[[2,1,127,0,0,1]]})
    );
    assert!(!r[0][0].to_string().contains("helper"));
}
#[test]
fn host_dynamic_egress_precedes_fixed_routes_but_lan_stays_in_room() {
    let mut c = core();
    c.join(2, &auth(2), 0).unwrap();
    let (op, b) = open(&mut c, 1, 1);
    let pending = input(&mut c, data([2, 1, 127, 0, 0, 1], 1));
    assert_eq!(named(&pending, "socketError")[0][0]["code"], 10057);
    assert_eq!(
        named(&ready(&mut c, op, 77), "udpHostOpened")[0][1]["address"]["port"],
        45678
    );
    let sent = input(&mut c, data([2, 1, 127, 0, 0, 1], 1));
    assert!(
        matches!(&sent[0],Effect::NativeOperation{input:GatewayInput::HostFrame{lease_id:77,binding,..},..}if *binding==b)
    );
    assert_eq!(
        named(&input(&mut c, data([2, 1, 127, 0, 0, 2], 1)), "socketError")[0][0]["code"],
        10013
    );
    let lan = input(&mut c, data([2, 0, 0, 0, 0, 2], 1));
    assert!(lan.iter().any(|e| matches!(
        e,
        Effect::Emit {
            to: 2,
            event: ServerEvent::Frame { .. },
            ..
        }
    )));
}
#[test]
fn cancel_before_and_after_ready_releases_exact_native_lease() {
    let mut c = core();
    let (op, _) = open(&mut c, 1, 1);
    let cancel = input(&mut c, InboundEvent::CancelUdpHost { id: 1 });
    assert!(cancel.iter().any(|e|matches!(e,Effect::NativeOperation{input:GatewayInput::CancelOperation{operation},..}if *operation==op)));
    let late = ready(&mut c, op, 91);
    assert!(matches!(
        &late[0],
        Effect::NativeOperation {
            input: GatewayInput::ReleaseUdpHost { lease_id: 91 },
            ..
        }
    ));
    assert!(named(&late, "udpHostOpened").is_empty());
    let (op, _) = open(&mut c, 2, 1);
    ready(&mut c, op, 92);
    let cancel = input(&mut c, InboundEvent::CancelUdpHost { id: 2 });
    assert!(matches!(
        &cancel[0],
        Effect::NativeOperation {
            input: GatewayInput::ReleaseUdpHost { lease_id: 92 },
            ..
        }
    ));
}
#[test]
fn old_callbacks_and_queued_ordinary_udp_do_not_cross_host_epoch() {
    let mut c = core();
    let (op, b) = open(&mut c, 1, 1);
    ready(&mut c, op, 11);
    let d = Datagram {
        proto: 1,
        node: [2, 1, 127, 0, 0, 1],
        src_port: 4000,
        dst_port: 2000,
        payload: Bytes::from_static(b"old"),
    };
    assert!(
        native(
            &mut c,
            GatewayEvent::Frame {
                binding: b,
                datagram: d.clone()
            }
        )
        .is_empty()
    );
    assert!(
        !native(
            &mut c,
            GatewayEvent::HostFrame {
                lease_id: 11,
                binding: b,
                datagram: d.clone()
            }
        )
        .is_empty()
    );
    let (op, b2) = open(&mut c, 2, 2);
    ready(&mut c, op, 12);
    assert!(
        native(
            &mut c,
            GatewayEvent::HostFrame {
                lease_id: 11,
                binding: b,
                datagram: d.clone()
            }
        )
        .is_empty()
    );
    assert!(
        native(
            &mut c,
            GatewayEvent::HostClosed {
                lease_id: 11,
                code: 10050
            }
        )
        .is_empty()
    );
    assert!(
        !native(
            &mut c,
            GatewayEvent::HostFrame {
                lease_id: 12,
                binding: b2,
                datagram: d
            }
        )
        .is_empty()
    );
}
#[test]
fn fatal_host_close_identifies_request_and_lease_and_tombstones_binding() {
    let mut c = core();
    let (op, _) = open(&mut c, 19, 1);
    ready(&mut c, op, 500);
    let ended = native(
        &mut c,
        GatewayEvent::HostClosed {
            lease_id: 500,
            code: 10050,
        },
    );
    let args = &named(&ended, "udpHostClosed")[0];
    assert_eq!(args[0], 19);
    assert_eq!(args[1], 1);
    assert_eq!(args[2]["code"], 10050);
    assert!(input(&mut c, data([2, 1, 127, 0, 0, 1], 1)).is_empty());
    let (op, _) = open(&mut c, 20, 2);
    assert_eq!(
        named(&ready(&mut c, op, 501), "udpHostOpened")[0][1]["leaseId"],
        2
    );
}
#[test]
fn malformed_request_is_not_null_or_omission_and_unknown_listener_cannot_open() {
    let args = [
        Arg::Json(json!(1)),
        Arg::Json(
            json!({"proto":1,"localPort":2000,"bindingGeneration":null,"listenerId":"native"}),
        ),
    ];
    assert!(matches!(
        decode_event("openUdpHost", &args),
        Err(DecodeError::Host { id: 1 })
    ));
    let mut c = core();
    let e = input(
        &mut c,
        InboundEvent::OpenUdpHost {
            id: 1,
            request: UdpHostRequest {
                proto: 1,
                local_port: 2000,
                binding_generation: 1,
                listener_id: "foreign".into(),
            },
        },
    );
    assert_eq!(named(&e, "udpHostOpened")[0][1]["error"]["code"], 10013);
}
#[test]
fn configured_owner_cap_is_shared_and_idempotently_released() {
    let mut p = DestinationPolicy::default();
    let id = p.acquire_host_listener("native", 1, 1).unwrap();
    assert!(p.acquire_host_listener("native", 2, 1).is_none());
    assert_eq!(p.active_leases(), 1);
    p.release(id);
    p.release(id);
    let other = p.acquire_host_listener("native", 2, 1).unwrap();
    p.release(other);
    assert_eq!(p.active_leases(), 0);
}
#[test]
fn invalid_listener_acl_and_owner_limits_are_rejected() {
    for patch in [
        json!({"allowedHosts":[]}),
        json!({"allowedHosts":["0.0.0.0"]}),
        json!({"advertisedHost":"224.0.0.1"}),
        json!({"maxOwners":0}),
    ] {
        let mut value = serde_json::to_value(config()).unwrap();
        for (k, v) in patch.as_object().unwrap() {
            value["udpListeners"][0][k] = v.clone();
        }
        let cfg: GatewayConfig = serde_json::from_value(value).unwrap();
        assert!(cfg.validate().is_err());
    }
}
