/* Source-stage single-threaded TCP listener actor core. Apache-2.0. */
#ifndef BOTTLESHIP_TCP_ACCEPT_ACTOR_H
#define BOTTLESHIP_TCP_ACCEPT_ACTOR_H
#include "tcp-accept-flow.h"
#define TCP_ACTOR_OUTPUTS 64u
#define TCP_ACTOR_NORMAL_OUTPUTS (TCP_ACTOR_OUTPUTS-2u)
#define TCP_ACTOR_HEADER 16u
#define TCP_ACTOR_BODY_MAX (16u+TCP_FLOW_SEGMENT)
#define TCP_ACTOR_FRAME_MAX (TCP_ACTOR_HEADER+16u+4u+TCP_FLOW_SEGMENT)
enum tcp_actor_command {
    TCP_ACTOR_GRANT=1, TCP_ACTOR_WRITE=2, TCP_ACTOR_URGENT=3,
    TCP_ACTOR_FIN=4, TCP_ACTOR_CREDIT=5, TCP_ACTOR_CLOSE_CHILD=6,
    TCP_ACTOR_STOP=7, TCP_ACTOR_BARRIER=8, TCP_ACTOR_OPTION=9, TCP_ACTOR_CONTROL_FENCE=10,
    TCP_ACTOR_QUIESCE=11, TCP_ACTOR_EXIT=12
};
enum tcp_actor_event {
    TCP_ACTOR_READY=101, TCP_ACTOR_NEED=102, TCP_ACTOR_GRANT_RESULT=103,
    TCP_ACTOR_ACK=104, TCP_ACTOR_FINISHED=105, TCP_ACTOR_CHILD_CLOSED=106,
    TCP_ACTOR_STOPPED=107, TCP_ACTOR_BARRIER_DONE=108,
    TCP_ACTOR_DATA=109, TCP_ACTOR_EOF=110, TCP_ACTOR_CHILD_ERROR=111,
    TCP_ACTOR_OOB=112, TCP_ACTOR_OPTION_DONE=113,
    TCP_ACTOR_CLOSE_RETIRED=114, TCP_ACTOR_FENCE_DONE=115,
    TCP_ACTOR_QUIESCED=116, TCP_ACTOR_EXITING=117
};
struct tcp_actor_event_record { unsigned length; unsigned char bytes[TCP_ACTOR_HEADER+TCP_ACTOR_BODY_MAX]; };
struct tcp_accept_actor {
    struct tcp_accept_owner owner;
    struct tcp_accept_flow flows[TCP_ACCEPT_MAX];
    struct tcp_actor_event_record output[TCP_ACTOR_OUTPUTS];
    unsigned out_head,out_count; uint32_t epoch;
    int need,stopped,late_grant,fatal,native_error;
};
/* Actor owns its sockets. Caller serializes calls and must not copy this struct.
 * On init success READY is already queued. No ID/permit is reusable merely
 * because output is read; quota release requires the matching physical result. */
int tcp_actor_init(struct tcp_accept_actor *a,uint32_t epoch,const char *host,uint16_t port,
                   const uint32_t *acl,unsigned acl_count,unsigned limit);
/* Full one-frame admission: 1 consumed, 0 backpressure (retry identical frame),
 * -1 fatal malformed/stale input or native close failure. 0 has no side effects.
 * Failure requires closing own sockets and retaining unconfirmed permits until
 * actual helper process exit. */
int tcp_actor_command(struct tcp_accept_actor *a,const unsigned char *frame,unsigned length);
/* Returns 1 on progress, 0 no progress/backpressure, -1 fatal. */
/* Called by the data framer only after validating the barrier tuple. */
int tcp_actor_barrier_done(struct tcp_accept_actor *a,uint32_t id,uint64_t child,uint64_t permit);
int tcp_actor_control_reply(struct tcp_accept_actor *a,unsigned op,uint32_t id,uint64_t child,uint64_t permit);
int tcp_actor_option_closed(struct tcp_accept_actor *a,uint32_t id,uint64_t child,uint64_t permit,unsigned option);
int tcp_actor_lifecycle_reply(struct tcp_accept_actor *a,unsigned op,uint32_t id);
int tcp_actor_poll_listener(struct tcp_accept_actor *a);
/* -2 reports a per-child native error in native_error; caller closes that
 * exact child through tcp_framer_fail_child. -1 is actor-fatal. */
int tcp_actor_flush_child(struct tcp_accept_actor *a,uint64_t child,uint64_t permit);
int tcp_actor_receive_child(struct tcp_accept_actor *a,uint64_t child,uint64_t permit);
int tcp_actor_fail_child(struct tcp_accept_actor *a,uint64_t child,uint64_t permit,int native_error);
/* Pointer remains valid until pop. Writer must finish the entire frame first. */
const struct tcp_actor_event_record *tcp_actor_peek(const struct tcp_accept_actor *a);
void tcp_actor_pop(struct tcp_accept_actor *a);
/* On EOF/protocol failure, retire and close own resources. Returns 1 only if
 * all closes are confirmed. A failed close is never retried; caller must end
 * the process and hold all uncertain permits until physical process exit. */
int tcp_actor_abort(struct tcp_accept_actor *a);
#endif
