use bottleship_lan_core::{config::*, routes::*, wire::*, *};
use serde_json::json;
fn core() -> Core {
    let config:GatewayConfig=serde_json::from_value(json!({"routes":[{"host":"configured.test","names":["alias.test"],"ports":[9000],"protocols":["udp"]}]})).unwrap();
    let mut c = Core::new(Limits::default(), Routes::new(config).unwrap()).unwrap();
    c.join(
        1,
        &json!({"version":1,"room":"room","clientId":"participant-00000001","node":[2,0,0,0,0,1]}),
        0,
    )
    .unwrap();
    c
}
fn query(c: &mut Core, id: u32) -> Vec<Effect> {
    c.apply(Command::Input {
        connection: 1,
        event: InboundEvent::Resolve {
            id,
            request: ResolveRequest {
                host: "alias.test".into(),
                family: 4,
                reverse: None,
            },
        },
        now_ms: 0,
    })
}
fn operation(e: &[Effect]) -> u64 {
    match &e[0] {
        Effect::ResolveRoutes {
            operation,
            route_ids,
            ..
        } => {
            assert_eq!(route_ids, &[0]);
            *operation
        }
        _ => panic!("no resolver request"),
    }
}
fn complete(c: &mut Core, op: u64, address: &str) -> Vec<Effect> {
    c.apply(Command::RoutesResolved {
        connection: 1,
        operation: op,
        resolutions: vec![(0, Ok(vec![NativeAddress::parse(address).unwrap()]))],
    })
}
#[test]
fn configured_dns_is_refreshed_and_answered_from_exact_new_snapshot() {
    let mut c = core();
    let op = operation(&query(&mut c, 1));
    let e = complete(&mut c, op, "127.0.0.2");
    assert!(
        matches!(e.as_slice(),[Effect::Emit{event:ServerEvent::Json{args,..},..}]if args[1]["result"]["addresses"][0]["address"]=="127.0.0.2")
    );
    let op = operation(&query(&mut c, 2));
    let e = complete(&mut c, op, "127.0.0.3");
    assert!(
        matches!(e.as_slice(),[Effect::Emit{event:ServerEvent::Json{args,..},..}]if args[1]["result"]["addresses"][0]["address"]=="127.0.0.3")
    );
}
#[test]
fn cancellation_then_id_reuse_does_not_accept_late_old_completion() {
    let mut c = core();
    let old = operation(&query(&mut c, 1));
    let e = c.apply(Command::Input {
        connection: 1,
        event: InboundEvent::CancelResolve { id: 1 },
        now_ms: 0,
    });
    assert!(matches!(e.as_slice(),[Effect::CancelResolve{operation,..}]if *operation==old));
    let current = operation(&query(&mut c, 1));
    assert_ne!(old, current);
    assert!(complete(&mut c, old, "127.0.0.2").is_empty());
    assert!(!complete(&mut c, current, "127.0.0.3").is_empty());
}
#[test]
fn dns_pending_cap_and_duplicate_request_id_are_bounded() {
    let mut c = core();
    for id in 1..=16 {
        operation(&query(&mut c, id));
    }
    assert!(query(&mut c, 1).is_empty());
    let e = query(&mut c, 17);
    assert!(
        matches!(e.as_slice(),[Effect::Emit{event:ServerEvent::Json{args,..},..}]if args[1]["error"]["code"]=="TRY_AGAIN")
    );
}
#[test]
fn foreign_route_completion_cannot_mutate_routes() {
    let mut c = core();
    let op = operation(&query(&mut c, 1));
    let e = c.apply(Command::RoutesResolved {
        connection: 1,
        operation: op,
        resolutions: vec![(9, Ok(vec![NativeAddress::parse("127.0.0.2").unwrap()]))],
    });
    assert!(
        matches!(e.as_slice(),[Effect::Emit{event:ServerEvent::Json{args,..},..}]if args[1]["error"]["code"]=="NO_RECOVERY")
    );
    assert!(c.routes.advertised_ipv4().is_empty());
}
#[test]
fn disconnect_cancels_dns_and_late_completion_is_suppressed() {
    let mut c = core();
    let op = operation(&query(&mut c, 1));
    let e = c.apply(Command::Closed {
        connection: 1,
        now_ms: 1,
    });
    assert!(
        e.iter()
            .any(|e| matches!(e,Effect::CancelResolve{operation,..}if *operation==op))
    );
    assert!(complete(&mut c, op, "127.0.0.2").is_empty());
}
#[test]
fn unconfigured_dns_never_emits_a_native_lookup() {
    let mut c = core();
    let e = c.apply(Command::Input {
        connection: 1,
        event: InboundEvent::Resolve {
            id: 1,
            request: ResolveRequest {
                host: "other.test".into(),
                family: 0,
                reverse: None,
            },
        },
        now_ms: 0,
    });
    assert!(
        matches!(e.as_slice(),[Effect::Emit{event:ServerEvent::Json{args,..},..}]if args[1]["error"]["code"]=="ACCESS_DENIED")
    );
}
