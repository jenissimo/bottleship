/* Bounded, pre-admission TCP accept primitive. Apache-2.0.
 * The caller owns the listener and serializes these calls. Each permit is a
 * unique monotonic token from a shared external quota arbiter. No call accepts
 * without a permit, and release is reported only after the owned fd closes. */
#ifndef BOTTLESHIP_TCP_ACCEPT_OWNER_H
#define BOTTLESHIP_TCP_ACCEPT_OWNER_H
#include <stdint.h>
#ifdef _WIN32
#include <winsock2.h>
typedef SOCKET tcp_accept_socket;
#define TCP_ACCEPT_INVALID INVALID_SOCKET
#else
typedef int tcp_accept_socket;
#define TCP_ACCEPT_INVALID (-1)
#endif
#define TCP_ACCEPT_MAX 128
enum tcp_accept_result {
    TCP_ACCEPT_INVALID_INPUT=-1, TCP_ACCEPT_UNUSED=0, TCP_ACCEPT_ADMITTED=1,
    TCP_ACCEPT_REFUSED_CLOSED=2, TCP_ACCEPT_RETAINED=3, TCP_ACCEPT_FAILED=4
};
struct tcp_accept_slot { tcp_accept_socket socket; uint64_t child; uint64_t permit; int poisoned; };
struct tcp_accept_owner {
    tcp_accept_socket listener;
    uint64_t last_permit, next_child;
    unsigned limit, acl_count;
    int listener_poisoned;
    uint32_t acl[32]; /* IPv4 in network byte order, copied by init. */
    struct tcp_accept_slot slots[TCP_ACCEPT_MAX];
};
struct tcp_accept_outcome {uint64_t child,permit;uint32_t peer_ipv4;uint16_t peer_port;int native_error;};
/* ACL is mandatory; caller validates and owns the intended numeric bind IP. */
int tcp_accept_init(struct tcp_accept_owner *owner,const char *bind_ipv4,uint16_t port,
                    const uint32_t *acl,unsigned acl_count,unsigned limit,uint16_t *bound_port);
/* 1 readable, 0 not readable, -1 failure. Does not acquire/retain a permit. */
int tcp_accept_readable(struct tcp_accept_owner *owner);
/* Input token is consumed exactly once, including UNUSED and REFUSED_CLOSED.
 * UNUSED/REFUSED_CLOSED return permission to caller immediately. ADMITTED/
 * RETAINED transfer permission to returned child until close succeeds.
 * FAILED means accept returned a non-transient native error, saved in
 * native_error; the actor must stop and hold the permit until process exit.
 * RETAINED means an ACL-rejected socket could not be closed and must not be
 * used for data. Treat the helper as failed and retain the permit until its
 * process exits; do not retry close on a potentially reused Unix descriptor. */
int tcp_accept_grant(struct tcp_accept_owner *owner,uint64_t permit,struct tcp_accept_outcome *out);
/* Exact child and permit required. 1 closed and quota may be released, 0
 * stale/mismatched, -1 close failed and quota remains owned until helper exit;
 * do not retry a failed close on a potentially reused Unix descriptor. */
int tcp_accept_close(struct tcp_accept_owner *owner,uint64_t child,uint64_t permit);
/* Data access requires exact ownership and rejects poisoned slots. */
tcp_accept_socket tcp_accept_data_socket(const struct tcp_accept_owner *owner,uint64_t child,uint64_t permit);
/* Closing listener leaves admitted children alive. Returns 1 only on close. */
int tcp_accept_stop(struct tcp_accept_owner *owner);
#endif
