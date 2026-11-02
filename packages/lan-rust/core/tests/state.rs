use bottleship_lan_core::{config::*, gateway::*, routes::*, wire::*, *};
use bytes::Bytes;
use serde_json::{Value, json};
fn auth(node: u8, room: &str) -> Value {
    json!({"version":1,"room":room,"clientId":format!("participant-{node:08}"),"node":[2,0,0,0,0,node]})
}
fn plain() -> Core {
    Core::new(
        Limits::default(),
        Routes::new(GatewayConfig::default()).unwrap(),
    )
    .unwrap()
}
fn routed() -> Core {
    let config:GatewayConfig=serde_json::from_value(json!({"routes":[{"host":"127.0.0.1","names":["echo.test"],"ports":[9000],"protocols":["udp","tcp"]}]})).unwrap();
    Core::new(Limits::default(), Routes::new(config).unwrap()).unwrap()
}
fn send(core: &mut Core, c: u64, event: InboundEvent) -> Vec<Effect> {
    core.apply(Command::Input {
        connection: c,
        event,
        now_ms: 0,
    })
}
fn frame(proto: u8, to: Node) -> Datagram {
    Datagram {
        proto,
        node: to,
        dst_port: 9000,
        src_port: 2000,
        payload: Bytes::from_static(b"payload"),
    }
}
fn lease(id: u32, generation: u32) -> InboundEvent {
    InboundEvent::LeaseUdpPeer {
        id,
        request: UdpLeaseRequest {
            proto: 1,
            local_port: 2000,
            binding_generation: generation,
            node: [2, 1, 127, 0, 0, 1],
            remote_port: 9000,
        },
    }
}
fn operation(e: &[Effect]) -> u64 {
    e.iter()
        .find_map(|e| {
            if let Effect::NativeOperation {
                input: GatewayInput::LeaseUdpPeer { operation, .. },
                ..
            } = e
            {
                Some(*operation)
            } else {
                None
            }
        })
        .unwrap()
}
#[test]
fn gateway_identity_is_authenticated_and_retires_with_connection() {
    let mut c = plain();
    assert_eq!(c.connection_node(1), None);
    c.join(1, &auth(7, "identity"), 0).unwrap();
    assert_eq!(c.connection_node(1), Some([2, 0, 0, 0, 0, 7]));
    // Reconnect replaces the old connection, not its authenticated identity.
    c.join(2, &auth(7, "identity"), 1).unwrap();
    assert_eq!(c.connection_node(1), None);
    assert_eq!(c.connection_node(2), Some([2, 0, 0, 0, 0, 7]));
    c.apply(Command::Closed {
        connection: 2,
        now_ms: 2,
    });
    assert_eq!(c.connection_node(2), None);
}
#[test]
fn room_isolation_source_rewrite_and_generation_omission() {
    let mut c = plain();
    for (id, node, room) in [(1, 1, "a"), (2, 2, "a"), (3, 2, "b")] {
        c.join(id, &auth(node, room), 0).unwrap();
    }
    let effects = send(
        &mut c,
        1,
        InboundEvent::Frame {
            datagram: frame(1, [2, 0, 0, 0, 0, 2]),
            generation: Some(999),
        },
    );
    let frames: Vec<_> = effects
        .iter()
        .filter_map(|e| {
            if let Effect::Emit {
                to,
                event: ServerEvent::Frame { bytes, generation },
                source,
                ..
            } = e
            {
                Some((
                    *to,
                    Datagram::decode(bytes.clone()).unwrap(),
                    *generation,
                    *source,
                ))
            } else {
                None
            }
        })
        .collect();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].0, 2);
    assert_eq!(frames[0].1.node, [2, 0, 0, 0, 0, 1]);
    assert_eq!(frames[0].2, None);
    assert_eq!(frames[0].3, Some(1));
}
#[test]
fn broadcast_excludes_sender_and_other_rooms() {
    let mut c = plain();
    for (id, node, room) in [(1, 1, "a"), (2, 2, "a"), (3, 3, "b")] {
        c.join(id, &auth(node, room), 0).unwrap();
    }
    let e = send(
        &mut c,
        1,
        InboundEvent::Frame {
            datagram: frame(1, [255; 6]),
            generation: None,
        },
    );
    assert!(matches!(e.as_slice(), [Effect::Emit { to: 2, .. }]));
}
#[test]
fn reliable_rejection_retires_both_but_udp_does_not() {
    let mut c = plain();
    c.join(1, &auth(1, "a"), 0).unwrap();
    c.join(2, &auth(2, "a"), 0).unwrap();
    assert!(
        c.apply(Command::DeliveryRejected {
            to: 2,
            source: Some(1),
            reliable: false,
            now_ms: 0
        })
        .is_empty()
    );
    let e = c.apply(Command::DeliveryRejected {
        to: 2,
        source: Some(1),
        reliable: true,
        now_ms: 0,
    });
    assert_eq!(c.participant_count(), 0);
    assert_eq!(
        e.iter()
            .filter(|e| matches!(e, Effect::Disconnect { .. }))
            .count(),
        2
    );
}
#[test]
fn replaced_connection_cannot_retire_successor() {
    let mut c = plain();
    c.join(1, &auth(1, "a"), 0).unwrap();
    c.join(2, &auth(2, "a"), 0).unwrap();
    let e = c.join(3, &auth(1, "a"), 1).unwrap();
    assert!(
        e.iter()
            .any(|e| matches!(e, Effect::Disconnect { connection: 1, .. }))
    );
    assert!(
        c.apply(Command::Closed {
            connection: 1,
            now_ms: 2
        })
        .is_empty()
    );
    assert_eq!(c.participant_count(), 2);
    let e = send(
        &mut c,
        2,
        InboundEvent::Frame {
            datagram: frame(1, [2, 0, 0, 0, 0, 1]),
            generation: None,
        },
    );
    assert!(matches!(e.as_slice(), [Effect::Emit { to: 3, .. }]));
}
#[test]
fn foreign_client_cannot_steal_retained_node() {
    let mut c = plain();
    c.join(1, &auth(1, "a"), 0).unwrap();
    c.apply(Command::Closed {
        connection: 1,
        now_ms: 1,
    });
    let mut other = auth(1, "a");
    other["clientId"] = json!("different-client-0001");
    assert!(c.join(2, &other, 2).is_err());
    c.apply(Command::Tick { now_ms: 60002 });
    assert!(c.join(2, &other, 60002).is_ok());
}
#[test]
fn malformed_generation_disconnects_while_omission_is_legacy() {
    for generation in [
        Value::Null,
        json!(0),
        json!(-1),
        json!(4294967296u64),
        json!(1.5),
    ] {
        let mut c = plain();
        c.join(1, &auth(1, "a"), 0).unwrap();
        let bytes = frame(1, [255; 6]).encode().unwrap();
        let e = c.apply(Command::Wire {
            connection: 1,
            name: "frame".into(),
            args: vec![Arg::Binary(bytes), Arg::Json(generation)],
            now_ms: 0,
        });
        assert!(
            e.iter()
                .any(|e| matches!(e, Effect::Disconnect { connection: 1, .. }))
        );
    }
    let mut c = plain();
    c.join(1, &auth(1, "a"), 0).unwrap();
    let bytes = frame(1, [255; 6]).encode().unwrap();
    c.apply(Command::Wire {
        connection: 1,
        name: "frame".into(),
        args: vec![Arg::Binary(bytes)],
        now_ms: 0,
    });
    assert_eq!(c.participant_count(), 1);
}
#[test]
fn native_generation_fences_late_frames_errors_and_untracked_revival() {
    let mut c = routed();
    c.join(1, &auth(1, "a"), 0).unwrap();
    send(
        &mut c,
        1,
        InboundEvent::Frame {
            datagram: frame(1, [2, 1, 127, 0, 0, 1]),
            generation: Some(1),
        },
    );
    send(
        &mut c,
        1,
        InboundEvent::ReleasePort {
            proto: 1,
            port: 2000,
            generation: 1,
        },
    );
    assert!(
        send(
            &mut c,
            1,
            InboundEvent::Frame {
                datagram: frame(1, [2, 1, 127, 0, 0, 1]),
                generation: None
            }
        )
        .is_empty()
    );
    send(
        &mut c,
        1,
        InboundEvent::Frame {
            datagram: frame(1, [2, 1, 127, 0, 0, 1]),
            generation: Some(2),
        },
    );
    let old = BindingToken {
        proto: 1,
        local_port: 2000,
        generation: Some(1),
    };
    let d = Datagram {
        proto: 1,
        node: [2, 1, 127, 0, 0, 1],
        dst_port: 2000,
        src_port: 9000,
        payload: Bytes::new(),
    };
    assert!(
        c.apply(Command::GatewayEvent {
            connection: 1,
            event: GatewayEvent::Frame {
                binding: old,
                datagram: d.clone()
            }
        })
        .is_empty()
    );
    assert!(
        c.apply(Command::GatewayEvent {
            connection: 1,
            event: GatewayEvent::SocketError {
                binding: old,
                node: d.node,
                remote_port: 9000,
                code: 10054,
                wire_id: None
            }
        })
        .is_empty()
    );
    let e = c.apply(Command::GatewayEvent {
        connection: 1,
        event: GatewayEvent::Frame {
            binding: BindingToken {
                generation: Some(2),
                ..old
            },
            datagram: d,
        },
    });
    assert!(matches!(
        e.as_slice(),
        [Effect::Emit {
            event: ServerEvent::Frame {
                generation: Some(2),
                ..
            },
            ..
        }]
    ));
}
#[test]
fn cancel_before_native_ready_releases_exact_late_lease() {
    let mut c = routed();
    c.join(1, &auth(1, "a"), 0).unwrap();
    let e = send(&mut c, 1, lease(1, 1));
    let op = operation(&e);
    let e = send(&mut c, 1, InboundEvent::CancelUdpPeer { id: 1 });
    assert!(
        matches!(e.as_slice(),[Effect::NativeOperation{input:GatewayInput::CancelOperation{operation},..}]if *operation==op)
    );
    let e = c.apply(Command::GatewayEvent {
        connection: 1,
        event: GatewayEvent::LeaseReady {
            operation: op,
            lease_id: 900,
        },
    });
    assert!(matches!(
        e.as_slice(),
        [Effect::NativeOperation {
            input: GatewayInput::ReleaseUdpPeer { lease_id: 900 },
            ..
        }]
    ));
}
#[test]
fn cancel_after_queued_ack_revokes_original_lease_and_is_idempotent() {
    let mut c = routed();
    c.join(1, &auth(1, "a"), 0).unwrap();
    let op = operation(&send(&mut c, 1, lease(1, 1)));
    c.apply(Command::GatewayEvent {
        connection: 1,
        event: GatewayEvent::LeaseReady {
            operation: op,
            lease_id: 901,
        },
    });
    let e = send(&mut c, 1, InboundEvent::CancelUdpPeer { id: 1 });
    assert!(matches!(
        e.as_slice(),
        [Effect::NativeOperation {
            input: GatewayInput::ReleaseUdpPeer { lease_id: 901 },
            ..
        }]
    ));
    assert!(send(&mut c, 1, InboundEvent::CancelUdpPeer { id: 1 }).is_empty());
}
#[test]
fn rebind_cancels_old_operation_and_late_disconnect_completion_cannot_leak() {
    let mut c = routed();
    c.join(1, &auth(1, "a"), 0).unwrap();
    let op = operation(&send(&mut c, 1, lease(1, 1)));
    let e = send(&mut c, 1, lease(2, 2));
    assert!(e.iter().any(|e|matches!(e,Effect::NativeOperation{input:GatewayInput::CancelOperation{operation},..}if *operation==op)));
    c.apply(Command::Closed {
        connection: 1,
        now_ms: 1,
    });
    let e = c.apply(Command::GatewayEvent {
        connection: 1,
        event: GatewayEvent::LeaseReady {
            operation: op,
            lease_id: 902,
        },
    });
    assert!(matches!(
        e.as_slice(),
        [Effect::NativeOperation {
            input: GatewayInput::ReleaseUdpPeer { lease_id: 902 },
            ..
        }]
    ));
}
#[test]
fn bounded_pending_leases_and_request_identity() {
    let mut c = routed();
    c.join(1, &auth(1, "a"), 0).unwrap();
    for id in 1..=16 {
        assert!(send(&mut c, 1, lease(id, 1)).iter().any(|e| matches!(
            e,
            Effect::NativeOperation {
                input: GatewayInput::LeaseUdpPeer { .. },
                ..
            }
        )))
    }
    let e = send(&mut c, 1, lease(17, 1));
    assert!(
        matches!(e.as_slice(),[Effect::Emit{event:ServerEvent::Json{args,..},..}]if args[1]["error"]["code"]==10055)
    );
    assert!(
        send(&mut c, 1, lease(17, 1))
            .iter()
            .any(|e| matches!(e, Effect::Disconnect { connection: 1, .. }))
    );
}
#[test]
fn frames_and_fin_are_effect_ordered_before_release() {
    let mut c = routed();
    c.join(1, &auth(1, "a"), 0).unwrap();
    let mut effects = vec![];
    for kind in [1, 3, 4] {
        let mut d = frame(2, [2, 1, 127, 0, 0, 1]);
        d.payload = TcpFrame {
            kind,
            src_id: 1,
            dst_id: 0,
            value: TCP_WINDOW,
            data: Bytes::new(),
        }
        .encode();
        effects.extend(send(
            &mut c,
            1,
            InboundEvent::Frame {
                datagram: d,
                generation: Some(1),
            },
        ));
    }
    effects.extend(send(
        &mut c,
        1,
        InboundEvent::ReleasePort {
            proto: 2,
            port: 2000,
            generation: 1,
        },
    ));
    let kinds: Vec<_> = effects
        .iter()
        .filter_map(|e| match e {
            Effect::NativeOperation {
                input: GatewayInput::Frame { datagram, .. },
                ..
            } => Some(TcpFrame::decode(datagram.payload.clone()).unwrap().kind),
            Effect::NativeOperation {
                input: GatewayInput::ReleasePort { .. },
                ..
            } => Some(99),
            _ => None,
        })
        .collect();
    assert_eq!(kinds, [1, 3, 4, 99]);
}
#[test]
fn rate_limit_disconnect_is_visible_and_reclaims_pending_native_resources() {
    let mut c = routed();
    c.limits.max_frames_per_second = 1;
    c.join(1, &auth(1, "a"), 0).unwrap();
    send(&mut c, 1, lease(1, 1));
    let e = send(&mut c, 1, lease(2, 1));
    assert_eq!(c.participant_count(), 0);
    assert!(e.iter().any(|e| matches!(
        e,
        Effect::NativeOperation {
            input: GatewayInput::Close,
            ..
        }
    )));
}
#[test]
fn configured_dns_alias_only_and_policy_refcounts() {
    let c = routed();
    let r = c
        .routes
        .resolve(&ResolveRequest {
            host: "ECHO.TEST.".into(),
            family: 4,
            reverse: None,
        })
        .unwrap();
    assert_eq!(r.addresses[0].address, "127.0.0.1");
    assert_eq!(
        c.routes
            .resolve(&ResolveRequest {
                host: "external.invalid".into(),
                family: 0,
                reverse: None
            })
            .unwrap_err()
            .code,
        ResolveCode::AccessDenied
    );
    let mut p = DestinationPolicy::default();
    let a = p.acquire("127.0.0.1", 1, false).unwrap();
    let b = p.acquire("127.0.0.1", 1, false).unwrap();
    assert!(p.acquire("127.0.0.1", 2, true).is_none());
    p.release(a);
    assert!(p.acquire("127.0.0.1", 2, true).is_none());
    p.release(b);
    p.release(b);
    assert!(p.acquire("127.0.0.1", 2, true).is_some());
}
#[test]
fn scoped_guest_alias_maps_to_pinned_native_scope_and_stable_identity() {
    let config:GatewayConfig=serde_json::from_value(json!({"routes":[{"host":"native.test","address":"fe80::20","scopeId":7,"names":["visible.test"],"ports":[123],"protocols":["udp"]}]})).unwrap();
    let mut routes = Routes::new(config).unwrap();
    routes
        .pin(0, Ok(vec![NativeAddress::parse("fe80::99%11").unwrap()]))
        .unwrap();
    let result = routes
        .resolve(&ResolveRequest {
            host: "visible.test".into(),
            family: 6,
            reverse: None,
        })
        .unwrap();
    let a = &result.addresses[0];
    assert_eq!(a.scope_id, Some(7));
    let d = Datagram {
        proto: 4,
        node: a.node.unwrap(),
        src_port: 5,
        dst_port: 123,
        payload: Bytes::new(),
    };
    let target = routes.target(&d).unwrap();
    assert_eq!(target.address.scope_id, 11);
    assert_eq!(target.canonical_policy_key, "fe80::99%11");
    routes
        .pin(0, Ok(vec![NativeAddress::parse("fe80::88%12").unwrap()]))
        .unwrap();
    let refreshed = routes
        .resolve(&ResolveRequest {
            host: "visible.test".into(),
            family: 6,
            reverse: None,
        })
        .unwrap();
    assert_eq!(refreshed.addresses[0].node, a.node);
}
#[test]
fn raw_source_socket_protocol_is_independent_of_actual_protocol() {
    let d = Datagram {
        proto: 6,
        node: [2, 1, 127, 0, 0, 1],
        src_port: 256,
        dst_port: 2,
        payload: Bytes::from_static(&[1, 1, 0x45]),
    };
    assert_eq!(Datagram::decode(d.encode().unwrap()).unwrap(), d);
}
