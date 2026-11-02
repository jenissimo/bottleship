use bottleship_lan_core::{config::*, gateway::*, routes::*, wire::*, *};
use bytes::Bytes;
use serde_json::{json, Value};
use std::net::SocketAddrV4;

#[test]
fn tcp_listener_capability_is_opt_in_and_describes_exact_acl() {
    let auth = json!({"version":1,"room":"capability","clientId":"capability-client-000001","node":[2,0,0,0,0,3]});
    let mut empty = Core::new(Limits::default(), Routes::new(GatewayConfig::default()).unwrap()).unwrap();
    let ready = empty.join(1,&auth,0).unwrap();
    assert!(named(&ready,"ready")[0][0].get("tcpHostListenV1").is_none());

    let config: GatewayConfig = serde_json::from_value(json!({"tcpListeners":[
        {"id":"first","bindHost":"127.0.0.1","advertisedHost":"127.0.0.1","port":0,"allowedHosts":["127.0.0.1","192.0.2.7"]},
        {"id":"second","bindHost":"127.0.0.1","advertisedHost":"127.0.0.1","port":0,"allowedHosts":["198.51.100.8"]}
    ]})).unwrap();
    let mut configured = Core::new(Limits::default(), Routes::new(config).unwrap()).unwrap();
    let ready = configured.join(1,&auth,0).unwrap();
    assert_eq!(named(&ready,"ready")[0][0]["tcpHostListenV1"],json!({"listeners":[
        {"id":"first","allowedNodes":[[2,1,127,0,0,1],[2,1,192,0,2,7]]},
        {"id":"second","allowedNodes":[[2,1,198,51,100,8]]}
    ]}));
}

fn core() -> Core {
    let config:GatewayConfig = serde_json::from_value(json!({"tcpListeners":[{
        "id":"native","bindHost":"127.0.0.1","advertisedHost":"127.0.0.1",
        "port":0,"allowedHosts":["127.0.0.1"]}]})).unwrap();
    let mut c=Core::new(Limits::default(),Routes::new(config).unwrap()).unwrap();
    let ready=c.join(1,&json!({"version":1,"room":"host","clientId":"host-participant-00000001","node":[2,0,0,0,0,1]}),0).unwrap();
    assert_eq!(named(&ready,"ready")[0][0]["tcpHostListenV1"], json!({"listeners":[{"id":"native","allowedNodes":[[2,1,127,0,0,1]]}]}));
    c
}
fn named(e:&[Effect], name:&str)->Vec<Vec<Value>> {
    e.iter().filter_map(|e| match e {
        Effect::Emit {event:ServerEvent::Json{name:n,args},..} if *n == name => Some(args.clone()), _=>None
    }).collect()
}
fn input(c:&mut Core,event:InboundEvent)->Vec<Effect> {
    c.apply(Command::Input{connection:1,event,now_ms:0})
}
fn native(c:&mut Core,event:GatewayEvent)->Vec<Effect> {
    c.apply(Command::GatewayEvent{connection:1,event})
}
fn open(c:&mut Core,id:u32,g:u32)->(u64,BindingToken) {
    input(c,InboundEvent::OpenTcpHost{id,request:TcpHostRequest{
        proto:2,local_port:2000,binding_generation:g,listener_id:"native".into()
    }}).into_iter().find_map(|e| match e {
        Effect::NativeOperation{input:GatewayInput::OpenTcpListener{operation_id,binding,..},..}=>Some((operation_id,binding)),
        _=>None
    }).unwrap()
}
fn ready(c:&mut Core,op:u64,b:BindingToken,lease:u64)->Vec<Effect> {
    native(c,GatewayEvent::TcpListenerReady{operation_id:op,lease_id:lease,binding:b,
        address:"127.0.0.1:45678".parse::<SocketAddrV4>().unwrap()})
}
fn frame(node:Node,src:u16,dst:u16)->Datagram {
    Datagram{proto:2,node,src_port:src,dst_port:dst,payload:TcpFrame{
        kind:if src == 2000 {2} else {1},src_id:if src == 2000 {10} else {9},dst_id:if src == 2000 {9} else {0},value:0,data:Bytes::new()
    }.encode()}
}
fn offer(c:&mut Core,b:BindingToken,lease:u64,remote:u16,id:u32)->Vec<Effect> {
    native(c,GatewayEvent::TcpListenerFrame{lease_id:lease,binding:b,datagram:Datagram {
        proto:2,node:[2,1,127,0,0,1],src_port:remote,dst_port:2000,
        payload:TcpFrame {kind:1,src_id:id,dst_id:0,value:0,data:Bytes::new()}.encode()
    }})
}
#[test]
fn listener_is_opt_in_and_routes_only_owned_generation_and_acl() {
    let mut c=core();
    let (op,b)=open(&mut c,1,1);
    let response=ready(&mut c,op,b,41);
    assert_eq!(named(&response,"tcpHostOpened")[0][1]["address"]["port"],45678);
    let inbound=frame([2,1,127,0,0,1],3000,2000);
    let e=offer(&mut c,b,41,3000,9);
    assert!(e.iter().any(|e|matches!(e,Effect::Emit{event:ServerEvent::Frame{generation:Some(1),..},reliable:true,..})));
    let outbound=|node| InboundEvent::Frame{datagram:frame(node,2000,3000),generation:Some(1)};
    let e=input(&mut c,outbound([2,1,127,0,0,1]));
    assert!(e.iter().any(|e|matches!(e,Effect::NativeOperation{
        input:GatewayInput::TcpListenerFrame{lease_id:41,binding,..},..} if *binding==b)));
    assert_eq!(named(&input(&mut c,outbound([2,1,127,0,0,2])),"socketError")[0][0]["code"],10013);
    assert!(native(&mut c,GatewayEvent::TcpListenerFrame{lease_id:42,binding:b,datagram:inbound.clone()}).is_empty());
    assert!(native(&mut c,GatewayEvent::Frame{binding:b,datagram:inbound}).is_empty());
}
#[test]
fn cancel_and_rebinding_retire_only_the_original_native_identity() {
    let mut c=core();
    let (op,b)=open(&mut c,1,1);
    let e=input(&mut c,InboundEvent::CancelTcpHost{id:1});
    assert!(e.iter().any(|e|matches!(e,Effect::NativeOperation{input:GatewayInput::CancelOperation{operation},..} if *operation==op)));
    let late=ready(&mut c,op,b,41);
    assert!(late.iter().any(|e|matches!(e,Effect::NativeOperation{input:GatewayInput::CloseTcpListener{lease_id:41},..})));
    assert!(named(&late,"tcpHostOpened").is_empty());
    let (op2,b2)=open(&mut c,2,2);
    ready(&mut c,op2,b2,42);
    let e=input(&mut c,InboundEvent::ReleasePort{proto:2,port:2000,generation:1});
    assert!(!e.iter().any(|e|matches!(e,Effect::NativeOperation{input:GatewayInput::CloseTcpListener{lease_id:42},..})));
    let e=input(&mut c,InboundEvent::ReleasePort{proto:2,port:2000,generation:2});
    assert!(e.iter().any(|e|matches!(e,Effect::NativeOperation{input:GatewayInput::CloseTcpListener{lease_id:42},..})));
    assert!(native(&mut c,GatewayEvent::TcpListenerFrame{lease_id:42,binding:b2,datagram:frame([2,1,127,0,0,1],3000,2000)}).is_empty());
}

#[test]
fn accepted_child_survives_listener_release_and_stale_frames_are_rejected() {
    let mut c=core();
    let (op,b)=open(&mut c,1,1);
    ready(&mut c,op,b,41);
    let key=TcpChildKey{lease_id:41,binding:b,node:[2,1,127,0,0,1],
        remote_port:3000,native_id:9,guest_id:10};
    offer(&mut c,b,41,3000,9);
    input(&mut c,InboundEvent::Frame{datagram:frame(key.node,2000,3000),generation:Some(1)});
    assert!(native(&mut c,GatewayEvent::TcpChildEstablished{key}).is_empty());
    let e=input(&mut c,InboundEvent::ReleaseTcpHost{id:1});
    assert!(e.iter().any(|e|matches!(e,Effect::NativeOperation{input:GatewayInput::CloseTcpListener{lease_id:41},..})));
    let data=Datagram{proto:2,node:key.node,src_port:2000,dst_port:3000,payload:TcpFrame{
        kind:3,src_id:10,dst_id:9,value:0,data:Bytes::from_static(b"child")}.encode()};
    let e=input(&mut c,InboundEvent::Frame{datagram:data.clone(),generation:Some(1)});
    assert!(e.iter().any(|e|matches!(e,Effect::NativeOperation{input:GatewayInput::TcpChildFrame{key:k,..},..} if *k==key)));
    let reply=Datagram{src_port:3000,dst_port:2000,payload:TcpFrame{
        kind:3,src_id:9,dst_id:10,value:0,data:Bytes::from_static(b"reply")}.encode(),..data};
    let e=native(&mut c,GatewayEvent::TcpChildFrame{key,datagram:reply.clone()});
    assert!(e.iter().any(|e|matches!(e,Effect::Emit{event:ServerEvent::Frame{..},..})));
    let forged=TcpChildKey{native_id:11,..key};
    assert!(native(&mut c,GatewayEvent::TcpChildFrame{key:forged,datagram:reply.clone()}).is_empty());
    native(&mut c,GatewayEvent::TcpChildClosed{key});
    assert!(native(&mut c,GatewayEvent::TcpChildFrame{key,datagram:reply}).is_empty());
    let late=native(&mut c,GatewayEvent::TcpChildEstablished{key});
    assert!(late.iter().any(|e|matches!(e,Effect::NativeOperation{input:GatewayInput::CloseTcpChild{key:k},..} if *k==key)));
}

#[test]
fn synack_reserves_child_before_immediate_data_and_fin_and_failure_rolls_back() {
    let mut c=core();
    let (op,b)=open(&mut c,1,1);
    ready(&mut c,op,b,41);
    let key=TcpChildKey{lease_id:41,binding:b,node:[2,1,127,0,0,1],remote_port:3000,native_id:9,guest_id:10};
    offer(&mut c,b,41,3000,9);
    let synack=input(&mut c,InboundEvent::Frame{datagram:frame(key.node,2000,3000),generation:Some(1)});
    assert!(synack.iter().any(|e|matches!(e,Effect::NativeOperation{input:GatewayInput::TcpListenerFrame{lease_id:41,..},..})));
    for kind in [3,4] {
        let d=Datagram{proto:2,node:key.node,src_port:2000,dst_port:3000,payload:TcpFrame{
            kind,src_id:10,dst_id:9,value:0,data:if kind==3 {Bytes::from_static(b"early")} else {Bytes::new()}
        }.encode()};
        let e=input(&mut c,InboundEvent::Frame{datagram:d,generation:Some(1)});
        assert!(e.iter().any(|e|matches!(e,Effect::NativeOperation{input:GatewayInput::TcpChildFrame{key:k,..},..} if *k==key)));
    }
    native(&mut c,GatewayEvent::TcpChildEstablished{key});
    native(&mut c,GatewayEvent::TcpListenerClosed{lease_id:41,code:10054});
    let d=Datagram{proto:2,node:key.node,src_port:3000,dst_port:2000,payload:TcpFrame{
        kind:4,src_id:9,dst_id:10,value:0,data:Bytes::new()}.encode()};
    assert!(native(&mut c,GatewayEvent::TcpChildFrame{key,datagram:d}).iter().any(|e|matches!(e,Effect::Emit{event:ServerEvent::Frame{..},..})));
    native(&mut c,GatewayEvent::TcpChildClosed{key});
    assert!(native(&mut c,GatewayEvent::TcpChildEstablished{key}).iter().any(|e|
        matches!(e,Effect::NativeOperation{input:GatewayInput::CloseTcpChild{key:k},..} if *k==key)));
}

#[test]
fn malformed_synack_never_reserves_children_and_listener_reset_allows_zero_source() {
    let mut c=core();
    let (op,b)=open(&mut c,1,1);
    ready(&mut c,op,b,41);
    offer(&mut c,b,41,3000,9);
    for id in 1..=65 {
        let d=Datagram{proto:2,node:[2,1,127,0,0,1],src_port:2000,dst_port:3000,payload:TcpFrame{
            kind:2,src_id:id,dst_id:9,value:0,data:Bytes::from_static(b"bad")}.encode()};
        let effects=input(&mut c,InboundEvent::Frame{datagram:d,generation:Some(1)});
        assert!(!effects.iter().any(|e|matches!(e,Effect::NativeOperation{input:GatewayInput::TcpListenerFrame{..},..})));
    }
    let valid=input(&mut c,InboundEvent::Frame{datagram:frame([2,1,127,0,0,1],2000,3000),generation:Some(1)});
    assert!(valid.iter().any(|e|matches!(e,Effect::NativeOperation{input:GatewayInput::TcpListenerFrame{lease_id:41,..},..})));
    offer(&mut c,b,41,3001,99);
    let reset=Datagram{proto:2,node:[2,1,127,0,0,1],src_port:2000,dst_port:3001,payload:TcpFrame{
        kind:5,src_id:0,dst_id:99,value:10061,data:Bytes::new()}.encode()};
    let effects=input(&mut c,InboundEvent::Frame{datagram:reset,generation:Some(1)});
    assert!(effects.iter().any(|e|matches!(e,Effect::NativeOperation{input:GatewayInput::TcpListenerFrame{lease_id:41,..},..})));
}

#[test]
fn only_an_exact_unexpired_offer_can_reserve_one_child() {
    let mut c=core();
    let (op,b)=open(&mut c,1,1); ready(&mut c,op,b,41);
    let synack=|guest:u32,native_id:u32,remote:u16| InboundEvent::Frame{
        generation:Some(1),datagram:Datagram{proto:2,node:[2,1,127,0,0,1],src_port:2000,dst_port:remote,
            payload:TcpFrame{kind:2,src_id:guest,dst_id:native_id,value:0,data:Bytes::new()}.encode()}};
    let forwarded=|effects:&[Effect]| effects.iter().any(|e|matches!(e,Effect::NativeOperation{
        input:GatewayInput::TcpListenerFrame{..},..}));
    assert!(!forwarded(&input(&mut c,synack(10,9,3000))));
    assert!(!offer(&mut c,b,41,3000,9).is_empty());
    assert!(!forwarded(&input(&mut c,synack(10,9,3001))));
    assert!(!forwarded(&input(&mut c,synack(10,8,3000))));
    assert!(forwarded(&input(&mut c,synack(10,9,3000))));
    assert!(!forwarded(&input(&mut c,synack(11,9,3000))));
    // Replayed native SYN cannot recreate the consumed offer.
    assert!(offer(&mut c,b,41,3000,9).is_empty());
    let key=TcpChildKey{lease_id:41,binding:b,node:[2,1,127,0,0,1],remote_port:3000,native_id:9,guest_id:10};
    native(&mut c,GatewayEvent::TcpOfferClosed{key:TcpOfferKey{lease_id:41,binding:b,node:key.node,remote_port:3000,native_id:9}});
    assert!(native(&mut c,GatewayEvent::TcpChildEstablished{key}).is_empty());

    assert!(!offer(&mut c,b,41,3001,10).is_empty());
    let expired=TcpOfferKey{lease_id:41,binding:b,node:key.node,remote_port:3001,native_id:10};
    native(&mut c,GatewayEvent::TcpOfferClosed{key:expired});
    assert!(!forwarded(&input(&mut c,synack(12,10,3001))));
    assert!(offer(&mut c,b,41,3001,10).is_empty());
}
#[test]
fn releasing_listener_discards_its_unconsumed_offer_but_not_an_established_child() {
    let mut c=core();
    let (op,b)=open(&mut c,1,1); ready(&mut c,op,b,41);
    offer(&mut c,b,41,3000,9);
    input(&mut c,InboundEvent::Frame{datagram:frame([2,1,127,0,0,1],2000,3000),generation:Some(1)});
    let child=TcpChildKey{lease_id:41,binding:b,node:[2,1,127,0,0,1],remote_port:3000,native_id:9,guest_id:10};
    native(&mut c,GatewayEvent::TcpChildEstablished{key:child});
    offer(&mut c,b,41,3001,10);
    input(&mut c,InboundEvent::ReleaseTcpHost{id:1});
    let d=Datagram{proto:2,node:child.node,src_port:3000,dst_port:2000,
        payload:TcpFrame{kind:3,src_id:9,dst_id:10,value:0,data:Bytes::from_static(b"live")}.encode()};
    assert!(native(&mut c,GatewayEvent::TcpChildFrame{key:child,datagram:d}).iter().any(|e|
        matches!(e,Effect::Emit{event:ServerEvent::Frame{..},..})));
    let late=Datagram{proto:2,node:child.node,src_port:2000,dst_port:3001,
        payload:TcpFrame{kind:2,src_id:11,dst_id:10,value:0,data:Bytes::new()}.encode()};
    assert!(!input(&mut c,InboundEvent::Frame{datagram:late,generation:Some(1)}).iter().any(|e|
        matches!(e,Effect::NativeOperation{input:GatewayInput::TcpListenerFrame{..},..})));
}

#[test]
fn timeout_delivers_exact_reset_before_offer_closed_even_after_listener_close() {
    let mut c=core();
    let (op,b)=open(&mut c,1,1); ready(&mut c,op,b,41);
    offer(&mut c,b,41,3000,9);
    let key=TcpOfferKey{lease_id:41,binding:b,node:[2,1,127,0,0,1],remote_port:3000,native_id:9};
    let reset=Datagram{proto:2,node:key.node,src_port:key.remote_port,dst_port:2000,
        payload:TcpFrame{kind:5,src_id:9,dst_id:0,value:10060,data:Bytes::new()}.encode()};
    let e=native(&mut c,GatewayEvent::TcpListenerFrame{lease_id:41,binding:b,datagram:reset.clone()});
    assert!(e.iter().any(|e|matches!(e,Effect::Emit{event:ServerEvent::Frame{generation:Some(1),..},..})));
    native(&mut c,GatewayEvent::TcpOfferClosed{key});
    assert!(native(&mut c,GatewayEvent::TcpListenerFrame{lease_id:41,binding:b,datagram:reset}).is_empty());

    offer(&mut c,b,41,3001,10);
    let second=TcpOfferKey{remote_port:3001,native_id:10,..key};
    input(&mut c,InboundEvent::ReleaseTcpHost{id:1});
    let reset=Datagram{proto:2,node:key.node,src_port:3001,dst_port:2000,
        payload:TcpFrame{kind:5,src_id:10,dst_id:0,value:10054,data:Bytes::new()}.encode()};
    assert!(native(&mut c,GatewayEvent::TcpListenerFrame{lease_id:41,binding:b,datagram:reset}).iter()
        .any(|e|matches!(e,Effect::Emit{event:ServerEvent::Frame{..},..})));
    native(&mut c,GatewayEvent::TcpOfferClosed{key:second});
}
#[test]
fn overflow_cancels_exact_unpublished_offer_immediately() {
    let mut c=core();
    let (op,b)=open(&mut c,1,1); ready(&mut c,op,b,41);
    for id in 1..=64 {
        assert!(offer(&mut c,b,41,3000,id).iter().any(|e|
            matches!(e,Effect::Emit{event:ServerEvent::Frame{..},..})));
    }
    let key=TcpOfferKey{lease_id:41,binding:b,node:[2,1,127,0,0,1],remote_port:3001,native_id:65};
    let e=offer(&mut c,b,41,3001,65);
    assert!(e.iter().any(|e|matches!(e,Effect::NativeOperation{input:GatewayInput::CancelTcpOffer{key:k},..} if *k==key)));
    assert!(!e.iter().any(|e|matches!(e,Effect::Emit{event:ServerEvent::Frame{..},..})));
    assert!(offer(&mut c,b,41,3001,65).is_empty());
}
#[test]
fn synack_then_expiry_reject_reset_and_child_closed_retire_provisional_once() {
    let mut c=core();
    let (op,b)=open(&mut c,1,1); ready(&mut c,op,b,41);
    offer(&mut c,b,41,3000,9);
    let offer_key=TcpOfferKey{lease_id:41,binding:b,node:[2,1,127,0,0,1],remote_port:3000,native_id:9};
    input(&mut c,InboundEvent::Frame{datagram:frame(offer_key.node,2000,3000),generation:Some(1)});
    let child=TcpChildKey{lease_id:41,binding:b,node:offer_key.node,remote_port:3000,native_id:9,guest_id:10};
    let timeout_reset=Datagram{proto:2,node:offer_key.node,src_port:3000,dst_port:2000,
        payload:TcpFrame{kind:5,src_id:9,dst_id:0,value:10060,data:Bytes::new()}.encode()};
    assert!(native(&mut c,GatewayEvent::TcpListenerFrame{lease_id:41,binding:b,datagram:timeout_reset}).iter()
        .any(|e|matches!(e,Effect::Emit{event:ServerEvent::Frame{..},..})));
    native(&mut c,GatewayEvent::TcpOfferClosed{key:offer_key});
    let reset=Datagram{proto:2,node:offer_key.node,src_port:3000,dst_port:2000,
        payload:TcpFrame{kind:5,src_id:9,dst_id:10,value:10054,data:Bytes::new()}.encode()};
    assert!(native(&mut c,GatewayEvent::TcpListenerFrame{lease_id:41,binding:b,datagram:reset}).iter()
        .any(|e|matches!(e,Effect::Emit{event:ServerEvent::Frame{..},..})));
    native(&mut c,GatewayEvent::TcpChildClosed{key:child});
    assert!(native(&mut c,GatewayEvent::TcpChildEstablished{key:child}).iter().any(|e|
        matches!(e,Effect::NativeOperation{input:GatewayInput::CloseTcpChild{key},..} if *key==child)));
}
