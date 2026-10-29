# select readiness for a TCP listener and connected data, poll timeout,
# and orderly EOF after SD_SEND shutdown.
wsastartup 0x202
l = socket AF_INET SOCK_STREAM 0
bind l 127.0.0.1:0
listen l 2
c = socket AF_INET SOCK_STREAM 0
bind c 127.0.0.1:0
select t=50 r=l
connect c l.addr
select t=500 r=l
a = accept l
select t=50 r=a
send c "ping"
sleep 200
select t=500 r=a
recv a 64
send a "pong"
sleep 200
select t=500 r=c
recv c 64
ioctlsocket c FIONREAD
shutdown c SD_SEND
select t=500 r=a
recv a 64
closesocket c
closesocket a
closesocket l
wsacleanup
