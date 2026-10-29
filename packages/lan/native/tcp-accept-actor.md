# Source-stage framed TCP accept actor core

This is an isolated serial core, not an executable helper or production
transport. Its controller must serialize all calls. It is not yet safe to
advertise TCP listening: stdin/stdout framing and transport are absent, as are
non-inline urgent handling and integration with the
global quota arbiter.

## Frames

All integers are little endian except the raw IPv4 bytes in GRANT_RESULT.
Header: total length u32, version u8 = 1, opcode u8, reserved u16 = 0,
request ID u32, epoch u32. Incoming request IDs and epoch are nonzero.
Outgoing unsolicited NEED/ACK/FINISHED/READY have request ID zero. This is a
separate protocol from the single-socket `socket-helper.c`; do not feed one
helper's records to the other.

* READY: body port u32. NEED: empty; coalesced until a grant.
* GRANT: permit u64. GRANT_RESULT: status u32 (the TCP_ACCEPT result), permit
  u64, child u64, raw peer IPv4 (4 bytes), peer port u32.
* WRITE/URGENT: child u64, permit u64, nonzero opaque write ID u32, bytes.
  An ID is owned while queued or while its ACK remains in output; duplicate
  admission is fatal and has no side effects. Child identity scopes the ID.
  FIN: child u64, permit u64. CREDIT: child u64, permit u64, bytes u32.
* ACK/FINISHED: child u64, permit u64, write ID u32 (zero for FINISHED).
  DATA: child u64, permit u64, bytes; EOF: child u64, permit u64.
  CHILD_ERROR: child u64, permit u64, native error u32; physically closed.
* OPTION (control): child u64, permit u64, option u32, enabled u32.
  OPTION_DONE repeats child/permit/option and reports observed u32 and native
  error u32. Options 0,1,2 are OOBINLINE, KEEPALIVE and NODELAY. A successful
  setsockopt takes effect even if the subsequent getsockopt fails; on that
  error the reported observed value is unknown. OOBINLINE's internal mode
  commits the requested boolean immediately after successful setsockopt and
  is refined only after successful readback. KEEPALIVE/NODELAY may likewise
  already be applied when readback reports an error.
* CLOSE_CHILD: child u64, permit u64. CHILD_CLOSED repeats that pair.
  An already retired tuple receives CLOSE_RETIRED and never releases quota a
  second time. A late OPTION before its fence receives OPTION_DONE with error.
  CONTROL_FENCE on the control pipe follows all pending CLOSE/OPTION commands;
  FENCE_DONE confirms the tuple's control lane is drained. The parent must send
  no later commands for that tuple. BARRIER (data channel) follows its data,
  waits for FENCE_DONE and CLOSE, then BARRIER_DONE retires that tuple.
  STOP: empty. STOPPED: empty. Responses retain the initiating request ID.
  A GRANT previously issued after NEED can arrive after STOP; it returns
  UNUSED with the exact permit, without attempting accept.
* QUIESCE (data pipe, empty): sent only after STOPPED, every child close,
  control FENCE and data BARRIER, and every issued GRANT in data order.
  QUIESCED acknowledges this fence; the parent must send no later data.
  EXIT (control pipe, empty): sent after QUIESCED and no more controls.
  EXITING is the final event. Both pipes remain open until process exit.
  The process exits 0 only when EXITING and all preceding stdout bytes have
  been physically written. Premature QUIESCE/EXIT fails closed.

Output is a 64-frame FIFO. Before an accept, a send or close the core reserves
the ability to publish its result. A full child write queue also returns 0.
NEED is suppressed while every local slot is occupied or child IDs exhausted.
The data framer retains one blocked frame and applies backpressure without
terminating. STOP and CLOSE use a physically independent framed control channel;
two output slots are reserved for their responses. CLOSE cancels unacknowledged
writes for its exact child and permit, including a partially delivered data
frame completed later. A bounded table retains closed identities until a BARRIER
on the ordered data pipe is acknowledged. A barrier arriving before CLOSE waits
for it, and later data on a retired tuple is a protocol error. The parent must
stop writing data for a tuple before placing its barrier, and serialize all
calls through the framer and its capacity-aware listener poll: each live child
reserves space for a future tombstone, preventing exhaustion across concurrent
closes while allowing unlimited sequential closes. A production wrapper must
drain output or terminate on pipe failure, holding permits until process exit.
The two reserved slots handle a simultaneous STOP and CLOSE; additional control
responses wait for output drainage. The source-stage process wrappers are not
yet integrated or production-ready. A child close only produces a release
event after the real close succeeds. STOP closes the listener while admitted
children stay open. A fatal input, failed close, or RETAINED ends the actor;
parent retains uncertain permits through actual process exit. On EOF the
process wrapper must call abort and distinguish confirmed closes from uncertain
ownership. A late GRANT already serialized before QUIESCE receives UNUSED;
the parent must ensure there are no grants still being serialized afterward.

The future wrapper must bound partial input and output memory, handle short
writes, wake on control and sockets without polling, stop native work on output
failure, avoid unbounded threads and never claim that an in-memory abort means a
process has exited. Windows event handle limits and POSIX wake-pipe saturation
need explicit treatment. DATA reserves output capacity before native recv and
debits receive credit before publication. EOF is emitted once after recv(0),
which may wait for credit. Inline urgent bytes are normal DATA. Non-inline
urgent receive is unsupported: detected exceptional readiness ends the child
with an error. The readiness check and normal recv are not atomic, so this is
not a proven protection against a concurrently arriving urgent byte. Do not
advertise the feature until this race and urgent-mark semantics are solved.

The standalone test uses a real loopback listener and validates framed
admission, coalescing, output saturation and listener/child separation; it does
not exercise pipe fragmentation, OS wait integration, real data receive, or
process-exit behavior.
