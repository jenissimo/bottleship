//! Finite, owner-controlled conformance launcher. The production CLI uses Ctrl-C.
use bottleship_lan::{LanServer, config::ServerConfig};
use std::{
    io::{BufRead, Write},
    time::Duration,
};
#[tokio::main(worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let mut config = if args.is_empty() {
        ServerConfig::default()
    } else {
        if args.len() != 2 || args[0] != "--config" {
            return Err("Usage: conformance-server [--config file.json]".into());
        }
        serde_json::from_slice(&std::fs::read(&args[1])?)?
    };
    config.port = 0;
    let server = LanServer::bind(config).await?;
    println!(
        "{}",
        serde_json::json!({"service":"bottleship-lan","version":1,"port":server.address.port(),"address":server.address.to_string()})
    );
    std::io::stdout().flush()?;
    let (send, receive) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let mut lines = std::io::stdin().lock().lines();
        let explicit = matches!(lines.next(),Some(Ok(line))if line=="shutdown");
        let _ = send.send(explicit);
    });
    let explicit = matches!(
        tokio::time::timeout(Duration::from_secs(90), receive).await,
        Ok(Ok(true))
    );
    server.shutdown().await?;
    println!(
        "{}",
        serde_json::json!({"retired":true,"explicit":explicit})
    );
    if explicit {
        Ok(())
    } else {
        Err("Conformance owner did not request shutdown before deadline/EOF".into())
    }
}
