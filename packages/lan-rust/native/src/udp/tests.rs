use super::*;

#[tokio::test(start_paused = true)]
async fn healthy_udp_binding_has_no_global_idle_lifetime() {
    let (writer, mut frames) = mpsc::channel(321);
    let (io_sender, io) = mpsc::channel(32);
    let (command_sender, commands) = mpsc::channel(320);
    let (close, closing) = watch::channel(0);
    let (status, status_rx) = watch::channel(UdpStatus::default());
    let (rx, _received) = mpsc::channel(256);
    let (errors, _errors) = mpsc::channel(32);
    let (losses, mut observed) = watch::channel(UdpLosses::default());
    let mut driver = Driver {
        family: 4,
        generation: 7,
        next: 1,
        ending: false,
        close_sent: None,
        closed_seen: false,
        bound: None,
        peers: HashMap::new(),
        pending: HashMap::new(),
        credit_in_flight: false,
        receive_bytes: 0,
        receive_packets: 0,
        credits: Arc::new(CreditReturns {
            bytes: AtomicUsize::new(0),
            packets: AtomicUsize::new(0),
            wake: Notify::new(),
        }),
        writer,
        commands,
        closing,
        io,
        status,
        rx,
        errors,
        losses,
        last_losses: UdpLosses::default(),
        dropped_errors: Arc::new(AtomicU64::new(0)),
        tx: Budget::new(256, 262144),
        controls: Budget::new(63, 4032),
        options: UdpOptions::default(),
    };
    let peer = tokio::spawn(async move {
        let bind = frames.recv().await.unwrap();
        assert_eq!(bind[5], BIND);
        let mut ready = vec![0; 48];
        ready[0] = 4;
        ready[2..4].copy_from_slice(&2302u16.to_be_bytes());
        for (offset, value) in [
            (24, 0x3fu32),
            (28, 256),
            (32, 262144),
            (36, 256),
            (40, 64),
            (44, 128),
        ] {
            ready[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        io_sender
            .send(IoEvent::Frame {
                opcode: READY,
                id: word(&bind, 8),
                body: ready,
            })
            .await
            .unwrap();
        let credit = frames.recv().await.unwrap();
        assert_eq!(credit[5], CREDIT);
        io_sender
            .send(IoEvent::Frame {
                opcode: CREDIT_APPLIED,
                id: word(&credit, 8),
                body: credit[16..].to_vec(),
            })
            .await
            .unwrap();
        // A public loss observation is ordered after the credit ACK. Observing it
        // proves no operation deadline remains before advancing the fake clock.
        io_sender
            .send(IoEvent::Frame {
                opcode: LOSSES,
                id: 0,
                body: vec![0; 32],
            })
            .await
            .unwrap();
        std::future::pending::<()>().await;
    });
    let task = tokio::spawn(async move { driver.run().await });
    observed.changed().await.unwrap();
    assert!(status_rx.borrow().bound.is_some());
    tokio::time::advance(Duration::from_secs(24 * 3600)).await;
    tokio::task::yield_now().await;
    assert!(
        !task.is_finished(),
        "an idle native UDP socket must remain alive without an operation deadline"
    );
    close.send(2).unwrap();
    assert!(task.await.unwrap().is_ok());
    drop(command_sender);
    peer.abort();
    let _ = peer.await;
}
