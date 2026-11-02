# Engineioxide provenance and local changes

Upstream: https://github.com/totodore/socketioxide
Crate: engineioxide 0.17.7, MIT, crates.io archive SHA256
0235543b6e1a5fef2a8a7871ae410d5d1c440d8ced9217ec0f1b344edfe30673.
VCS commit: 708ea9fc5ee549229d7236924e4975ec5977a59c, crates/engineioxide.
Unmodified archive/source retained at logs/lan-conformance/rust-transport-spike/audit/.
The published crate omitted LICENSE. LICENSE was fetched from the exact VCS commit
root (SHA256 c2d36f491861e7d2a6c34f34b54dfb1b9aede4bc5db8f8c6fbe8310471b9c822).

This copy adds explicit public ownership hooks, not private-field access or unsafe:
- Socket::emit_tracked accepts an RAII DeliveryGuard with one atomic packet batch.
- Polling keeps the guard on a peeked batch or in Bytes::from_owner on encoded
  payload. HTTP Frame publication does not release a payload still owned by Hyper.
- WebSocket keeps guards until flush; every feed/flush is cancellation-aware.
  Fatal close drops the sink instead of waiting on flush/close of a slow consumer.
- Socket::force_close invalidates the Engine.IO session immediately even if full.
- Socket::retired observes queue drain and active WebSocket-task retirement.
- Closed queues are drained on retirement, releasing all queued guards.
- Engine.IO HTTP error JSON uses numeric protocol codes (0/1/2/3/5), preserving
  existing Engine.IO v4 client compatibility; unknown/stale SID returns code 1.

The LAN adapter uses the EngineIoHandler synchronous callbacks directly, avoiding
Socketioxide's unbounded per-message task spawning. It implements the root namespace
Socket.IO v5 LAN subset (connect/auth, disconnect, JSON and binary events). It does
not add application ACK messages or create arbitrary namespaces. Protocol v3 is
not enabled by the production adapter. Socketioxide is not vendored/linked.

Stock diagnostic report (including failures) is FINAL.md in the spike directory.
There are no performance claims from the stock debug echo fixtures.
