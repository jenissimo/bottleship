# Source-stage POSIX TCP actor process

This is not connected to production and must not be advertised. It uses one
serial actor thread and nonblocking POSIX stdin (data), an inherited descriptor
(control), and stdout (events). Each input lane holds at most 4096 bytes in
addition to one bounded framer record. Stdout is retired only after the actual
short or complete write. `poll` watches input/output pipes, listener and active
sockets. The wrapper accepts up to 128 children, subject to the existing actor
and owner limits, without Windows' 60-event wait ceiling.

The command arguments are numeric bind IPv4, port, numeric ACL IPv4, child
limit, epoch and inherited control fd. Signals from a broken output pipe are
ignored so that the wrapper can fail and close owned sockets. The parent must
hold any unconfirmed permit until the helper process is actually reaped; EOF
on either pipe, output failure or an internal fatal error is an abnormal exit 1.
The explicit QUIESCE/EXIT protocol described in tcp-accept-actor.md provides
source-stage graceful exit 0 after all final frames have been written. It
requires a cooperating parent and still needs integration review.

The actor's existing listener/receive paths still use `select` and impose
`FD_SETSIZE` restrictions on actual descriptor values. The wrapper itself
uses `poll`; this does not remove that actor limitation. Non-inline urgent
receive is unsupported, and the non-atomic exception/recv race remains open.
This wrapper does not establish POSIX parity on all operating systems: the
only current run is Ubuntu 24.04 in WSL on the remote device. Full integration,
policy quota ownership, graceful shutdown integration, socket errors and close races require
additional independent review and end-to-end tests.

The WSL -Werror run checked real forked helper and pipes, outbound and inbound
loopback data, STOP/CLOSE/FENCE/BARRIER, 70 simultaneous accepted children,
and STOP/CLOSE during stdout pressure. A separate run closed the data pipe with
a live child and checked observed process exit 1 and remote socket EOF.
`POLLHUP` is latched for credit-exhausted children. If a pending send remains
blocked after HUP, the socket is temporarily excluded from poll and retried
after a 50 ms monotonic deadline; the control pipe stays active. A failed or
unrepresentable monotonic clock produces abnormal process exit, not retry.
Deterministic injected HUP/blocked-send and clock-failure tests verify bounded
iterations, process cleanup, CLOSE and an
unaffected second child. A separate real Ubuntu WSL loopback test half-closes
the peer's send direction, fills the non-reading peer's native send path until
ACK stalls, closes that child through control, and verifies a second child
still exchanges data. Broader OS-specific behavior remains unproven.
