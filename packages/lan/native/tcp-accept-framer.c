#include "tcp-accept-framer.h"
#include <string.h>
static unsigned read32(const unsigned char *p) {
    return (unsigned)p[0]|((unsigned)p[1]<<8)|((unsigned)p[2]<<16)|((unsigned)p[3]<<24);
}
static uint64_t read64(const unsigned char *p) {return (uint64_t)read32(p)|((uint64_t)read32(p+4)<<32);}
static int closed_data(const struct tcp_accept_framer *f,const struct tcp_accept_actor *a) {
    const unsigned char *p=f->input;unsigned n=f->used,op;
    if(n<32||p[4]!=1||p[6]||p[7]||!read32(p+8)||read32(p+12)!=a->epoch)return 0;
    op=p[5];
    if(!((op==TCP_ACTOR_WRITE&&n>=37&&n<=36+TCP_FLOW_SEGMENT&&read32(p+32))||
         (op==TCP_ACTOR_URGENT&&n==37&&read32(p+32))||
         (op==TCP_ACTOR_FIN&&n==32)||
         (op==TCP_ACTOR_CREDIT&&n==36&&read32(p+32))))return 0;
    uint64_t child=read64(p+16),permit=read64(p+24);
    for(unsigned i=0;i<f->closed_count;i++)
        if(f->closed[i].child==child&&f->closed[i].permit==permit)return 1;
    return 0;
}
static int closed_index(const struct tcp_accept_framer *f,uint64_t child,uint64_t permit) {
    for(unsigned i=0;i<f->closed_count;i++)
        if(f->closed[i].child==child&&f->closed[i].permit==permit)return (int)i;
    return -1;
}
static unsigned ownership_count(const struct tcp_accept_framer *f,const struct tcp_accept_actor *a) {
    unsigned n=f->closed_count;
    for(unsigned i=0;i<a->owner.limit;i++)if(a->owner.slots[i].socket!=TCP_ACCEPT_INVALID)n++;
    return n;
}
int tcp_framer_poll_listener(struct tcp_accept_framer *f,struct tcp_accept_actor *a) {
    if(!f||!a||a->fatal)return -1;
    if(ownership_count(f,a)>=TCP_ACCEPT_MAX)return 0;
    return tcp_actor_poll_listener(a);
}
int tcp_framer_fail_child(struct tcp_accept_framer *f,struct tcp_accept_actor *a,
                          uint64_t child,uint64_t permit,int native_error) {
    if(!f||!a||f->closed_count==TCP_ACCEPT_MAX)return -1;
    int result=tcp_actor_fail_child(a,child,permit,native_error);
    if(result!=1)return result;
    f->closed[f->closed_count].child=child;f->closed[f->closed_count].permit=permit;
    f->closed[f->closed_count].fenced=0;f->closed_count++;
    if(f->expected&&f->used==f->expected&&closed_data(f,a)){f->used=0;f->expected=0;}
    return 1;
}
static int barrier(struct tcp_accept_framer *f,struct tcp_accept_actor *a) {
    const unsigned char *p=f->input;unsigned n=f->used;
    if(n!=32||p[4]!=1||p[6]||p[7]||!read32(p+8)||read32(p+12)!=a->epoch)return -1;
    uint64_t child=read64(p+16),permit=read64(p+24);unsigned i;
    if(!child||!permit)return -1;
    for(i=0;i<f->closed_count;i++)
        if(f->closed[i].child==child&&f->closed[i].permit==permit)break;
    if(i==f->closed_count)
        return tcp_accept_data_socket(&a->owner,child,permit)!=TCP_ACCEPT_INVALID?0:-1;
    if(!f->closed[i].fenced)return 0;
    int result=tcp_actor_barrier_done(a,read32(p+8),child,permit);
    if(result!=1)return result;
    f->closed[i]=f->closed[f->closed_count-1];
    f->closed_count--;return 1;
}
static int quiesce(struct tcp_accept_framer *f,struct tcp_accept_actor *a) {
    const unsigned char *p=f->input;
    if(f->used!=16||p[4]!=1||p[6]||p[7]||!read32(p+8)||read32(p+12)!=a->epoch||
       f->quiesced||f->exit_requested)return -1;
    if(!a->stopped||a->owner.listener!=TCP_ACCEPT_INVALID||f->closed_count||f->control_used)return -1;
    for(unsigned i=0;i<a->owner.limit;i++)
        if(a->owner.slots[i].socket!=TCP_ACCEPT_INVALID)return -1;
    int result=tcp_actor_lifecycle_reply(a,TCP_ACTOR_QUIESCED,read32(p+8));
    if(result!=1)return result;
    /* Parent's data-stream fence is after every issued GRANT. */
    a->late_grant=0;f->quiesced=1;return 1;
}
int tcp_framer_feed(struct tcp_accept_framer *f,struct tcp_accept_actor *a,
                    const unsigned char *data,unsigned length,unsigned *consumed) {
    if(!f||!a||!consumed||(!data&&length))return -1;
    *consumed=0;
    for(;;) {
        if(f->expected&&f->used==f->expected) {
            if(f->input[5]==TCP_ACTOR_STOP||f->input[5]==TCP_ACTOR_CLOSE_CHILD||
               f->input[5]==TCP_ACTOR_OPTION||f->input[5]==TCP_ACTOR_CONTROL_FENCE||f->input[5]==TCP_ACTOR_EXIT) {
                (void)tcp_actor_abort(a);return -1;
            }
            if(f->quiesced){(void)tcp_actor_abort(a);return -1;}
            if(f->input[5]==TCP_ACTOR_QUIESCE) {
                int result=quiesce(f,a);
                if(result==0)return 0;
                if(result<0){(void)tcp_actor_abort(a);return -1;}
                f->used=0;f->expected=0;continue;
            }
            if(f->input[5]==TCP_ACTOR_BARRIER) {
                int result=barrier(f,a);
                if(result==0)return 0;
                if(result<0){(void)tcp_actor_abort(a);return -1;}
                f->used=0;f->expected=0;continue;
            }
            if(closed_data(f,a)){f->used=0;f->expected=0;continue;}
            if(f->input[5]==TCP_ACTOR_GRANT&&!a->stopped&&ownership_count(f,a)>=TCP_ACCEPT_MAX)
                return 0;
            int result=tcp_actor_command(a,f->input,f->used);
            if(result==0)return 0;
            if(result<0){(void)tcp_actor_abort(a);return -1;}
            f->used=0;f->expected=0;
        }
        if(*consumed==length)return 1;
        if(f->quiesced){(void)tcp_actor_abort(a);return -1;}
        unsigned target=f->expected?f->expected:4;
        unsigned need=target-f->used;
        unsigned take=length-*consumed;if(take>need)take=need;
        memcpy(f->input+f->used,data+*consumed,take);f->used+=take;*consumed+=take;
        if(!f->expected&&f->used==4) {
            f->expected=read32(f->input);
            if(f->expected<TCP_ACTOR_HEADER||f->expected>TCP_ACTOR_FRAME_MAX){(void)tcp_actor_abort(a);return -1;}
        }
    }
}
int tcp_framer_control(struct tcp_accept_framer *f,struct tcp_accept_actor *a,
                       const unsigned char *data,unsigned length,unsigned *consumed) {
    if(!f||!a||!consumed||(!data&&length))return -1;
    *consumed=0;
    for(;;) {
        if(f->control_expected&&f->control_used==f->control_expected) {
            unsigned char op=f->control[5];
            if(!((op==TCP_ACTOR_STOP&&f->control_expected==16)||
                 (op==TCP_ACTOR_EXIT&&f->control_expected==16)||
                 (op==TCP_ACTOR_CLOSE_CHILD&&f->control_expected==32)||
                 (op==TCP_ACTOR_CONTROL_FENCE&&f->control_expected==32)||
                 (op==TCP_ACTOR_OPTION&&f->control_expected==40))||
               f->control[4]!=1||f->control[6]||f->control[7]||
               !read32(f->control+8)||read32(f->control+12)!=a->epoch) {
                (void)tcp_actor_abort(a);return -1;
            }
            if(f->exit_requested||(f->quiesced&&op!=TCP_ACTOR_EXIT)||
               (op==TCP_ACTOR_EXIT&&!f->quiesced)){(void)tcp_actor_abort(a);return -1;}
            uint64_t child=(op==TCP_ACTOR_STOP||op==TCP_ACTOR_EXIT)?0:read64(f->control+16);
            uint64_t permit=(op==TCP_ACTOR_STOP||op==TCP_ACTOR_EXIT)?0:read64(f->control+24);
            int existing=closed_index(f,child,permit),result;
            if(op==TCP_ACTOR_EXIT) {
                result=tcp_actor_lifecycle_reply(a,TCP_ACTOR_EXITING,read32(f->control+8));
                if(result==0)return 0;
                if(result<0){(void)tcp_actor_abort(a);return -1;}
                f->exit_requested=1;
            } else if(op==TCP_ACTOR_CONTROL_FENCE) {
                if(existing<0) {
                    if(tcp_accept_data_socket(&a->owner,child,permit)!=TCP_ACCEPT_INVALID)return 0;
                    (void)tcp_actor_abort(a);return -1;
                }
                if(f->closed[existing].fenced){(void)tcp_actor_abort(a);return -1;}
                result=tcp_actor_control_reply(a,TCP_ACTOR_FENCE_DONE,read32(f->control+8),child,permit);
                if(result==0)return 0;
                if(result<0){(void)tcp_actor_abort(a);return -1;}
                f->closed[existing].fenced=1;
            } else if(op==TCP_ACTOR_OPTION&&existing>=0) {
                if(f->closed[existing].fenced||read32(f->control+32)>2||read32(f->control+36)>1) {
                    (void)tcp_actor_abort(a);return -1;
                }
                result=tcp_actor_option_closed(a,read32(f->control+8),child,permit,read32(f->control+32));
                if(result==0)return 0;
                if(result<0){(void)tcp_actor_abort(a);return -1;}
            } else if(op==TCP_ACTOR_CLOSE_CHILD&&existing>=0) {
                if(f->closed[existing].fenced){(void)tcp_actor_abort(a);return -1;}
                result=tcp_actor_control_reply(a,TCP_ACTOR_CLOSE_RETIRED,read32(f->control+8),child,permit);
                if(result==0)return 0;
                if(result<0){(void)tcp_actor_abort(a);return -1;}
            } else {
                if(op==TCP_ACTOR_CLOSE_CHILD&&f->closed_count==TCP_ACCEPT_MAX) {
                    (void)tcp_actor_abort(a);return -1;
                }
                result=tcp_actor_command(a,f->control,f->control_used);
                if(result==0)return 0;
                if(result<0){(void)tcp_actor_abort(a);return -1;}
            }
            if(op==TCP_ACTOR_CLOSE_CHILD&&existing<0) {
                f->closed[f->closed_count].child=read64(f->control+16);
                f->closed[f->closed_count].permit=read64(f->control+24);
                f->closed[f->closed_count].fenced=0;f->closed_count++;
                if(f->expected&&f->used==f->expected&&closed_data(f,a)) {
                    f->used=0;f->expected=0;
                }
            }
            f->control_used=0;f->control_expected=0;
        }
        if(*consumed==length)return 1;
        if(f->exit_requested){(void)tcp_actor_abort(a);return -1;}
        unsigned target=f->control_expected?f->control_expected:4;
        unsigned need=target-f->control_used;
        unsigned take=length-*consumed;if(take>need)take=need;
        memcpy(f->control+f->control_used,data+*consumed,take);
        f->control_used+=take;*consumed+=take;
        if(!f->control_expected&&f->control_used==4) {
            f->control_expected=read32(f->control);
            if(f->control_expected<16||f->control_expected>sizeof(f->control)) {
                (void)tcp_actor_abort(a);return -1;
            }
        }
    }
}
const unsigned char *tcp_framer_output(struct tcp_accept_framer *f,struct tcp_accept_actor *a,unsigned *length) {
    const struct tcp_actor_event_record *r;
    if(!f||!a||!length)return NULL;
    *length=0;r=tcp_actor_peek(a);if(!r)return NULL;
    if(f->output_offset>=r->length)return NULL;
    *length=r->length-f->output_offset;return r->bytes+f->output_offset;
}
int tcp_framer_written(struct tcp_accept_framer *f,struct tcp_accept_actor *a,unsigned n) {
    const struct tcp_actor_event_record *r;
    if(!f||!a||!n||(r=tcp_actor_peek(a))==NULL||f->output_offset>=r->length||
       n>r->length-f->output_offset)return 0;
    f->output_offset+=n;
    if(f->output_offset==r->length){tcp_actor_pop(a);f->output_offset=0;}
    return 1;
}
int tcp_framer_eof(const struct tcp_accept_framer *f) {return f&&f->used==0&&f->control_used==0;}
