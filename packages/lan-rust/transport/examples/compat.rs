//! Finite external-client fixture, not a benchmark or production Core policy.
use bottleship_lan_core::wire::{Arg, ServerEvent};
use bottleship_lan_transport::*;
use serde_json::json;
use std::io::{self, Write};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    time::{Duration, timeout},
};
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let mut server = bind("127.0.0.1:0".parse().unwrap(), Config::default())
        .await
        .unwrap();
    println!("{}", json!({"listening":server.address.port()}));
    io::stdout().flush().unwrap();
    let mut stdin = BufReader::new(tokio::io::stdin()).lines();
    loop {
        tokio::select! {biased;
         line=stdin.next_line()=>{if !matches!(line,Ok(Some(_))){break}}
         incoming=server.incoming.recv()=>{
          let Some(incoming)=incoming else{break};
          let id=incoming.connection;
          match incoming.kind {
           IncomingKind::Authorize{auth,reply,..}=>{let _=reply.send(if auth.get("deny")==Some(&json!(true)){Err("Rejected".into())}else{Ok(())});}
           IncomingKind::Activated=>{let _=server.handle.try_emit(Egress{recipient:id,event:ServerEvent::Json{name:"ready",args:vec![json!({"connection":id})]},retained_bytes:0,reliable:true,sender:None});}
           IncomingKind::Message{name,args,..} if name=="frame"=>{
            if let Some(Arg::Binary(bytes))=args.first(){let _=server.handle.try_emit(Egress{recipient:id,event:ServerEvent::Frame{bytes:bytes.clone(),generation:None},retained_bytes:bytes.len(),reliable:false,sender:Some(id)});}
           }
           IncomingKind::Message{name,args,sequence} if matches!(name.as_str(),"openUdpHost"|"cancelUdpHost"|"releaseUdpHost")=>{
            // Test-only observation before Core capability/ownership policy.
            let args:Vec<_>=args.into_iter().map(|arg|match arg{Arg::Json(value)=>value,Arg::Binary(_)=>panic!("Host controls must be JSON in this fixture")}).collect();
            let _=server.handle.try_emit(Egress{recipient:id,event:ServerEvent::Json{name:"hostControlObserved",args:vec![json!({"sequence":sequence,"name":name,"args":args})]},retained_bytes:0,reliable:true,sender:None});
           }
           IncomingKind::Message{name,..} if name=="flood"=>{
            let mut accepted=0;let mut refused=false;
            loop{let result=server.handle.try_emit(Egress{recipient:id,event:ServerEvent::Frame{bytes:bytes::Bytes::from(vec![7;65552]),generation:None},retained_bytes:65552,reliable:true,sender:Some(id)});
             if result.is_err(){refused=true;break}accepted+=1;if accepted>=128{break}
            }
            let before=server.handle.metrics();let receipt=server.handle.abort(id,"Explicit fatal overflow").unwrap();
            let retired=timeout(Duration::from_secs(2),receipt.retired()).await.is_ok();
            let after=server.handle.metrics();
            println!("{}",json!({"flood":{"connection":id,"accepted":accepted,"refused":refused,"beforeRecords":before.output.records,"beforeBytes":before.output.bytes,"retired":retired,"afterRecords":after.output.records,"afterBytes":after.output.bytes}}));io::stdout().flush().unwrap();
           }
           IncomingKind::Closed{reason}=>{println!("{}",json!({"closed":{"connection":id,"reason":reason}}));io::stdout().flush().unwrap();}
           _=>{}
          }
         }
        }
    }
    timeout(Duration::from_secs(3), server.shutdown())
        .await
        .unwrap();
}
