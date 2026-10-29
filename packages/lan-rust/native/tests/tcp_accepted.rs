use bottleship_lan_native::tcp::{NativeTcp, TcpOption, TcpOptions, TCP_WINDOW};
use std::{path::PathBuf, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::timeout,
};

async fn pair() -> (TcpStream, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = timeout(Duration::from_secs(2), TcpStream::connect(listener.local_addr().unwrap())).await.unwrap().unwrap();
    let (accepted, _) = timeout(Duration::from_secs(2), listener.accept()).await.unwrap().unwrap();
    (client, accepted)
}

#[tokio::test]
async fn accepted_stream_uses_actor_for_data_half_close_and_retirement() {
    let (mut peer, accepted) = pair().await;
    let (actor, mut events) = NativeTcp::from_accepted(accepted, TcpOptions::default()).unwrap();
    assert!(actor.status().connected);
    timeout(Duration::from_secs(2), actor.when_connected()).await.unwrap().unwrap();
    timeout(Duration::from_secs(2), actor.set_option(TcpOption::NoDelay, true)).await.unwrap().unwrap();
    assert!(actor.status().no_delay);
    match actor.try_write(&vec![0; TCP_WINDOW + 1]) {
        Err(error) => assert_eq!(error.code, 10055),
        Ok(_) => panic!("oversize write was admitted"),
    }
    match actor.try_urgent(7) {
        Err(error) => assert_eq!(error.code, 10045),
        Ok(_) => panic!("urgent write was admitted without helper"),
    }

    peer.write_all(b"peer-to-actor").await.unwrap();
    let mut inbound = Vec::new();
    while inbound.len() < b"peer-to-actor".len() {
        let read = timeout(Duration::from_secs(2), events.reads.recv()).await.unwrap().unwrap();
        inbound.extend_from_slice(read.data().unwrap());
    }
    assert_eq!(inbound, b"peer-to-actor");

    let ticket = actor.try_write(b"actor-to-peer").unwrap();
    timeout(Duration::from_secs(2), ticket.completion()).await.unwrap().unwrap();
    let mut received = [0u8; 13];
    timeout(Duration::from_secs(2), peer.read_exact(&mut received)).await.unwrap().unwrap();
    assert_eq!(&received, b"actor-to-peer");

    timeout(Duration::from_secs(2), actor.finish()).await.unwrap().unwrap();
    let mut end = [0u8; 1];
    assert_eq!(timeout(Duration::from_secs(2), peer.read(&mut end)).await.unwrap().unwrap(), 0);
    peer.shutdown().await.unwrap();
    timeout(Duration::from_secs(2), actor.wait_closed()).await.unwrap().unwrap();
    assert!(actor.status().closed);
    assert!(actor.status().remote_eof);
}

#[tokio::test]
async fn accepted_abort_retires_the_original_socket() {
    let (mut peer, accepted) = pair().await;
    let (actor, _events) = NativeTcp::from_accepted(accepted, TcpOptions::default()).unwrap();
    actor.abort();
    timeout(Duration::from_secs(2), actor.wait_closed()).await.unwrap().unwrap();
    let mut buffer = [0u8; 1];
    assert_eq!(timeout(Duration::from_secs(2), peer.read(&mut buffer)).await.unwrap().unwrap(), 0);
}

#[tokio::test]
async fn accepted_helper_and_inline_are_explicitly_unavailable() {
    for options in [
        TcpOptions { inline: true, ..TcpOptions::default() },
        TcpOptions { helper: Some(PathBuf::from("not-launched")), ..TcpOptions::default() },
        TcpOptions { timeout: Duration::ZERO, ..TcpOptions::default() },
    ] {
        let (mut peer, accepted) = pair().await;
        let expected = if options.timeout.is_zero() { 10022 } else { 10045 };
        let error = match NativeTcp::from_accepted(accepted, options) {
            Err(error) => error,
            Ok(_) => panic!("unsupported accepted-stream option was accepted"),
        };
        assert_eq!(error.code, expected);
        let mut buffer = [0u8; 1];
        assert_eq!(timeout(Duration::from_secs(2), peer.read(&mut buffer)).await.unwrap().unwrap(), 0);
    }
}
