/* Ordinary unconnected UDP only, loopback, no RAW/elevation. */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <linux/errqueue.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/utsname.h>
#include <unistd.h>
typedef struct { int result,error,revents; } Wait;
typedef struct { int result,error; } Operation;
typedef struct { int result,error; socklen_t name_length; struct sockaddr_storage name; unsigned char bytes[16]; } Receive;
typedef struct {
    int result,error,flags,found; unsigned name_length; size_t control_length;
    struct sockaddr_storage name; unsigned char bytes[16],control[512]; struct sock_extended_err extended;
} ErrorQueue;
static unsigned port_of(const void*value){
    const struct sockaddr*address=value;
    if(address->sa_family==AF_INET)return ntohs(((const struct sockaddr_in*)value)->sin_port);
    if(address->sa_family==AF_INET6)return ntohs(((const struct sockaddr_in6*)value)->sin6_port);
    return 0;
}
static int same_address(const void*value,const struct sockaddr_storage*expected){
    const struct sockaddr*address=value;
    if(address->sa_family!=expected->ss_family||port_of(value)!=port_of(expected))return 0;
    if(address->sa_family==AF_INET)return ((const struct sockaddr_in*)value)->sin_addr.s_addr==((const struct sockaddr_in*)expected)->sin_addr.s_addr;
    return memcmp(&((const struct sockaddr_in6*)value)->sin6_addr,&((const struct sockaddr_in6*)expected)->sin6_addr,16)==0;
}
static int open_local(int family,struct sockaddr_storage*address,socklen_t*length){
    int s=socket(family,SOCK_DGRAM|SOCK_NONBLOCK,IPPROTO_UDP);
    memset(address,0,sizeof(*address));address->ss_family=(sa_family_t)family;
    if(family==AF_INET){((struct sockaddr_in*)address)->sin_addr.s_addr=htonl(INADDR_LOOPBACK);*length=sizeof(struct sockaddr_in);}
    else{((struct sockaddr_in6*)address)->sin6_addr=in6addr_loopback;*length=sizeof(struct sockaddr_in6);}
    if(s<0)return s;
    if(bind(s,(struct sockaddr*)address,*length)<0||getsockname(s,(struct sockaddr*)address,length)<0){close(s);return -1;}
    return s;
}
static Wait wait_read(int s,short events,int millis){
    struct pollfd p={.fd=s,.events=events};Wait value;errno=0;
    value.result=poll(&p,1,millis);value.error=errno;value.revents=p.revents;return value;
}
static Operation send_byte(int s,const struct sockaddr_storage*to,socklen_t length,char byte){
    Operation value;errno=0;value.result=(int)sendto(s,&byte,1,MSG_DONTWAIT,(const struct sockaddr*)to,length);value.error=errno;return value;
}
static Receive receive_one(int s){
    Receive value;memset(&value,0,sizeof(value));memset(&value.name,0xa5,sizeof(value.name));memset(value.bytes,0xa5,sizeof(value.bytes));
    value.name_length=sizeof(value.name);errno=0;
    value.result=(int)recvfrom(s,value.bytes,sizeof(value.bytes),MSG_DONTWAIT,(struct sockaddr*)&value.name,&value.name_length);value.error=errno;return value;
}
static ErrorQueue drain_error(int s,int family){
    ErrorQueue value;struct iovec vector;struct msghdr message;struct cmsghdr*cmsg;
    int level=family==AF_INET?IPPROTO_IP:IPPROTO_IPV6,option=family==AF_INET?IP_RECVERR:IPV6_RECVERR;
    memset(&value,0,sizeof(value));memset(&value.name,0xa5,sizeof(value.name));memset(value.bytes,0xa5,sizeof(value.bytes));memset(value.control,0xa5,sizeof(value.control));
    memset(&message,0,sizeof(message));vector.iov_base=value.bytes;vector.iov_len=sizeof(value.bytes);
    message.msg_name=&value.name;message.msg_namelen=sizeof(value.name);message.msg_iov=&vector;message.msg_iovlen=1;
    message.msg_control=value.control;message.msg_controllen=sizeof(value.control);errno=0;
    value.result=(int)recvmsg(s,&message,MSG_ERRQUEUE|MSG_DONTWAIT);value.error=errno;value.name_length=message.msg_namelen;
    value.flags=message.msg_flags;value.control_length=message.msg_controllen;
    if(value.result>=0)for(cmsg=CMSG_FIRSTHDR(&message);cmsg;cmsg=CMSG_NXTHDR(&message,cmsg)){
        if(cmsg->cmsg_level==level&&cmsg->cmsg_type==option&&cmsg->cmsg_len>=CMSG_LEN(sizeof(value.extended))){
            memcpy(&value.extended,CMSG_DATA(cmsg),sizeof(value.extended));value.found=1;
        }
    }
    return value;
}
static void hex(const void*pointer,size_t length){const unsigned char*bytes=pointer;size_t i;putchar('"');for(i=0;i<length;i++)printf("%02x",bytes[i]);putchar('"');}
static void print_op(Operation value){printf("{\"result\":%d,\"errno\":%d}",value.result,value.error);}
static void print_wait(Wait value){printf("{\"result\":%d,\"errno\":%d,\"revents\":%d}",value.result,value.error,value.revents);}
static void print_receive(Receive*value){
    printf("{\"result\":%d,\"errno\":%d,\"nameLength\":%u,\"nameHex\":",value->result,value->error,(unsigned)value->name_length);
    hex(&value->name,sizeof(value->name));printf(",\"payloadHex\":");hex(value->bytes,sizeof(value->bytes));putchar('}');
}
static void print_error(ErrorQueue*value){
    printf("{\"result\":%d,\"errno\":%d,\"nameLength\":%u,\"flags\":%d,\"controlLength\":%zu,\"nameHex\":",
        value->result,value->error,value->name_length,value->flags,value->control_length);
    hex(&value->name,sizeof(value->name));printf(",\"payloadHex\":");hex(value->bytes,sizeof(value->bytes));
    printf(",\"controlHex\":");hex(value->control,value->control_length);
    printf(",\"extendedErrorFound\":%s,\"eeErrno\":%u,\"eeOrigin\":%u,\"eeType\":%u,\"eeCode\":%u}",
        value->found?"true":"false",value->extended.ee_errno,value->extended.ee_origin,value->extended.ee_type,value->extended.ee_code);
}
static int warm(int client,int peer,const struct sockaddr_storage*address,socklen_t length,const struct sockaddr_storage*self,char byte){
    Operation sent=send_byte(client,address,length,byte);Wait ready=wait_read(peer,POLLIN,500);Receive got=receive_one(peer);
    return sent.result==1&&ready.result>0&&got.result==1&&got.bytes[0]==(unsigned char)byte&&same_address(&got.name,self);
}
static int probe(int family,int predrain){
    struct sockaddr_storage a_address,b_address,self,after;socklen_t alen=0,blen=0,slen=0,after_length=sizeof(after);
    int a=open_local(family,&a_address,&alen),b=open_local(family,&b_address,&blen),client=open_local(family,&self,&slen);
    int enabled=1,level=family==AF_INET?IPPROTO_IP:IPPROTO_IPV6,option=family==AF_INET?IP_RECVERR:IPV6_RECVERR;
    int setup,valid,retry_attempted,after_result;Operation trigger,b_send,retry={-999,0},reply_send;
    Wait pending,b_wait,retry_wait={-999,0,0},reply_wait;Receive before,retried,reply,ordinary;
    ErrorQueue drained,again;
    if(a<0||b<0||client<0){
        printf("{\"family\":%d,\"setup\":false,\"caseValid\":false}",family==AF_INET?4:6);
        if(a>=0)close(a);
        if(b>=0)close(b);
        if(client>=0)close(client);
        return 10;
    }
    setup=setsockopt(client,level,option,&enabled,sizeof(enabled))==0&&warm(client,a,&a_address,alen,&self,'a')&&warm(client,b,&b_address,blen,&self,'b');
    close(a);trigger=send_byte(client,&a_address,alen,'x');pending=wait_read(client,POLLERR,500);
    if(predrain)drained=drain_error(client,family);
    b_send=send_byte(client,&b_address,blen,'Y');b_wait=wait_read(b,POLLIN,150);before=receive_one(b);
    if(!predrain)drained=drain_error(client,family);
    again=drain_error(client,family);ordinary=receive_one(client);
    memset(&retried,0,sizeof(retried));retried.result=-999;retry_attempted=b_send.result<0;
    if(retry_attempted){retry=send_byte(client,&b_address,blen,'Y');retry_wait=wait_read(b,POLLIN,500);retried=receive_one(b);}
    reply_send=send_byte(b,&self,slen,'R');reply_wait=wait_read(client,POLLIN,500);reply=receive_one(client);
    memset(&after,0,sizeof(after));after_result=getsockname(client,(struct sockaddr*)&after,&after_length);
    valid=setup&&trigger.result==1&&pending.result>0&&(pending.revents&POLLERR)&&drained.result==1&&drained.found&&
        same_address(&drained.name,&a_address)&&drained.bytes[0]=='x'&&drained.extended.ee_errno==ECONNREFUSED&&
        again.result==-1&&(again.error==EAGAIN||again.error==EWOULDBLOCK)&&
        ((b_send.result==1&&before.result==1&&before.bytes[0]=='Y'&&same_address(&before.name,&self))||
         (retry_attempted&&before.result==-1&&(before.error==EAGAIN||before.error==EWOULDBLOCK)&&retry.result==1&&
          retried.result==1&&retried.bytes[0]=='Y'&&same_address(&retried.name,&self)))&&
        reply_send.result==1&&reply_wait.result>0&&reply.result==1&&reply.bytes[0]=='R'&&same_address(&reply.name,&b_address)&&
        after_result==0&&port_of(&after)==port_of(&self);
    printf("{\"family\":%d,\"drainBeforeSendControl\":%s,\"setup\":%s,\"peerAPort\":%u,\"peerBPort\":%u,\"clientPort\":%u,\"closedASend\":",
        family==AF_INET?4:6,predrain?"true":"false",setup?"true":"false",port_of(&a_address),port_of(&b_address),port_of(&self));print_op(trigger);
    printf(",\"pendingWait\":");print_wait(pending);printf(",\"sendB\":");print_op(b_send);
    printf(",\"bAfterSend\":{\"wait\":");print_wait(b_wait);printf(",\"receive\":");print_receive(&before);putchar('}');
    printf(",\"errorQueue\":");print_error(&drained);printf(",\"drainNameMatchesA\":%s,\"errorQueueAfterDrain\":",
        same_address(&drained.name,&a_address)?"true":"false");print_error(&again);
    printf(",\"ordinaryReceiveAfterDrain\":");print_receive(&ordinary);
    printf(",\"retry\":{\"attempted\":%s,\"send\":",retry_attempted?"true":"false");print_op(retry);
    printf(",\"wait\":");print_wait(retry_wait);printf(",\"receive\":");print_receive(&retried);putchar('}');
    printf(",\"livePeerReply\":{\"send\":");print_op(reply_send);printf(",\"wait\":");print_wait(reply_wait);printf(",\"receive\":");print_receive(&reply);putchar('}');
    printf(",\"sourcePortAfter\":%u,\"sourcePortUnchanged\":%s,\"caseValid\":%s}",port_of(&after),after_result==0&&port_of(&after)==port_of(&self)?"true":"false",valid?"true":"false");
    close(b);close(client);return valid?0:1;
}
int main(void){
    struct utsname platform;int family,order,first=1,failed=0;
    if(uname(&platform)<0)return 20;
    printf("{\"nativeOnly\":true,\"platform\":\"%s\",\"release\":\"%s\",\"cases\":[",platform.sysname,platform.release);
    for(family=0;family<2;family++)for(order=0;order<2;order++){
        if(!first)putchar(',');
        first=0;failed|=probe(family?AF_INET6:AF_INET,order);
    }
    printf("]}\n");return failed?1:0;
}
