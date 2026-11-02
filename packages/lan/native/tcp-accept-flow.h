/* Per-child bounded ordered send queue. Actor serializes all calls. Apache-2.0. */
#ifndef BOTTLESHIP_TCP_ACCEPT_FLOW_H
#define BOTTLESHIP_TCP_ACCEPT_FLOW_H
#include <stdint.h>
#include "tcp-accept-owner.h"
#define TCP_FLOW_RECORDS 256u
#define TCP_FLOW_WINDOW 262144u
#define TCP_FLOW_SEGMENT 16384u
enum tcp_flow_kind { TCP_FLOW_DATA=1, TCP_FLOW_OOB=2, TCP_FLOW_FIN=3 };
enum tcp_flow_result { TCP_FLOW_ERROR=-1, TCP_FLOW_BLOCKED=0, TCP_FLOW_PROGRESS=1, TCP_FLOW_DONE=2 };
struct tcp_flow_record { uint32_t kind, id, length, offset; unsigned char *data; };
struct tcp_accept_flow {
    struct tcp_flow_record records[TCP_FLOW_RECORDS+1];
    unsigned head, count, payload, data_records, credit;
    int fin_queued, fin_sent, read_eof, retired, inline_mode;
};
/* Each flow is owned by one actor thread, never copied after initialization. */
void tcp_flow_init(struct tcp_accept_flow *flow);
/* Admission copies bytes atomically. IDs are opaque nonzero DATA/OOB values;
 * FIN has id zero and occupies its own reserved slot. Returns 1 or 0. */
int tcp_flow_enqueue(struct tcp_accept_flow *flow, unsigned kind, uint32_t id,
                     const void *data, unsigned length);
/* One real nonblocking send/shutdown. DONE reports an id only after a complete
 * DATA/OOB native send; FIN reports zero only after successful shutdown.
 * BLOCKED preserves the queue, ERROR requires owner teardown. */
int tcp_flow_send(struct tcp_accept_flow *flow, const struct tcp_accept_owner *owner,
                  uint64_t child, uint64_t permit, uint32_t *completed_id);
/* Credits are bounded. Reserve output capacity BEFORE recv, debit before
 * publishing to a potentially reentrant consumer. A failed publication is
 * fatal; discarded bytes cannot be recovered by returning credit. */
int tcp_flow_credit(struct tcp_accept_flow *flow, unsigned amount);
int tcp_flow_debit(struct tcp_accept_flow *flow, unsigned amount);
/* Frees unsent copies and blocks further operations. Does not close socket or
 * release its permit: physical close remains the accept owner's responsibility. */
void tcp_flow_retire(struct tcp_accept_flow *flow);
#endif
