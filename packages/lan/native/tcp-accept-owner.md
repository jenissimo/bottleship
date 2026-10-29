# TCP pre-accept ownership component

This is a source-stage component, not a transport or advertised capability.
The parent must use a single quota arbiter across outbound connections and all
listener helpers. A listener calls `tcp_accept_readable` without a permit; only
after readiness does the arbiter issue one monotonically unique nonzero permit.
`tcp_accept_grant` performs at most one nonblocking `accept` while holding that
permit. UNUSED and REFUSED_CLOSED return the permit; ADMITTED transfers it to the
exact child; RETAINED requires termination of the owned helper and retention of
the permit until actual process exit. Listener stop does not close admitted
children. Never retry failed close on a possibly reused Unix descriptor.

The next helper process layer must preserve these ownership rules:

* Reliable, bounded binary control records carry listener epoch, child ID and
  permit ID. A NEED response is valid only for a currently readable listener,
  is coalesced, and never retains a quota permit while idle.
* A grant is consumed once; a stale, cancelled or unused grant is explicitly
  returned. A granted accept racing with shutdown keeps its permit until the
  child descriptor is closed or the process actually exits.
* READY precedes publishing offers. ACL rejection closes its accepted socket
  before returning the permit. Rejecting a malformed or stale message must not
  close another listener/child or release another permit.
* Each accepted child keeps the socket in the same helper process across listener
  closure. The future data path needs bounded multiplexed DATA, urgent data,
  FIN, read-credit and write-ack ownership; accepted sockets cannot be handed to
  another Windows process as ordinary Unix file descriptors.
* Output backpressure is bounded and reliable. If the controller cannot admit
  a required event, close the owning helper and retain every still-held permit
  until its actual process/pipe close. Input EOF and parent shutdown must close
  only the helper's own sockets.
* Windows must wake on both input and socket events; Unix must use a bounded
  wake pipe and poll/select. Reuse the platform ownership principles in
  `udp-bound-helper.c`, not a busy polling loop.

`test-tcp-accept-owner.c` is a loopback component test: single-slot pressure,
monotonic permit and exact close, listener/child lifetime separation and a
rejected ACL. It is not evidence of an integrated TypeScript server, transport
fallback, urgent-data parity or a full concurrent physical-socket quota.
