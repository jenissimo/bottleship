# Bounded LAN Socket.IO transport

The crate implements the BottleShip LAN root namespace on Socket.IO v5 / Engine.IO
v4. It depends on the pure LAN core for wire types, not native gateway policy.
The TypeScript reference remains the compatibility reference. No throughput or
latency improvement is claimed by these debug functional fixtures.

Public API: src/lib.rs and src/runtime.rs.

- bind(address, config).await returns a bound address, clonable handle and bounded
  Incoming receiver. Config has explicit accepted TCP/session/request limits,
  authorization/header/binary deadlines, allowed transports and Origin policy.
- Authorize must be answered through its bounded oneshot before the namespace
  connect ACK. The caller validates/joins its Core here. Before joining it should
  also check handle.is_live(connection), since a queued request can be retired.
- Activated means the namespace ACK is already ordered in the Engine.IO queue.
  Core ready effects are held until this event. It is not a remote ACK.
- Message contains original argument arity, Arg::Json (including explicit null) and
  owned Arg::Binary. Omitted optional generation remains omitted. The caller holds
  the Incoming lease through synchronous decode/dispatch or through any queued
  ownership it deliberately retains; detached work must retain the item.
- try_emit validates and counts borrowed JSON before allocating serialized output,
  then reserves logical records/bytes and encoded bytes before the Engine.IO queue.
  OutputRejected preserves recipient, reliable flag and source participant for
  Core::DeliveryRejected. Raw frame bytes have a separate logical budget from
  base64/metadata and sink ownership.
- DeliveryTicket.released observes local ownership release on successful drain or
  discard. It proves neither remote receipt nor application processing.
- abort invalidates the connection and Engine.IO SID synchronously, independently
  of a full output queue. It queues Closed immediately. Native cleanup can start
  immediately and must not await CloseReceipt.
- CloseReceipt.retired separately observes WS transport task/queue retirement,
  registered TCP tasks and output lease release. shutdown also waits for earlier
  aborted connections through a bounded retirement registry. Dropping BoundTransport
  fences admission and aborts live epochs immediately; explicit shutdown additionally
  awaits listener/task retirement.
- Optional Config.health_response supplies a caller-owned JSON /health response.
  The adapter does not invent application version/service fields. Maximum 4096
  bytes, served with Cache-Control: no-store. CORS credentials are not enabled.

Ingress callbacks are synchronous EngineIoHandler calls. There is no task spawned
per application event and no semaphore awaited after an unbounded spawn. A parser
expansion reservation precedes serde allocation; retained JSON trees are charged
conservatively for Value/Vec/map/string storage. Binary bytes are copied into a
bounded owned extent after admission, avoiding retention of an opaque upstream
slab through a tiny Bytes slice. One incomplete binary packet per session has an
aggregate 65552-byte cap, at most eight arguments and a deadline. When all attachments
arrive, unused maximum-size reservation is released; completed messages keep actual
owned bytes and conservative metadata charged until their Incoming is dropped.

Default application queues are 64 records/1 MiB per connection. Encoded output has
its own 1.5 MB bound; global output has 8192 records/128 MiB including conservative
raw + encoded retention. Global ingress is 4096 records/64 MiB; parser reservations
share that budget. There are at most 256 session claims and 1024 accepted TCP
connections. A queued lifecycle event retains its session claim until consumed,
so an unresponsive application cannot turn successive rejected clients into an
unbounded queue. Protocol heartbeat/connect control has fixed extra queue slots.

The vendored Engineioxide 0.17.7 changes and exact upstream MIT provenance are in
vendor/UPSTREAM.md. Polling guards follow the rejected peek or encoded Bytes owner
through HTTP Body/Hyper. WS guards survive until flush or sink drop; every sink
await is cancellation-aware. Fatal retirement never awaits a blocked writer flush.

Validation retained under logs/lan-conformance/rust-transport-spike/:
stock source audit and exact-SID diagnostics; maintained Rust budget/codec/race and
actual loopback tests; external socket.io-client 4.8.4 forced polling, WS and
controlled same-SID upgrade with binary before/after; permanent no-GET polling and
paused real WS TCP reader, output refusal, immediate unknown SID and physical
retirement/output zero. These are functional ownership tests, not a benchmark.

Scope is the LAN root namespace. Arbitrary namespaces and application ACK callback
APIs are not exposed; no hidden wire ACK was added for queue accounting. TLS and
reverse-proxy policy belong to deployment. Full native gateway/room functionality
is integrated by the caller from the separate core/native/gateway crates.
