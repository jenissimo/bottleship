//! Real optional-helper TCP urgent/inline/options/ordered-FIN proof.
//! Uses the unchanged native test-peer C executable as independent observer.
use bottleship_lan_native::tcp::{NativeTcp, TcpOption, TcpOptions, TcpRead};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    time::timeout,
};
async fn case(helper: &str, peer: &str, inline: bool) -> Result<(), Box<dyn std::error::Error>> {
    let mut native = Command::new(peer)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let native_pid = native.id();
    let mut lines = BufReader::new(native.stdout.take().unwrap()).lines();
    let port: u16 = timeout(Duration::from_secs(4), lines.next_line())
        .await??
        .ok_or("Native peer did not publish port")?
        .parse()?;
    let (handle, mut events) = NativeTcp::start(
        format!("127.0.0.1:{port}").parse()?,
        TcpOptions {
            helper: Some(PathBuf::from(helper)),
            inline,
            ..TcpOptions::default()
        },
    )?;
    let helper_pid = handle.status().pid;
    println!(
        "TCP phase=start inline={inline} helper_pid={helper_pid:?} peer_pid={native_pid:?} port={port}"
    );
    let result = timeout(Duration::from_secs(12), async {
        handle.when_connected().await?;
        for enabled in [true, false, true] {
            handle.set_option(TcpOption::KeepAlive, enabled).await?;
            handle.set_option(TcpOption::NoDelay, enabled).await?;
            assert_eq!(handle.status().keep_alive, enabled);
            assert_eq!(handle.status().no_delay, enabled);
        }
        handle.set_option(TcpOption::Inline, !inline).await?;
        handle.set_option(TcpOption::Inline, inline).await?;
        assert_eq!(handle.status().inline, inline);
        let first = handle.try_write(b"ab")?;
        let urgent = handle.try_urgent(b'U')?;
        let last = handle.try_write(b"cd")?;
        first.completion().await?;
        urgent.completion().await?;
        last.completion().await?;
        let mut normal = Vec::new();
        let mut oob = Vec::new();
        while normal.len() < if inline { 5 } else { 4 } || (!inline && oob.is_empty()) {
            match events
                .reads
                .recv()
                .await
                .ok_or("TCP receive stream ended early")?
            {
                TcpRead::Data { bytes, .. } => normal.extend_from_slice(&bytes),
                TcpRead::Urgent { byte, .. } => oob.push(byte),
            }
        }
        assert_eq!(
            &normal[..],
            if inline { &b"abUcd"[..] } else { &b"abcd"[..] }
        );
        assert_eq!(&oob[..], if inline { &b""[..] } else { &b"U"[..] });
        handle.finish().await?;
        assert_eq!(handle.try_write(b"late").err().map(|e| e.code), Some(10058));
        handle.wait_closed().await?;
        let observation = lines
            .next_line()
            .await?
            .ok_or("Native peer did not publish final observation")?;
        assert_eq!(observation, r#"{"normal":4,"urgent":1,"byte":85}"#);
        assert!(native.wait().await?.success());
        println!("TCP inline={inline} PASS native={observation} helper_closed=true FIN=true");
        Ok::<_, Box<dyn std::error::Error>>(())
    })
    .await;
    handle.abort();
    let retired = timeout(Duration::from_secs(4), handle.wait_closed()).await;
    if native.try_wait()?.is_none() {
        let _ = native.start_kill();
        let _ = native.wait().await;
    }
    result??;
    retired??;
    Ok(())
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("Usage: tcp_helper_probe socket-helper native-test-peer".into());
    }
    case(&args[1], &args[2], false).await?;
    case(&args[1], &args[2], true).await?;
    Ok(())
}
