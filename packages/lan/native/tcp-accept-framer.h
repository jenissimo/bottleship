/* Bounded incremental framing for tcp_accept_actor, no platform pipe I/O. */
#ifndef BOTTLESHIP_TCP_ACCEPT_FRAMER_H
#define BOTTLESHIP_TCP_ACCEPT_FRAMER_H
#include "tcp-accept-actor.h"
struct tcp_accept_framer {
    unsigned char input[TCP_ACTOR_FRAME_MAX];
    unsigned used,expected,output_offset;
    unsigned char control[40];
    unsigned control_used,control_expected;
    struct { uint64_t child,permit; int fenced; } closed[TCP_ACCEPT_MAX];
    unsigned closed_count;
    int quiesced,exit_requested;
};
/* Data pipe: 1 progress/need input, 0 backpressure, -1 fatal. A blocked full
 * frame remains owned until admitted or cancelled by matching CLOSE. */
int tcp_framer_feed(struct tcp_accept_framer *f,struct tcp_accept_actor *a,
                    const unsigned char *data,unsigned length,unsigned *consumed);
/* Independent bounded control pipe; STOP/CLOSE/OPTION/CONTROL_FENCE/EXIT are valid. A complete
 * blocked control stays owned; call again with length 0 after output drains.
 * Matching CLOSE cancels a fully buffered data frame for that child/permit.
 * The resulting CHILD_CLOSED resolves all its unacknowledged writes. A
 * bounded closed-tuple table also discards valid late data frames, including
 * a partial frame completed after CLOSE. Parent sends BARRIER on the data
 * channel after all prior data for the tuple and after FENCE_DONE on the
 * control pipe confirms prior CLOSEs; BARRIER_DONE retires it. */
int tcp_framer_control(struct tcp_accept_framer *f,struct tcp_accept_actor *a,
                       const unsigned char *data,unsigned length,unsigned *consumed);
/* Use this instead of actor_poll_listener: it reserves tombstone capacity
 * for each live accepted child until its data-pipe barrier is processed. */
int tcp_framer_poll_listener(struct tcp_accept_framer *f,struct tcp_accept_actor *a);
/* Publish an exact child error only after physical close, and retain its tuple
 * for late data until the ordered barrier. 0 means output backpressure. */
int tcp_framer_fail_child(struct tcp_accept_framer *f,struct tcp_accept_actor *a,
                          uint64_t child,uint64_t permit,int native_error);
/* Returns the unsent tail of the front frame; commit only actual pipe writes. */
const unsigned char *tcp_framer_output(struct tcp_accept_framer *f,
                                       struct tcp_accept_actor *a,unsigned *length);
int tcp_framer_written(struct tcp_accept_framer *f,struct tcp_accept_actor *a,unsigned n);
/* EOF with a partial or blocked frame on either pipe is an error; caller always aborts actor
 * and retains unconfirmed permits through process exit. */
int tcp_framer_eof(const struct tcp_accept_framer *f);
#endif
