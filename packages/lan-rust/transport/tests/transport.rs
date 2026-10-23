use bottleship_lan_core::wire::ServerEvent;
use bottleship_lan_transport::*;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::{Duration, timeout},
};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};
type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;
async fn ws_data(ws: &mut Ws) -> Message {
    loop {
        let msg = timeout(Duration::from_secs(2), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if matches!(&msg,Message::Text(s) if s.as_str()=="2") {
            ws.send(Message::Text("3".into())).await.unwrap();
            continue;
        }
        return msg;
    }
}
async fn item(server: &mut BoundTransport) -> Incoming {
    timeout(Duration::from_secs(2), server.incoming.recv())
        .await
        .unwrap()
        .unwrap()
}
async fn request(
    address: std::net::SocketAddr,
    method: &str,
    path: &str,
    body: &str,
    origin: Option<&str>,
) -> (u16, String) {
    let mut socket = TcpStream::connect(address).await.unwrap();
    let origin = origin
        .map(|o| format!("Origin: {o}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n{origin}Content-Type: text/plain\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut bytes = vec![];
    timeout(Duration::from_secs(2), socket.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    let all = String::from_utf8(bytes).unwrap();
    let (head, body) = all.split_once("\r\n\r\n").unwrap();
    (
        head.split_whitespace().nth(1).unwrap().parse().unwrap(),
        body.into(),
    )
}
async fn polling(server: &mut BoundTransport) -> (String, u64) {
    let (status, open) = request(
        server.address,
        "GET",
        "/socket.io/?EIO=4&transport=polling",
        "",
        None,
    )
    .await;
    assert_eq!(status, 200);
    let open: serde_json::Value = serde_json::from_str(&open[1..]).unwrap();
    let sid = open["sid"].as_str().unwrap().to_owned();
    let path = format!("/socket.io/?EIO=4&transport=polling&sid={sid}");
    assert_eq!(
        request(server.address, "POST", &path, "40{}", None).await.0,
        200
    );
    let auth = item(server).await;
    let id = auth.connection;
    if let IncomingKind::Authorize { reply, .. } = auth.kind {
        reply.send(Ok(())).unwrap()
    } else {
        panic!("Expected authorization")
    }
    let activated = item(server).await;
    assert!(matches!(activated.kind, IncomingKind::Activated));
    drop(activated);
    let mut connected = false;
    for _ in 0..3 {
        let ack = request(server.address, "GET", &path, "", None).await;
        assert_eq!(ack.0, 200);
        for packet in ack.1.split('\u{001e}') {
            if packet == "2" {
                assert_eq!(
                    request(server.address, "POST", &path, "3", None).await.0,
                    200
                )
            }
            if packet.starts_with("40{") {
                connected = true
            }
        }
        if connected {
            break;
        }
    }
    assert!(connected);
    (sid, id)
}
async fn websocket(server: &mut BoundTransport) -> (Ws, u64) {
    let (mut ws, _) = connect_async(format!(
        "ws://{}/socket.io/?EIO=4&transport=websocket",
        server.address
    ))
    .await
    .unwrap();
    assert!(
        ws.next()
            .await
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap()
            .starts_with("0{")
    );
    ws.send(Message::Text("40{}".into())).await.unwrap();
    let auth = item(server).await;
    let id = auth.connection;
    if let IncomingKind::Authorize { reply, .. } = auth.kind {
        reply.send(Ok(())).unwrap()
    } else {
        panic!()
    }
    let activated = item(server).await;
    assert!(matches!(activated.kind, IncomingKind::Activated));
    drop(activated);
    let ack = ws_data(&mut ws).await.into_text().unwrap();
    assert!(ack.starts_with("40{"));
    (ws, id)
}
#[tokio::test]
async fn polling_full_queue_abort_retires_exact_sid_and_releases_all_output() {
    let mut config = Config::default();
    config.output_records = 2;
    let mut server = bind("127.0.0.1:0".parse().unwrap(), config).await.unwrap();
    let (sid, id) = polling(&mut server).await;
    let mut tickets = vec![];
    for _ in 0..2 {
        tickets.push(
            server
                .handle
                .try_emit(Egress {
                    recipient: id,
                    event: ServerEvent::Frame {
                        bytes: Bytes::from(vec![7; 65552]),
                        generation: None,
                    },
                    retained_bytes: 65552,
                    reliable: true,
                    sender: Some(42),
                })
                .unwrap(),
        );
    }
    let failure = server
        .handle
        .try_emit(Egress {
            recipient: id,
            event: ServerEvent::Frame {
                bytes: Bytes::from_static(b"x"),
                generation: None,
            },
            retained_bytes: 1,
            reliable: true,
            sender: Some(42),
        })
        .unwrap_err();
    assert_eq!(failure.sender, Some(42));
    assert!(failure.reliable);
    assert_eq!(server.handle.metrics().output.records, 2);
    let receipt = server.handle.abort(id, "overflow").unwrap();
    assert!(
        server
            .handle
            .try_emit(Egress {
                recipient: id,
                event: ServerEvent::Frame {
                    bytes: Bytes::new(),
                    generation: None
                },
                retained_bytes: 0,
                reliable: false,
                sender: None
            })
            .is_err()
    );
    let path = format!("/socket.io/?EIO=4&transport=polling&sid={sid}");
    assert_eq!(request(server.address, "GET", &path, "", None).await.0, 400);
    timeout(Duration::from_secs(1), receipt.retired())
        .await
        .expect("physical retirement cannot wait for a reader");
    assert_eq!(server.handle.metrics().output.records, 0);
    assert_eq!(server.handle.metrics().output.bytes, 0);
    assert!(tickets.iter().all(DeliveryTicket::is_released));
    let closed = item(&mut server).await;
    assert_eq!(closed.connection, id);
    assert!(matches!(closed.kind, IncomingKind::Closed { .. }));
    drop(closed);
    server.shutdown().await;
}
#[tokio::test]
async fn ingress_is_ordered_and_overflow_never_spawns_waiting_handlers() {
    let mut config = Config::default();
    config.ingress_records = 2;
    let mut server = bind("127.0.0.1:0".parse().unwrap(), config).await.unwrap();
    let (mut ws, id) = websocket(&mut server).await;
    for n in 0..3 {
        ws.send(Message::Text(format!("42[\"event\",{n}]").into()))
            .await
            .unwrap();
    }
    let first = item(&mut server).await;
    let second = item(&mut server).await;
    let closed = item(&mut server).await;
    for (value, n) in [(&first, 1), (&second, 2)] {
        match &value.kind {
            IncomingKind::Message { sequence, args, .. } => {
                assert_eq!(*sequence, n);
                assert_eq!(args.len(), 1)
            }
            _ => panic!("Wrong event"),
        }
    }
    assert_eq!(server.handle.metrics().ingress.records, 2);
    assert_eq!(closed.connection, id);
    assert!(matches!(closed.kind, IncomingKind::Closed { .. }));
    drop((first, second, closed));
    assert_eq!(server.handle.metrics().ingress.records, 0);
    server.shutdown().await;
}
#[tokio::test]
async fn unauthorized_sessions_are_capped_before_sid_allocation_and_origin_is_enforced() {
    let mut config = Config::default();
    config.max_connections = 1;
    config.authorization_timeout = Duration::from_millis(200);
    config.origins = vec!["https://allowed.test".into()];
    let mut server = bind("127.0.0.1:0".parse().unwrap(), config).await.unwrap();
    assert_eq!(
        request(
            server.address,
            "GET",
            "/socket.io/?EIO=4&transport=polling",
            "",
            Some("https://denied.test")
        )
        .await
        .0,
        403
    );
    assert_eq!(server.handle.metrics().sessions, 0);
    assert_eq!(
        request(
            server.address,
            "GET",
            "/socket.io/?EIO=4&transport=polling",
            "",
            Some("https://allowed.test")
        )
        .await
        .0,
        200
    );
    assert_eq!(
        request(
            server.address,
            "GET",
            "/socket.io/?EIO=4&transport=polling",
            "",
            None
        )
        .await
        .0,
        503
    );
    assert_eq!(server.handle.metrics().sessions, 1);
    let close = item(&mut server).await;
    assert!(matches!(close.kind, IncomingKind::Closed { .. }));
    drop(close);
    timeout(Duration::from_secs(1), async {
        while server.handle.metrics().sessions != 0 {
            tokio::task::yield_now().await
        }
    })
    .await
    .unwrap();
    server.shutdown().await;
}
#[tokio::test]
async fn binary_payload_order_and_omitted_generation_survive_wire() {
    let mut server = bind("127.0.0.1:0".parse().unwrap(), Config::default())
        .await
        .unwrap();
    let (mut ws, id) = websocket(&mut server).await;
    ws.send(Message::Text(
        "451-[\"frame\",{\"_placeholder\":true,\"num\":0},null]".into(),
    ))
    .await
    .unwrap();
    ws.send(Message::Binary(Bytes::from_static(b"binary")))
        .await
        .unwrap();
    let received = item(&mut server).await;
    let IncomingKind::Message { args, .. } = &received.kind else {
        panic!()
    };
    assert_eq!(args.len(), 2);
    assert!(matches!(&args[0],bottleship_lan_core::wire::Arg::Binary(b) if &b[..]==b"binary"));
    assert!(matches!(
        &args[1],
        bottleship_lan_core::wire::Arg::Json(serde_json::Value::Null)
    ));
    drop(received);
    let ticket = server
        .handle
        .try_emit(Egress {
            recipient: id,
            event: ServerEvent::Frame {
                bytes: Bytes::from_static(b"reply"),
                generation: None,
            },
            retained_bytes: 5,
            reliable: false,
            sender: None,
        })
        .unwrap();
    let header = ws_data(&mut ws).await.into_text().unwrap();
    assert_eq!(header, "451-[\"frame\",{\"_placeholder\":true,\"num\":0}]");
    assert_eq!(
        ws_data(&mut ws).await.into_data(),
        Bytes::from_static(b"reply")
    );
    timeout(Duration::from_secs(1), ticket.released())
        .await
        .unwrap();
    let receipt = server.handle.abort(id, "test").unwrap();
    timeout(Duration::from_secs(1), receipt.retired())
        .await
        .unwrap();
    server.shutdown().await;
}

#[tokio::test]
async fn unknown_engine_sid_uses_numeric_protocol_error_code() {
    let server = bind("127.0.0.1:0".parse().unwrap(), Config::default())
        .await
        .unwrap();
    let (status, body) = request(
        server.address,
        "GET",
        "/socket.io/?EIO=4&transport=polling&sid=aaaaaaaaaaaaaaaa",
        "",
        None,
    )
    .await;
    assert_eq!(status, 400);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["code"], serde_json::json!(1));
    server.shutdown().await;
}
#[tokio::test]
async fn malformed_sid_never_allocates_a_replacement_session() {
    let server = bind("127.0.0.1:0".parse().unwrap(), Config::default())
        .await
        .unwrap();
    let (status, _) = request(
        server.address,
        "GET",
        "/socket.io/?EIO=4&transport=polling&sid=bad",
        "",
        None,
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(server.handle.metrics().sessions, 0);
    server.shutdown().await;
}
#[tokio::test]
async fn authorization_rejection_is_connect_error_before_physical_close() {
    let mut server = bind("127.0.0.1:0".parse().unwrap(), Config::default())
        .await
        .unwrap();
    let (mut ws, _) = connect_async(format!(
        "ws://{}/socket.io/?EIO=4&transport=websocket",
        server.address
    ))
    .await
    .unwrap();
    assert!(
        ws.next()
            .await
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap()
            .starts_with("0{")
    );
    ws.send(Message::Text("40{}".into())).await.unwrap();
    let auth = item(&mut server).await;
    if let IncomingKind::Authorize { reply, .. } = auth.kind {
        reply.send(Err("Denied by Core".into())).unwrap()
    } else {
        panic!()
    }
    let response = ws_data(&mut ws).await.into_text().unwrap();
    assert!(response.starts_with("44"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&response[2..]).unwrap()["message"],
        "Denied by Core"
    );
    let closed = item(&mut server).await;
    assert!(matches!(closed.kind, IncomingKind::Closed { .. }));
    server.shutdown().await;
}

#[tokio::test]
async fn logical_frame_budget_remains_separate_from_encoding_and_peek_ownership() {
    let mut server = bind("127.0.0.1:0".parse().unwrap(), Config::default())
        .await
        .unwrap();
    let (sid, id) = polling(&mut server).await;
    let mut tickets = vec![];
    for _ in 0..16 {
        tickets.push(
            server
                .handle
                .try_emit(Egress {
                    recipient: id,
                    event: ServerEvent::Frame {
                        bytes: Bytes::from(vec![9; 65536]),
                        generation: None,
                    },
                    retained_bytes: 65536,
                    reliable: true,
                    sender: None,
                })
                .unwrap(),
        );
    }
    assert!(
        server
            .handle
            .try_emit(Egress {
                recipient: id,
                event: ServerEvent::Frame {
                    bytes: Bytes::from_static(b"x"),
                    generation: None
                },
                retained_bytes: 1,
                reliable: true,
                sender: None
            })
            .is_err()
    );
    let path = format!("/socket.io/?EIO=4&transport=polling&sid={sid}");
    assert_eq!(request(server.address, "GET", &path, "", None).await.0, 200);
    assert_eq!(server.handle.metrics().output.records, 15);
    assert!(tickets[0].is_released());
    assert!(tickets[1..].iter().all(|t| !t.is_released()));
    let receipt = server.handle.abort(id, "Done").unwrap();
    // Native/Core cleanup can consume Closed before any blocked writer is awaited.
    let closed = server.incoming.try_recv().unwrap();
    assert!(matches!(closed.kind, IncomingKind::Closed { .. }));
    drop(closed);
    timeout(Duration::from_secs(1), receipt.retired())
        .await
        .unwrap();
    assert_eq!(server.handle.metrics().output, Usage::default());
    server.shutdown().await;
}
#[tokio::test]
async fn late_authorization_reply_cannot_activate_retired_connection() {
    let mut server = bind("127.0.0.1:0".parse().unwrap(), Config::default())
        .await
        .unwrap();
    let (mut ws, _) = connect_async(format!(
        "ws://{}/socket.io/?EIO=4&transport=websocket",
        server.address
    ))
    .await
    .unwrap();
    ws.next().await.unwrap().unwrap();
    ws.send(Message::Text("40{}".into())).await.unwrap();
    let auth = item(&mut server).await;
    let id = auth.connection;
    let receipt = server.handle.abort(id, "Abort authorization").unwrap();
    assert!(!server.handle.is_live(id));
    timeout(Duration::from_secs(1), receipt.retired())
        .await
        .unwrap();
    if let IncomingKind::Authorize { reply, .. } = auth.kind {
        let _ = reply.send(Ok(()));
    } else {
        panic!()
    }
    let close = item(&mut server).await;
    assert!(matches!(close.kind, IncomingKind::Closed { .. }));
    tokio::task::yield_now().await;
    assert!(server.incoming.try_recv().is_err());
    server.shutdown().await;
}
#[tokio::test]
async fn caller_health_response_does_not_create_engine_session() {
    let mut config = Config::default();
    config.health_response = Some(Bytes::from_static(
        br#"{"service":"bottleship-lan","version":1}"#,
    ));
    let server = bind("127.0.0.1:0".parse().unwrap(), config).await.unwrap();
    let (status, body) = request(server.address, "GET", "/health", "", None).await;
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["version"],
        1
    );
    assert_eq!(server.handle.metrics().sessions, 0);
    server.shutdown().await;
}
#[tokio::test]
async fn completed_binary_reservation_tracks_retained_bytes_across_a_tcp_window() {
    let mut server = bind("127.0.0.1:0".parse().unwrap(), Config::default())
        .await
        .unwrap();
    let (mut ws, id) = websocket(&mut server).await;
    let payload = Bytes::from(vec![0x5a; 16384 + 32]);
    for _ in 0..16 {
        ws.send(Message::Text(
            "451-[\"frame\",{\"_placeholder\":true,\"num\":0},11]".into(),
        ))
        .await
        .unwrap();
        ws.send(Message::Binary(payload.clone())).await.unwrap();
    }
    // Deliberately do not dequeue application events: all sixteen owned messages
    // must fit the advertised 256 KiB stream window plus bounded metadata.
    timeout(Duration::from_secs(2), async {
        while server.handle.is_live(id) && server.handle.metrics().ingress.records < 16 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let live = server.handle.is_live(id);
    let usage = server.handle.metrics().ingress;
    let mut messages = Vec::new();
    while let Ok(message) = server.incoming.try_recv() {
        messages.push(message);
    }
    server.shutdown().await;
    assert!(
        live,
        "a complete TCP window must not exhaust a 1 MiB ingress budget"
    );
    assert_eq!(usage.records, 16);
    assert!(
        usage.bytes < 400_000,
        "completed records retain actual bytes, not max attachments"
    );
    assert_eq!(messages.len(), 16);
    for (index, message) in messages.iter().enumerate() {
        match &message.kind {
            IncomingKind::Message { sequence, args, .. } => {
                assert_eq!(*sequence, index as u64 + 1);
                assert_eq!(
                    args[0],
                    bottleship_lan_core::wire::Arg::Binary(payload.clone())
                );
            }
            other => panic!("unexpected application event {other:?}"),
        }
    }
    drop(messages);
}

#[tokio::test]
async fn dropping_bound_transport_aborts_live_writers_and_releases_listener() {
    let mut config = Config::default();
    config.output_records = 2;
    let mut server = bind("127.0.0.1:0".parse().unwrap(), config).await.unwrap();
    let address = server.address;
    let (mut ws, id) = websocket(&mut server).await;
    let handle = server.handle.clone();
    let mut tickets = Vec::new();
    for _ in 0..2 {
        tickets.push(
            handle
                .try_emit(Egress {
                    recipient: id,
                    event: ServerEvent::Frame {
                        bytes: Bytes::from(vec![7; 65552]),
                        generation: None,
                    },
                    retained_bytes: 65552,
                    reliable: true,
                    sender: None,
                })
                .unwrap(),
        );
    }
    // No reads from the websocket, no explicit shutdown, and the public handle
    // remains alive. Owner destruction itself must fence admission synchronously.
    drop(server);
    let immediately_retired = !handle.is_live(id);
    let released = timeout(Duration::from_secs(2), async {
        while handle.metrics().tcp_connections != 0 || handle.metrics().output.records != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_ok();
    let rebound = tokio::net::TcpListener::bind(address).await;
    let _ = ws.close(None).await;
    // Keeps a RED execution bounded without hiding the recorded observations.
    handle.shutdown().await;
    assert!(immediately_retired, "Drop left a live Engine.IO epoch");
    assert!(released, "Drop left TCP/output ownership retained");
    assert!(tickets.iter().all(DeliveryTicket::is_released));
    assert!(rebound.is_ok(), "Drop detached the listening task");
}

#[tokio::test]
async fn health_is_never_cached() {
    let mut config = Config::default();
    config.health_response = Some(Bytes::from_static(b"{}"));
    let server = bind("127.0.0.1:0".parse().unwrap(), config).await.unwrap();
    let mut socket = TcpStream::connect(server.address).await.unwrap();
    socket
        .write_all(
            format!(
                "GET /health HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
                server.address
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut raw = Vec::new();
    timeout(Duration::from_secs(2), socket.read_to_end(&mut raw))
        .await
        .unwrap()
        .unwrap();
    let response = String::from_utf8(raw).unwrap().to_ascii_lowercase();
    server.shutdown().await;
    assert!(
        response
            .split("\r\n")
            .any(|line| line == "cache-control: no-store")
    );
}

#[tokio::test]
async fn incomplete_binary_is_bounded_and_retired_without_application_message() {
    let mut config = Config::default();
    config.binary_timeout = Duration::from_millis(20);
    let mut server = bind("127.0.0.1:0".parse().unwrap(), config).await.unwrap();
    let (mut ws, _) = websocket(&mut server).await;
    ws.send(Message::Text(
        "451-[\"frame\",{\"_placeholder\":true,\"num\":0}]".into(),
    ))
    .await
    .unwrap();
    let close = item(&mut server).await;
    assert!(matches!(close.kind, IncomingKind::Closed { .. }));
    assert_eq!(server.handle.metrics().ingress, Usage::default());
    server.shutdown().await;
}
