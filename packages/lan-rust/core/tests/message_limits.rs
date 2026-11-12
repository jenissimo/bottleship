mod common;
use bottleship_lan_core::{*,config::*,routes::Routes};
use serde_json::json;
fn core(limits:Limits)->Core {
 let mut c=common::core(limits,Routes::new(GatewayConfig::default()).unwrap()).unwrap();
 c.join(1,&json!({"version":1,"room":"room","clientId":"synthetic-client-01","node":[2,0,0,0,0,1]}),0).unwrap();c
}
#[test]
fn sr06_unknown_malformed_dns_and_cancel_messages_all_share_one_budget() {
 for (name,args) in [
  ("unknown",vec![]),
  ("resolve",vec![Arg::Json(json!(1)),Arg::Json(json!({"host":"unknown.test","family":4}))]),
  ("resolve",vec![Arg::Json(json!(1)),Arg::Json(json!({"host":null}))]),
  ("cancelResolve",vec![Arg::Json(json!(1))]),
  ("cancelResolve",vec![Arg::Json(json!("invalid"))]),
  ("openUdpHost",vec![Arg::Json(json!(1)),Arg::Json(json!({}))]),
 ] {
  let mut c=core(Limits{max_frames_per_second:3,..Default::default()});
  for id in 1..=3 {let mut args=args.clone();if name=="openUdpHost"{args[0]=Arg::Json(json!(id));}c.apply(Command::Wire{connection:1,name:name.into(),args,now_ms:0});}
  assert!(c.connection_node(1).is_some(),"{name}");
  let e=c.apply(Command::Wire{connection:1,name:name.into(),args,now_ms:0});
  assert!(e.iter().any(|e|matches!(e,Effect::Disconnect{connection:1,..})),"{name}");
 }
}
#[test]
fn sr06_unknown_binary_and_unicode_json_count_bytes_and_rate_window_resets() {
 let args=vec![Arg::Json(json!("é".repeat(80))),Arg::Binary(bytes::Bytes::from(vec![0;128]))];
 let mut c=core(Limits{max_bytes_per_second:256,..Default::default()});
 c.apply(Command::Wire{connection:1,name:"unknown".into(),args,now_ms:0});
 assert!(c.connection_node(1).is_none());
 let mut c=core(Limits{max_frames_per_second:1,..Default::default()});
 for now_ms in [0,1000,2000] {c.apply(Command::Wire{connection:1,name:"unknown".into(),args:vec![],now_ms});}
 assert!(c.connection_node(1).is_some());
}
