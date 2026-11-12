mod common;
use bottleship_lan_core::{*,config::*,routes::Routes,wire::InboundEvent};
use serde_json::json;

fn auth(id:u8,room:&str)->serde_json::Value {json!({"version":1,"room":room,"clientId":format!("participant-{id:08}"),"node":[2,0,0,0,0,id]})}
fn core(limits:Limits)->Core {common::core(limits,Routes::new(GatewayConfig::default()).unwrap()).unwrap()}
fn release(c:&mut Core,id:u64,proto:u8,port:u16,generation:u32)->Vec<Effect>{
    c.apply(Command::Input{connection:id,event:InboundEvent::ReleasePort{proto,port,generation},now_ms:0})
}
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
fn sr04_release_port_attack_has_per_peer_budget_and_releases_all_credits_on_retirement() {
    let mut c=core(Limits{max_bindings_per_peer:3,max_binding_entries:4,..Default::default()});
    c.join(1,&auth(1,"room"),0).unwrap();c.join(2,&auth(2,"room"),0).unwrap();
    for port in 1..=3 {assert!(!release(&mut c,2,port as u8,port,1).iter().any(|e|matches!(e,Effect::Disconnect{..})));}
    assert_eq!(c.binding_entry_count(),3);
    let effects=release(&mut c,2,4,4,1);
    assert!(effects.iter().any(|e|matches!(e,Effect::Disconnect{connection:2,..})));
    assert_eq!(c.binding_entry_count(),0);assert!(c.connection_node(1).is_some());
    c.join(3,&auth(3,"room"),0).unwrap();release(&mut c,3,0,1,1);
    assert_eq!(c.binding_entry_count(),1);
}
#[test]
fn sr04_global_budget_never_grows_and_failed_creator_does_not_retire_other_peers() {
    let mut c=core(Limits{max_bindings_per_peer:4,max_binding_entries:3,..Default::default()});
    c.join(1,&auth(1,"room"),0).unwrap();c.join(2,&auth(2,"room"),0).unwrap();
    release(&mut c,1,1,1000,1);release(&mut c,2,2,1001,1);release(&mut c,2,3,1002,1);
    assert_eq!(c.binding_entry_count(),3);
    release(&mut c,2,4,1003,1);
    assert_eq!(c.binding_entry_count(),1);assert!(c.connection_node(1).is_some());assert!(c.connection_node(2).is_none());
    c.apply(Command::Closed{connection:1,now_ms:0});assert_eq!(c.binding_entry_count(),0);
}
#[test]
fn tombstones_and_new_generations_share_one_budgeted_port_slot() {
    let mut c=core(Limits{max_bindings_per_peer:1,max_binding_entries:1,..Default::default()});
    c.join(1,&auth(1,"room"),0).unwrap();
    for generation in 1..100 {release(&mut c,1,1,1000,generation);}
    assert_eq!(c.binding_entry_count(),1);assert!(c.connection_node(1).is_some());
    release(&mut c,1,1,1001,1);assert!(c.connection_node(1).is_none());assert_eq!(c.binding_entry_count(),0);
}
