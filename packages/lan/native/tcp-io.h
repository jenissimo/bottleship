/* Original TCP helper queue and event loop. Apache-2.0.
 * DATA/OOB/FIN share one ordered lane. Controls and receive credit must remain
 * reachable even when every native send is blocked. Included by socket-helper.c. */
#ifndef _WIN32
#include <poll.h>
#endif
#define TCP_RECORDS 256
#define TCP_CONTROLS 64
typedef struct { uint32_t kind,id,length,offset; unsigned char *data; } tcp_send_t;
typedef struct { uint32_t id,option,enabled; } tcp_control_t;
static tcp_send_t tcp_sends[TCP_RECORDS+1];
static tcp_control_t tcp_controls[TCP_CONTROLS];
static unsigned tcp_head,tcp_count,tcp_payload,tcp_data_records,tcp_control_head,tcp_control_count;
static int tcp_mode,tcp_fin_queued;
#ifdef _WIN32
static HANDLE tcp_input_event;
static WSAEVENT tcp_socket_event;
#else
static int tcp_input_pipe[2]={-1,-1};
#endif
static void tcp_wake(void) {
#ifdef _WIN32
    if(tcp_input_event)SetEvent(tcp_input_event);
#else
    unsigned char byte=1;
    if(tcp_input_pipe[1]>=0){ssize_t result=write(tcp_input_pipe[1],&byte,1);(void)result;}
#endif
}
static void tcp_input_failure(int error) {
    LOCK(&mutex);if(!input_error)input_error=error;UNLOCK(&mutex);tcp_wake();
}
static void tcp_read_input(void) {
    unsigned char header[8],payload[SEGMENT+4];
    for(;;){
        if(!read_exact(header,8))break;
        uint32_t kind=get32(header),length=get32(header+4);
        if(length>sizeof(payload)||!read_exact(payload,length)){tcp_input_failure(10022);break;}
        if(kind==CMD_CLOSE&&!length)break;
        if(kind==CMD_CREDIT&&length==4){
            uint32_t add=get32(payload);LOCK(&mutex);
            if(!add||add>WINDOW-receive_credit)input_error=10022;else receive_credit+=add;
            int failure=input_error;UNLOCK(&mutex);tcp_wake();if(failure)break;continue;
        }
        if(kind==CMD_TCP_CONTROL&&length==12){
            uint32_t id=get32(payload),option=get32(payload+4),enabled=get32(payload+8);
            if(!id||option>2||enabled>1){tcp_input_failure(10022);break;}
            LOCK(&mutex);
            if(stopped){UNLOCK(&mutex);break;}
            if(tcp_control_count==TCP_CONTROLS){input_error=10055;UNLOCK(&mutex);tcp_wake();break;}
            tcp_controls[(tcp_control_head+tcp_control_count)%TCP_CONTROLS]=(tcp_control_t){id,option,enabled};
            tcp_control_count++;UNLOCK(&mutex);tcp_wake();continue;
        }
        if(!((kind==CMD_DATA&&length>4&&length<=SEGMENT+4)||(kind==CMD_OOB&&length==5)||(kind==CMD_FIN&&!length))){
            tcp_input_failure(10022);break;
        }
        uint32_t size=kind==CMD_FIN?0:length-4;
        unsigned char *copy=size?malloc(size):NULL;
        if(size&&!copy){tcp_input_failure(10055);break;}
        if(size)memcpy(copy,payload+4,size);
        LOCK(&mutex);
        if(stopped){UNLOCK(&mutex);free(copy);break;}
        if(tcp_fin_queued||tcp_count==TCP_RECORDS+1||(kind!=CMD_FIN&&(tcp_data_records==TCP_RECORDS||size>WINDOW-tcp_payload))){
            input_error=tcp_fin_queued?10058:10055;UNLOCK(&mutex);free(copy);tcp_wake();break;
        }
        tcp_sends[(tcp_head+tcp_count)%(TCP_RECORDS+1)]=(tcp_send_t){kind,size?get32(payload):0,size,0,copy};
        tcp_count++;tcp_payload+=size;
        if(kind==CMD_FIN)tcp_fin_queued=1;else tcp_data_records++;
        UNLOCK(&mutex);tcp_wake();
    }
    LOCK(&mutex);stopped=1;UNLOCK(&mutex);tcp_wake();
}
static int tcp_prepare_wait(socket_t connection) {
#ifdef _WIN32
    tcp_input_event=CreateEvent(NULL,TRUE,FALSE,NULL);
    tcp_socket_event=WSACreateEvent();
    if(!tcp_input_event||tcp_socket_event==WSA_INVALID_EVENT)return 10055;
    if(WSAEventSelect(connection,tcp_socket_event,FD_READ|FD_WRITE|FD_OOB|FD_CLOSE)==SOCKET_ERROR)return native_error(SOCKERR());
#else
    (void)connection;
    if(pipe(tcp_input_pipe))return native_error(errno);
    if(fcntl(tcp_input_pipe[0],F_SETFL,O_NONBLOCK)||fcntl(tcp_input_pipe[1],F_SETFL,O_NONBLOCK))return native_error(errno);
#endif
    return 0;
}
static int tcp_acknowledge_wake(socket_t connection) {
#ifdef _WIN32
    WSANETWORKEVENTS events;
    ResetEvent(tcp_input_event);
    if(WSAEnumNetworkEvents(connection,tcp_socket_event,&events)==SOCKET_ERROR)return native_error(SOCKERR());
    /* A reset must remain observable even when receive credit is exhausted. */
    for(int bit=0;bit<FD_MAX_EVENTS;bit++)
        if((events.lNetworkEvents&(1L<<bit))&&events.iErrorCode[bit])return native_error(events.iErrorCode[bit]);
#else
    (void)connection;unsigned char bytes[128];
    while(read(tcp_input_pipe[0],bytes,sizeof(bytes))>0){}
#endif
    return 0;
}
static int tcp_wait(socket_t connection,int read_enabled,int write_enabled,int oob_enabled) {
#ifdef _WIN32
    (void)connection;(void)read_enabled;(void)write_enabled;(void)oob_enabled;
    HANDLE events[2]={tcp_input_event,tcp_socket_event};
    return WaitForMultipleObjects(2,events,FALSE,INFINITE)==WAIT_FAILED?10054:0;
#else
    struct pollfd events[2]={{tcp_input_pipe[0],POLLIN,0},{connection,0,0}};
    if(read_enabled)events[1].events|=POLLIN;
    if(write_enabled)events[1].events|=POLLOUT;
    if(oob_enabled)events[1].events|=POLLPRI;
    if(poll(events,2,-1)<0)return errno==EINTR?0:native_error(errno);
    if(events[1].revents&POLLNVAL)return 10038;
    if(events[1].revents&(POLLERR|POLLHUP)){
        int error=0;socklen_t length=sizeof(error);
        if(getsockopt(connection,SOL_SOCKET,SO_ERROR,&error,&length))return native_error(errno);
        if(error)return native_error(error);
        /* A graceful HUP can coexist with unread, credit-limited bytes. Wait
         * for the parent to return credit instead of spinning on that HUP. */
        if((events[1].revents&POLLHUP)&&!read_enabled&&!write_enabled&&!oob_enabled&&!(events[0].revents&POLLIN))
            if(poll(events,1,-1)<0&&errno!=EINTR)return native_error(errno);
    }
    return 0;
#endif
}
static int tcp_apply_control(socket_t connection,tcp_control_t control,int *inline_mode,int *urgent) {
    int level=control.option==2?IPPROTO_TCP:SOL_SOCKET;
    int option=control.option==0?SO_OOBINLINE:control.option==1?SO_KEEPALIVE:TCP_NODELAY;
    int value=(int)control.enabled;
    if(setsockopt(connection,level,option,(const char*)&value,sizeof(value))==SOCKET_ERROR)return native_error(SOCKERR());
    int observed=0;
#ifdef _WIN32
    int length=sizeof(observed);
#else
    socklen_t length=sizeof(observed);
#endif
    if(getsockopt(connection,level,option,(char*)&observed,&length)==SOCKET_ERROR)return native_error(SOCKERR());
    if(control.option==0){*inline_mode=observed!=0;*urgent=0;}
    /* Release command escrow before publishing its ACK to a reentrant parent. */
    LOCK(&mutex);tcp_control_head=(tcp_control_head+1)%TCP_CONTROLS;tcp_control_count--;UNLOCK(&mutex);
    unsigned char report[12];put32(report,control.id);put32(report+4,control.option);put32(report+8,observed!=0);
    return emit(EV_TCP_CONTROL,report,sizeof(report))?0:10054;
}
static uint32_t tcp_complete_send(void) {
    LOCK(&mutex);
    tcp_send_t *command=&tcp_sends[tcp_head];uint32_t id=command->id;
    tcp_payload-=command->length;if(command->kind!=CMD_FIN)tcp_data_records--;
    free(command->data);memset(command,0,sizeof(*command));
    tcp_head=(tcp_head+1)%(TCP_RECORDS+1);tcp_count--;UNLOCK(&mutex);
    return id;
}
static int tcp_run(socket_t connection,int inline_mode) {
    int eof=0,fin=0,urgent=0,failure=0;
    for(;;){
        failure=tcp_acknowledge_wake(connection);
        if(failure)break;
        LOCK(&mutex);
        int stop=stopped;failure=input_error;unsigned credit=receive_credit;
        tcp_send_t *command=tcp_count?&tcp_sends[tcp_head]:NULL;
        int have_control=tcp_control_count!=0;
        tcp_control_t control=have_control?tcp_controls[tcp_control_head]:(tcp_control_t){0,0,0};
        UNLOCK(&mutex);
        if(failure||stop)break;
        if(eof&&fin&&!command&&!have_control){if(!emit(EV_CLOSED,NULL,0))failure=10054;break;}
        int progress=0;
        if(have_control){
            failure=tcp_apply_control(connection,control,&inline_mode,&urgent);
            if(failure)break;
            progress=1;
        }
        fd_set reads,writes,exceptions;FD_ZERO(&reads);FD_ZERO(&writes);FD_ZERO(&exceptions);
        if(!eof&&credit){FD_SET(connection,&reads);if(!inline_mode)FD_SET(connection,&exceptions);}
        if(command&&command->kind!=CMD_FIN)FD_SET(connection,&writes);
        struct timeval immediate={0,0};
        int selected=(!eof&&credit)||(command&&command->kind!=CMD_FIN)?
            select((int)connection+1,&reads,&writes,&exceptions,&immediate):0;
        if(selected==SOCKET_ERROR){failure=native_error(SOCKERR());break;}
        /* FD_WRITE is rearmed only by a send returning WSAEWOULDBLOCK.
         * A select precheck alone cannot establish that subscription. */
        if(command){
            if(command->kind==CMD_FIN){
#ifdef _WIN32
                int result=shutdown(connection,SD_SEND);
#else
                int result=shutdown(connection,SHUT_WR);
#endif
                if(result==SOCKET_ERROR){failure=native_error(SOCKERR());break;}
                tcp_complete_send();fin=1;progress=1;
                if(!emit(EV_FINISHED,NULL,0)){failure=10054;break;}
            }else{
                int sent=send(connection,(const char*)command->data+command->offset,(int)(command->length-command->offset),command->kind==CMD_OOB?MSG_OOB:0);
                if(sent>0){
                    command->offset+=(unsigned)sent;progress=1;
                    if(command->offset==command->length){
                        uint32_t id=tcp_complete_send();
                        if(!emit32(EV_ACK,id)){failure=10054;break;}
                    }
                }else if(sent==SOCKET_ERROR&&SOCKERR()!=WOULD_BLOCK){failure=native_error(SOCKERR());break;}
            }
        }
        if(!inline_mode&&FD_ISSET(connection,&exceptions))urgent=1;
#ifdef _WIN32
        if(credit&&urgent){
            unsigned char prefix[SEGMENT];int peeked=recv(connection,(char*)prefix,(int)(credit<SEGMENT?credit:SEGMENT),MSG_PEEK);
            if(peeked>0){
                int n=recv(connection,(char*)prefix,peeked,0);
                if(n>0){
                    LOCK(&mutex);receive_credit-=(unsigned)n;UNLOCK(&mutex);credit-=(unsigned)n;
                    if(!emit(EV_DATA,prefix,(uint32_t)n)){failure=10054;break;}
                    progress=1;}
            }
        }
#endif
        if(credit&&urgent
#ifndef _WIN32
            &&at_mark(connection)
#endif
        ){
            unsigned char byte;int received=recv(connection,(char*)&byte,1,MSG_OOB);
            if(received==1){
                LOCK(&mutex);receive_credit--;UNLOCK(&mutex);credit--;
                if(!emit(EV_OOB,&byte,1)){failure=10054;break;}
                urgent=0;progress=1;
            }else if(received==SOCKET_ERROR&&SOCKERR()!=WOULD_BLOCK){failure=native_error(SOCKERR());break;}
        }
        if(credit&&!eof&&FD_ISSET(connection,&reads)){
            unsigned char data[SEGMENT];int limit=(int)(credit<SEGMENT?credit:SEGMENT);
#ifdef _WIN32
            int received=!inline_mode?recv(connection,(char*)data,limit,MSG_PEEK):limit;
            if(received>0)received=recv(connection,(char*)data,received,0);
#else
            int received=recv(connection,(char*)data,limit,0);
#endif
            if(received>0){
                /* Debit before publication: the parent may immediately return
                 * CREDIT as soon as it consumes this stdout record. */
                LOCK(&mutex);receive_credit-=(unsigned)received;UNLOCK(&mutex);credit-=(unsigned)received;
                if(!emit(EV_DATA,data,(uint32_t)received)){failure=10054;break;}
                progress=1;
            }else if(!received){eof=1;progress=1;if(!emit(EV_EOF,NULL,0)){failure=10054;break;}}
            else if(SOCKERR()!=WOULD_BLOCK){failure=native_error(SOCKERR());break;}
        }
        if(progress)continue;
        failure=tcp_wait(connection,!eof&&credit,command&&command->kind!=CMD_FIN,!inline_mode&&!eof&&credit);
        if(failure)break;
    }
    LOCK(&mutex);stopped=1;
    while(tcp_count){tcp_send_t *command=&tcp_sends[tcp_head];free(command->data);command->data=NULL;tcp_head=(tcp_head+1)%(TCP_RECORDS+1);tcp_count--;}
    UNLOCK(&mutex);tcp_wake();
    if(failure)emit32(EV_ERROR,(uint32_t)failure);
    return failure?1:0;
}
