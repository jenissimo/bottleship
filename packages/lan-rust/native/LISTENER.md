# Native UDP Host listener

This is the low-level IPv4 socket capability from plan/udp-host-listener-v1.md.
It does not itself authorize a room, create a Socket.IO lease, select a DirectPlay
provider, or enable the default guest TCP/IP Host.

API: `listener::NativeUdpListener::start(ListenerConfig)` returns the clonable
handle and `ListenerEvents { datagrams, status, losses }`. `when_ready()` returns
`ListenerReady { bound, advertised }` only after the actual kernel bind.
The advertised port is the actual bound port, including an ephemeral port.
The caller explicitly supplies the advertised unicast IPv4 address.

Configuration has a numeric IPv4 bind, up to 32 distinct permitted source IPs,
at most 128 learned peers, idle/startup/send deadlines, and separate TX/RX record
and payload-byte limits. Queue metadata is additionally bounded by those record
limits. Process-wide listener/room limits belong to Core/Gateway.

Peers are learned only from real received packets whose source IP is permitted.
No dummy packet is sent. A `ListenerPeer { id, epoch, endpoint }` identifies one
exact source tuple in one physical listener lifetime. IDs never repeat within
that listener; its process-wide epoch never repeats. A stale/expired/foreign
token cannot admit a new tuple. Successful TX and real RX refresh an existing
peer's idle activity; expired peers require a new real RX.
`peer_for_endpoint(endpoint)` returns a live exact token without admitting a tuple
or refreshing its idle deadline. Gateway can avoid a second stale peer table;
`try_send` still revalidates the token under the admission lock.

`try_send(peer, bytes)` reserves records and bytes before copying/queueing.
`ListenerTicket::completion()` reports native acceptance/error, not remote
receipt. A completed native datagram is never retransmitted by this adapter.
Empty packets still consume a record. A full queue returns 10055 without an
unbounded waiting task. Each accepted TX has a deadline that includes queue time.

A `ListenerDatagram` owns its RX credit until the consumer drops the envelope.
Keep that envelope alive while retaining/cloning its `bytes` in another bounded
queue. Overflow drops unreliable input and coalesces counters in a watch value.
An unconnected OS ICMP receive error is counted as unattributed; it is not assigned
to whichever peer most recently sent. This is not a claim of platform ICMP parity.

`abort()` fences admission synchronously and wakes startup/read/write waits
independently of queue capacity. `close()/wait_closed()` acknowledge only after
the actual UDP socket has been dropped and queued TX cancelled. Already delivered
RX envelopes may remain owned by the consumer and remain charged after close.
Dropping the last public handle or the RX receiver also retires the socket.

The integration must await READY and publish its matching HostReady control event
before forwarding datagrams from `ListenerEvents`. Core owns authenticated
participant identity, request/binding generation, cancellation and late-READY
rejection. Gateway must retain the RX envelope through downstream admission.
Listener peer tokens are internal authority metadata, not an unauthenticated wire
permission.

Validation: native/tests/listener.rs uses actual ephemeral loopback sockets for
no-dummy behavior, empty/maximum datagrams, source ACL, exact tuple/native source
port, peer limits/expiry/epoch replacement, RX/TX ownership, startup cancellation,
bind conflict, listener/consumer destruction, and physical port reclamation.
These are functional tests, not a benchmark or a complete browser Host proof.
