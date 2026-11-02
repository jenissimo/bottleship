//! Owned loopback integration of the synchronous Core with a real Gateway actor.
use bottleship_lan_core::{
    Command, Core, Effect, GatewayEvent, GatewayInput, InboundEvent, ServerEvent, TcpChildKey,
    config::{GatewayConfig, Limits}, gateway::{BindingToken, DestinationPolicy},
    routes::Routes, wire::{Datagram, Node, TCP_WINDOW, TcpFrame, TcpHostRequest},
};
use bottleship_lan_gateway::{Gateway, GatewayEvents, GatewayHandle, GatewayOptions};
use bytes::Bytes;
use serde_json::json;
use std::{net::SocketAddrV4, sync::{Arc, Mutex}, time::Duration};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpStream, time::timeout};

struct Stop(GatewayHandle);
impl Drop for Stop { fn drop(&mut self) { self.0.abort(); } }

fn dispatch(handle:&GatewayHandle,effects:Vec<Effect>)->Vec<ServerEvent> {
    let mut emitted=Vec::new();
    for effect in effects {
        match effect {
            Effect::NativeOperation{connection:1,input} => handle.try_submit(input).unwrap(),
            Effect::Emit{to:1,event,..} => emitted.push(event),
            other => panic!("unexpected Core effect: {other:?}"),
        }
    }
    emitted
}
fn apply(core:&mut Core,handle:&GatewayHandle,event:InboundEvent)->Vec<ServerEvent> {
    dispatch(handle,core.apply(Command::Input{connection:1,event,now_ms:0}))
}
async fn receive(core:&mut Core,handle:&GatewayHandle,events:&mut GatewayEvents)->(GatewayEvent,Vec<ServerEvent>) {
    let output=timeout(Duration::from_secs(4),events.outputs.recv()).await.unwrap().expect("gateway closed");
    assert_eq!(output.connection,1);
    let event=output.event.clone();
    let emitted=dispatch(handle,core.apply(Command::GatewayEvent{connection:1,event:event.clone()}));
    // The output permit/receive credit stays held until Core effects have been submitted.
    drop(output);
    (event,emitted)
}
fn guest(node:Node,remote_port:u16,native_id:u32,kind:u32,data:&'static [u8])->InboundEvent {
    InboundEvent::Frame { generation:Some(1), datagram:Datagram {
        proto:2,node,src_port:2000,dst_port:remote_port,
        payload:TcpFrame{kind,src_id:77,dst_id:native_id,value:if kind==2 {TCP_WINDOW} else {0},
            data:Bytes::from_static(data)}.encode(),
    }}
}
fn emitted_frame(events:&[ServerEvent])->Option<TcpFrame> {
    events.iter().find_map(|e| match e {
        ServerEvent::Frame{bytes,generation:Some(1)} => {
            let d=Datagram::decode(bytes.clone()).unwrap();
            Some(TcpFrame::decode(d.payload).unwrap())
        },
        _=>None
    })
}
#[tokio::test]
async fn core_listener_keeps_established_child_after_real_listener_close() {
    let config:GatewayConfig=serde_json::from_value(json!({"tcpListeners":[{
        "id":"owned","bindHost":"127.0.0.1","advertisedHost":"127.0.0.1","port":0,
        "allowedHosts":["127.0.0.1"],"maxPending":8}]})).unwrap();
    let mut core=Core::new(Limits::default(),Routes::new(config.clone()).unwrap()).unwrap();
    core.join(1,&json!({"version":1,"room":"test","clientId":"owned-participant-00000001","node":[2,0,0,0,0,1]}),0).unwrap();
    let policy=Arc::new(Mutex::new(DestinationPolicy::default()));
    let (handle,mut events)=Gateway::spawn(1,config,policy.clone(),GatewayOptions::default()).unwrap();
    let _stop=Stop(handle.clone());
    let binding=BindingToken{proto:2,local_port:2000,generation:Some(1)};
    let start=core.apply(Command::Input{connection:1,now_ms:0,event:InboundEvent::OpenTcpHost{
        id:1,request:TcpHostRequest{proto:2,local_port:2000,binding_generation:1,listener_id:"owned".into()}}});
    assert!(start.iter().any(|e|matches!(e,Effect::NativeOperation{
        input:GatewayInput::OpenTcpListener{binding:b,..},..} if *b==binding)));
    dispatch(&handle,start);
    let (event,opened)=receive(&mut core,&handle,&mut events).await;
    let (lease,address)=match event {
        GatewayEvent::TcpListenerReady{lease_id,binding:b,address,..} => { assert_eq!(b,binding); (lease_id,address) },
        other=>panic!("expected listener READY: {other:?}"),
    };
    assert_ne!(lease,0);
    assert!(opened.iter().any(|e|matches!(e,ServerEvent::Json{name:"tcpHostOpened",..})));
    let address:SocketAddrV4=address;
    let mut peer=timeout(Duration::from_secs(4),TcpStream::connect(address)).await.unwrap().unwrap();
    let peer_port=peer.local_addr().unwrap().port();
    let (event,syn_effects)=receive(&mut core,&handle,&mut events).await;
    match event {
        GatewayEvent::TcpListenerFrame{lease_id,binding:b,ref datagram} => {
            assert_eq!((lease_id,b,datagram.src_port),(lease,binding,peer_port));
        }
        other=>panic!("expected native SYN: {other:?}"),
    }
    let syn=emitted_frame(&syn_effects).expect("Core must deliver real SYN");
    assert_eq!((syn.kind,syn.dst_id),(1,0));
    assert_ne!(syn.src_id,0);
    let node=[2,1,127,0,0,1];
    let key=TcpChildKey{lease_id:lease,binding,node,remote_port:peer_port,native_id:syn.src_id,guest_id:77};

    // Both inputs are queued before the Established event is received by Core.
    assert!(apply(&mut core,&handle,guest(node,peer_port,syn.src_id,2,b"")).is_empty());
    assert!(apply(&mut core,&handle,guest(node,peer_port,syn.src_id,3,b"early")).is_empty());
    let (event,_)=receive(&mut core,&handle,&mut events).await;
    assert!(matches!(event,GatewayEvent::TcpChildEstablished{key:k} if k==key));
    let mut buf=[0;5];
    timeout(Duration::from_secs(4),peer.read_exact(&mut buf)).await.unwrap().unwrap();
    assert_eq!(&buf,b"early");

    // Listener public lease 1 is distinct from the native lease and owns no child.
    apply(&mut core,&handle,InboundEvent::ReleaseTcpHost{id:1});
    apply(&mut core,&handle,guest(node,peer_port,syn.src_id,3,b"after"));
    timeout(Duration::from_secs(4),peer.read_exact(&mut buf)).await.unwrap().unwrap();
    assert_eq!(&buf,b"after");
    peer.write_all(b"reply").await.unwrap();
    let mut received=Vec::new();
    timeout(Duration::from_secs(4),async {
        while received.len()<5 {
            let (event,out)=receive(&mut core,&handle,&mut events).await;
            if let GatewayEvent::TcpChildFrame{key:k,..}=event { assert_eq!(k,key); }
            if let Some(f)=emitted_frame(&out) {
                if f.kind==3 {
                    received.extend_from_slice(&f.data);
                    let credit=Datagram{proto:2,node,src_port:2000,dst_port:peer_port,payload:TcpFrame{
                        kind:6,src_id:77,dst_id:syn.src_id,value:f.data.len() as u32,data:Bytes::new()}.encode()};
                    apply(&mut core,&handle,InboundEvent::Frame{datagram:credit,generation:Some(1)});
                } else if f.kind==5 { panic!("unexpected reset {}",f.value); }
            }
        }
    }).await.unwrap();
    assert_eq!(received,b"reply");

    apply(&mut core,&handle,guest(node,peer_port,syn.src_id,4,b""));
    let mut eof=[0;1];
    assert_eq!(timeout(Duration::from_secs(4),peer.read(&mut eof)).await.unwrap().unwrap(),0);
    peer.shutdown().await.unwrap();
    let mut saw_fin=false;
    let mut saw_closed=false;
    timeout(Duration::from_secs(4),async {
        while !saw_fin || !saw_closed {
            let (event,out)=receive(&mut core,&handle,&mut events).await;
            if let GatewayEvent::TcpChildClosed{key:k}=event { assert_eq!(k,key); saw_closed=true; }
            if let Some(f)=emitted_frame(&out) {
                if f.kind==4 { saw_fin=true; }
                if f.kind==5 { panic!("unexpected reset {}",f.value); }
            }
        }
    }).await.unwrap();
    apply(&mut core,&handle,InboundEvent::ReleasePort{proto:2,port:2000,generation:1});
    dispatch(&handle,core.apply(Command::Closed{connection:1,now_ms:0}));
    timeout(Duration::from_secs(4),handle.wait_closed()).await.unwrap().unwrap();
    assert_eq!(policy.lock().unwrap().active_leases(),0);
}
