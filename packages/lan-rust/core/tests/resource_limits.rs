mod common;
use bottleship_lan_core::{*,config::*,routes::Routes,wire::{Datagram,InboundEvent}};
use serde_json::json;

fn auth(id:u8,room:&str)->serde_json::Value {json!({"version":1,"room":room,"clientId":format!("participant-{id:08}"),"node":[2,0,0,0,0,id]})}
fn core(limits:Limits)->Core {common::core(limits,Routes::new(GatewayConfig::default()).unwrap()).unwrap()}
fn release(c:&mut Core,id:u64,proto:u8,port:u16,generation:u32)->Vec<Effect>{
    c.apply(Command::Input{connection:id,event:InboundEvent::ReleasePort{proto,port,generation},now_ms:0})
}
/// A live generation-tracked UDP binding (relay to node 1).
fn live(c:&mut Core,id:u64,port:u16,generation:u32)->Vec<Effect>{
    let datagram=Datagram{proto:1,node:[2,0,0,0,0,1],dst_port:9,src_port:port,payload:bytes::Bytes::from_static(b"x")};
    c.apply(Command::Input{connection:id,event:InboundEvent::Frame{datagram,generation:Some(generation)},now_ms:0})
}
fn retired(e:&[Effect],id:u64)->bool{e.iter().any(|e|matches!(e,Effect::Disconnect{connection,..} if *connection==id))}
fn forgot(e:&[Effect],p:u8,q:u16)->bool{e.iter().any(|e|matches!(e,Effect::NativeOperation{input:GatewayInput::ForgetPort{proto,port},..} if *proto==p && *port==q))}
#[test]
fn sr03_offline_room_flood_never_evicts_live_room_or_blocks_new_membership() {
    let mut c=core(Limits{max_rooms:2,max_offline_rooms:1,..Default::default()});
    c.join(1,&auth(1,"live"),0).unwrap();
    for id in 2..=100u64 {
        c.join(id,&auth(2,&format!("flood-{id}")),id).unwrap();
        c.apply(Command::Closed{connection:id,now_ms:id});
        assert!(c.room_count()<=2);assert_eq!(c.connection_node(1),Some([2,0,0,0,0,1]));
    }
    c.join(200,&auth(3,"legitimate"),200).unwrap();
    assert!(c.join(201,&auth(4,"overflow"),201).is_err());
    assert_eq!(c.participant_count(),2);
}
#[test]
fn sr03_room_pressure_evicts_only_offline_peers_and_retains_unpressured_ownership() {
    let mut c=core(Limits{max_peers_per_room:2,..Default::default()});
    c.join(1,&auth(1,"room"),0).unwrap();c.join(2,&auth(2,"room"),0).unwrap();
    c.apply(Command::Closed{connection:2,now_ms:1});
    let mut forged=auth(2,"room");forged["clientId"]=json!("different-client-0000");
    assert!(c.join(3,&forged,2).is_err());
    c.join(4,&auth(3,"room"),3).unwrap();
    assert!(c.join(5,&auth(4,"room"),4).is_err());
    assert_eq!(c.connection_node(1),Some([2,0,0,0,0,1]));
    assert_eq!(c.connection_node(4),Some([2,0,0,0,0,3]));
}
#[test]
fn sr04_release_flood_recycles_own_tombstones_and_live_slots_are_the_hard_budget() {
    let mut c=core(Limits{max_bindings_per_peer:3,max_binding_entries:Some(4),..Default::default()});
    c.join(1,&auth(1,"room"),0).unwrap();c.join(2,&auth(2,"room"),0).unwrap();
    // Releases never retire: the oldest own tombstone is reclaimed instead.
    for port in 1..=1000u16 {let e=release(&mut c,2,(port%8) as u8,port,1);assert!(!retired(&e,2),"release {port}");}
    assert_eq!(c.binding_entry_count(),3);
    // Live bindings cannot be reclaimed: a fourth live port retires its creator only.
    for port in 2001..=2003 {assert!(!retired(&live(&mut c,2,port,1),2));}
    assert!(retired(&live(&mut c,2,2004,1),2));
    assert_eq!(c.binding_entry_count(),0);assert!(c.connection_node(1).is_some());
    c.join(3,&auth(3,"room"),0).unwrap();release(&mut c,3,0,1,1);
    assert_eq!(c.binding_entry_count(),1);
}
#[test]
fn sr04_default_global_budget_cannot_be_exhausted_by_peers_within_their_own_budget() {
    // The server derives the unset global budget from its connection cap.
    let peers=4;
    let mut limits=Limits{max_bindings_per_peer:8,..Default::default()};
    assert_eq!(limits.max_binding_entries,None);
    limits.max_binding_entries=Some(limits.binding_entry_budget(peers));
    assert_eq!(limits.max_binding_entries,Some(32));
    let mut c=core(limits);
    for id in 1..=peers as u64 {c.join(id,&auth(id as u8,"room"),0).unwrap();}
    // Three attackers hold every live slot their own budget allows and churn releases.
    for attacker in 2..=4u64 {
        for port in 1..=7u16 {assert!(!retired(&live(&mut c,attacker,port,1),attacker));}
        for port in 100..400u16 {assert!(!retired(&release(&mut c,attacker,2,port,1),attacker));}
    }
    // The honest player can still use its whole budget.
    for port in 1..=8u16 {assert!(!retired(&live(&mut c,1,port,1),1),"honest port {port}");}
    assert!(c.connection_node(1).is_some());
    assert_eq!(c.binding_entry_count(),32);
}
#[test]
fn sr04_explicit_global_budget_reclaims_creators_tombstone_or_retires_only_the_creator() {
    let mut c=core(Limits{max_bindings_per_peer:4,max_binding_entries:Some(3),..Default::default()});
    c.join(1,&auth(1,"room"),0).unwrap();c.join(2,&auth(2,"room"),0).unwrap();
    live(&mut c,1,1000,1);live(&mut c,2,1001,1);release(&mut c,2,2,1002,1);
    assert_eq!(c.binding_entry_count(),3);
    let e=release(&mut c,2,3,1003,1);
    assert!(!retired(&e,2));assert!(forgot(&e,2,1002));assert_eq!(c.binding_entry_count(),3);
    live(&mut c,2,1004,1);
    // 1003 was reclaimed; nothing of peer 2 is released any more.
    let e=live(&mut c,2,1005,1);
    assert!(retired(&e,2));
    assert_eq!(c.binding_entry_count(),1);assert!(c.connection_node(1).is_some());assert!(c.connection_node(2).is_none());
    c.apply(Command::Closed{connection:1,now_ms:0});assert_eq!(c.binding_entry_count(),0);
}
#[test]
fn tombstones_and_new_generations_share_one_budgeted_port_slot() {
    let mut c=core(Limits{max_bindings_per_peer:1,max_binding_entries:Some(1),..Default::default()});
    c.join(1,&auth(1,"room"),0).unwrap();
    for generation in 1..100 {release(&mut c,1,1,1000,generation);}
    assert_eq!(c.binding_entry_count(),1);assert!(c.connection_node(1).is_some());
    // A new port reclaims the released slot (and tells the gateway to forget it).
    let e=release(&mut c,1,1,1001,1);
    assert!(!retired(&e,1));assert!(forgot(&e,1,1000));assert_eq!(c.binding_entry_count(),1);
    // A live generation pins its slot: the next new port cannot reclaim it.
    assert!(!retired(&live(&mut c,1,1001,2),1));
    assert!(retired(&release(&mut c,1,1,1002,1),1));
    assert_eq!(c.binding_entry_count(),0);
}
#[test]
fn ephemeral_port_cycling_never_retires_an_honest_peer() {
    // The guest allocator cycles 16384 ephemeral ports per protocol; every closed
    // socket leaves a tombstone. Far more sockets than the per-peer budget are fine.
    let mut c=core(Limits{max_bindings_per_peer:64,..Default::default()});
    c.join(1,&auth(1,"room"),0).unwrap();
    let mut generation=0u32;
    for i in 0..20000u32 {
        let port=49152+(i%16384) as u16;generation+=1;
        let now=u64::from(i/500)*1000;
        let datagram=Datagram{proto:1,node:[2,0,0,0,0,1],dst_port:9,src_port:port,payload:bytes::Bytes::from_static(b"x")};
        let a=c.apply(Command::Input{connection:1,event:InboundEvent::Frame{datagram,generation:Some(generation)},now_ms:now});
        let b=c.apply(Command::Input{connection:1,event:InboundEvent::ReleasePort{proto:1,port,generation},now_ms:now});
        assert!(!retired(&a,1)&&!retired(&b,1),"socket {i}");
    }
    assert!(c.binding_entry_count()<=64);
}
