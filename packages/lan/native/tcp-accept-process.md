# Experimental TCP accept process

This Windows-only process is a source-stage transport experiment. It is not a
complete TCP backend and must not be advertised or connected to production. It
does not implement non-inline urgent receive or POSIX. Inline urgent data and
per-child OOBINLINE/KEEPALIVE/NODELAY are experimental. Non-inline exception
readiness detection and recv are not atomic; urgent ordering is not proven. Its independent review is pending.

The actor is owned by the main thread. Two input reader threads use independent
OS pipes (stdin = data and an inherited HANDLE = control), each holding at most
one 4096-byte chunk; the incremental framers retain at most one additional
bounded frame per lane. A separate writer thread retains one bounded stdout
frame and does not retire its output record until the full physical WriteFile
has completed. Two output slots remain reserved for STOP/CLOSE responses.
Under blocked stdout the actor can still process those controls while slots are
available, but delivery waits for the parent to resume draining.

The Windows actor waits on a manual input/output wake event, a listener event and
at most 60 socket events; all accepted sockets remain owned by this process.
Event watches are keyed by socket plus exact child and permit so handle reuse
does not transfer identity. The limit is deliberate for WaitForMultipleObjects.
The wrapper requires a validated numeric IPv4 bind address and ACL.

EOF on either input, output-pipe failure, malformed protocol, native errors or
wait failure terminate the helper as a failure (exit code 1). EOF is not a
graceful shutdown request. The separate QUIESCE/EXIT protocol requires a
cooperating parent and exits 0 only after the final frame has been written;
integration review remains necessary. The process attempts to close its own sockets before
exit; failures and abrupt process exit do not imply confirmed individual
closes. The parent must retain every unconfirmed permit until it observes the
actual helper process exit. CHILD_CLOSED is emitted only after confirmed socket
close; STOP closes the listener while already accepted children remain live.
No caller may treat output EOF or an in-memory abort alone as process exit.

Windows test binaries execute the real helper with inherited OS pipes and a
loopback peer. One checks READY/NEED/GRANT, STOP with a live child, outbound
WRITE/ACK, CLOSE, BARRIER and input EOF followed by observed failure exit 1.
Receive coverage checks native DATA under credit, EOF after FIN and an isolated
reset of one child while another child and the listener remain usable. Another stops
draining stdout until the input writer blocks, then verifies STOP/CLOSE still
emerge after output is drained. These tests do not establish non-inline urgent receive parity, POSIX,
unexpected process kill, pipe close races, ACL policy integration or production
parent quota accounting.
