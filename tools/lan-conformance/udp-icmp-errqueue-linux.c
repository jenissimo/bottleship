/* Ordinary UDP only: unconnected socket, loopback peers, no raw socket or privileges. */
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
static int open_local(int family,struct sockaddr_storage*address,socklen_t*size){
    int fd=socket(family,SOCK_DGRAM|SOCK_NONBLOCK,IPPROTO_UDP);
    memset(address,0,sizeof(*address));address->ss_family=(sa_family_t)family;
    if(family==AF_INET){struct sockaddr_in*in=(struct sockaddr_in*)address;in->sin_addr.s_addr=htonl(INADDR_LOOPBACK);*size=sizeof(*in);}
    else{struct sockaddr_in6*in=(struct sockaddr_in6*)address;in->sin6_addr=in6addr_loopback;*size=sizeof(*in);}
    if(fd<0||bind(fd,(struct sockaddr*)address,*size)<0||getsockname(fd,(struct sockaddr*)address,size)<0)return -1;
    return fd;
}
static unsigned port_of(const struct sockaddr_storage*address){
    return ntohs(address->ss_family==AF_INET?((const struct sockaddr_in*)address)->sin_port:((const struct sockaddr_in6*)address)->sin6_port);
}
static void hex(const void*pointer,size_t size){const unsigned char*bytes=pointer;size_t i;putchar('"');for(i=0;i<size;i++)printf("%02x",bytes[i]);putchar('"');}
static int ready(int fd,short events){struct pollfd p={.fd=fd,.events=events};return poll(&p,1,500);}
static int probe(int family){
    struct sockaddr_storage first,second,self,name,normal_name,reply_name; socklen_t first_size=0,second_size=0,self_size=0,normal_size,reply_size;
    int a=open_local(family,&first,&first_size),b=open_local(family,&second,&second_size),client=open_local(family,&self,&self_size);
    int enabled=1,normal_result,normal_errno,error_result,error_errno,drain_result,drain_errno,reply_result,reply_errno;
    int level=family==AF_INET?IPPROTO_IP:IPPROTO_IPV6,option=family==AF_INET?IP_RECVERR:IPV6_RECVERR;
    unsigned char bytes[16],control[512];struct iovec vector={.iov_base=bytes,.iov_len=sizeof(bytes)};struct msghdr message;struct cmsghdr*cmsg;
    struct sock_extended_err error;int found=0,matched;ssize_t result;
    if(a<0||b<0||client<0||setsockopt(client,level,option,&enabled,sizeof(enabled))<0)return 10;
    if(sendto(client,"a",1,0,(struct sockaddr*)&first,first_size)!=1||ready(a,POLLIN)<1||recv(a,bytes,sizeof(bytes),0)!=1)return 11;
    if(sendto(client,"b",1,0,(struct sockaddr*)&second,second_size)!=1||ready(b,POLLIN)<1||recv(b,bytes,sizeof(bytes),0)!=1)return 12;
    close(a);result=sendto(client,"x",1,0,(struct sockaddr*)&first,first_size);if(result!=1||ready(client,POLLERR)<1)return 13;
    memset(&normal_name,0xa5,sizeof(normal_name));normal_size=sizeof(normal_name);errno=0;
    normal_result=(int)recvfrom(client,bytes,sizeof(bytes),MSG_DONTWAIT,(struct sockaddr*)&normal_name,&normal_size);normal_errno=errno;
    memset(&name,0xa5,sizeof(name));memset(bytes,0xa5,sizeof(bytes));memset(control,0xa5,sizeof(control));memset(&message,0,sizeof(message));
    message.msg_name=&name;message.msg_namelen=sizeof(name);message.msg_iov=&vector;message.msg_iovlen=1;message.msg_control=control;message.msg_controllen=sizeof(control);errno=0;
    error_result=(int)recvmsg(client,&message,MSG_ERRQUEUE|MSG_DONTWAIT);error_errno=errno;memset(&error,0,sizeof(error));
    for(cmsg=CMSG_FIRSTHDR(&message);cmsg;cmsg=CMSG_NXTHDR(&message,cmsg))
        if(cmsg->cmsg_level==level&&cmsg->cmsg_type==option&&cmsg->cmsg_len>=CMSG_LEN(sizeof(error))){memcpy(&error,CMSG_DATA(cmsg),sizeof(error));found=1;}
    matched=error_result==1&&found&&name.ss_family==family&&port_of(&name)==port_of(&first);
    printf("{\"family\":%d,\"peerAPort\":%u,\"peerBPort\":%u,\"clientPort\":%u,",family==AF_INET?4:6,port_of(&first),port_of(&second),port_of(&self));
    printf("\"ordinaryRecv\":{\"result\":%d,\"errno\":%d,\"nameLength\":%u,\"nameHex\":",normal_result,normal_errno,(unsigned)normal_size);hex(&normal_name,sizeof(normal_name));printf("},");
    printf("\"errorQueue\":{\"result\":%d,\"errno\":%d,\"nameLength\":%u,\"nameHex\":",error_result,error_errno,(unsigned)message.msg_namelen);hex(&name,sizeof(name));
    printf(",\"flags\":%d,\"controlLength\":%zu,\"controlHex\":",message.msg_flags,message.msg_controllen);hex(control,message.msg_controllen);
    printf(",\"extendedErrorFound\":%d,\"eeErrno\":%u,\"eeOrigin\":%u,\"eeType\":%u,\"eeCode\":%u,\"originalDestinationMatchesA\":%d},",found,error.ee_errno,error.ee_origin,error.ee_type,error.ee_code,matched);
    errno=0;drain_result=(int)recvmsg(client,&message,MSG_ERRQUEUE|MSG_DONTWAIT);drain_errno=errno;
    if(sendto(b,"B",1,0,(struct sockaddr*)&self,self_size)!=1||ready(client,POLLIN)<1)return 14;
    memset(&reply_name,0xc3,sizeof(reply_name));reply_size=sizeof(reply_name);errno=0;
    reply_result=(int)recvfrom(client,bytes,sizeof(bytes),MSG_DONTWAIT,(struct sockaddr*)&reply_name,&reply_size);reply_errno=errno;
    printf("\"drained\":{\"result\":%d,\"errno\":%d},\"livePeerReply\":{\"result\":%d,\"errno\":%d,\"payloadMatches\":%d,\"sourceMatchesB\":%d}}",
        drain_result,drain_errno,reply_result,reply_errno,reply_result==1&&bytes[0]=='B',port_of(&reply_name)==port_of(&second));
    close(b);close(client);
    return matched&&normal_result==-1&&normal_errno==ECONNREFUSED&&drain_result==-1&&(drain_errno==EAGAIN||drain_errno==EWOULDBLOCK)&&reply_result==1&&bytes[0]=='B'&&port_of(&reply_name)==port_of(&second)?0:15;
}
int main(void){struct utsname machine;int v4,v6;if(uname(&machine)<0)return 20;printf("{\"nativeOnly\":true,\"platform\":\"%s\",\"release\":\"%s\",\"cases\":[",machine.sysname,machine.release);
    v4=probe(AF_INET);if(v4)return v4;putchar(',');v6=probe(AF_INET6);if(v6)return v6;printf("]}\n");return 0;}
