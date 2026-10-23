use super::*;

#[tokio::test(start_paused = true)]
async fn healthy_tcp_helper_has_no_global_idle_lifetime() {
    let (writer, mut output) = mpsc::channel(321);
    let (send, events) = mpsc::channel(32);
    let (commands, input) = mpsc::channel(321);
    let (cancel, cancelling) = watch::channel(false);
    let (status, mut observed) = watch::channel(TcpStatus::default());
    let (reads, _reads) = mpsc::channel(256);
    let common = Arc::new(Common {
        status,
        cancel: cancel.clone(),
        tx: Budget::new(256, TCP_WINDOW),
        controls: Budget::new(63, 8192),
        reads,
        wake: Arc::new(Notify::new()),
    });
    let mut driver = Driver {
        common,
        input,
        cancel: cancelling,
        writer,
        events,
        writes: HashMap::new(),
        options: HashMap::new(),
        finish: None,
        next: 1,
        credits: Arc::new(Returns {
            bytes: AtomicUsize::new(TCP_WINDOW),
        }),
        read_budget: Budget::new(256, TCP_WINDOW),
        receive_credit: 0,
        credit_pending: false,
        timeout: Duration::from_secs(10),
        startup: None,
        closed_seen: false,
    };
    let peer = tokio::spawn(async move {
        let credit = output.recv().await.unwrap();
        assert!(credit.credit);
        send.send(Event::CreditWritten).await.unwrap();
        send.send(Event::Frame(10, vec![])).await.unwrap();
        let mut option = 2u32.to_le_bytes().to_vec();
        option.extend_from_slice(&1u32.to_le_bytes());
        send.send(Event::Frame(20, option)).await.unwrap();
        std::future::pending::<()>().await;
    });
    let task = tokio::spawn(async move { driver.run().await });
    while !observed.borrow().no_delay {
        observed.changed().await.unwrap();
    }
    assert!(observed.borrow().connected);
    tokio::time::advance(Duration::from_secs(24 * 3600)).await;
    tokio::task::yield_now().await;
    assert!(
        !task.is_finished(),
        "an idle healthy TCP helper must not expire"
    );
    cancel.send(true).unwrap();
    assert!(task.await.unwrap().is_ok());
    drop(commands);
    peer.abort();
    let _ = peer.await;
}
