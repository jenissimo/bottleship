# emu-skip DIRECTPLAY self-loopback through the namespace backplane is broken (generic fix pending)
# Two DirectPlay 8 peer objects in one process: host over loopback, connect,
# exchange one datagram each way. The second receive proves the datagram
# reached the host player and the reply reached the client player.
cominit
a = cocreate CLSID_DirectPlay8Peer IID_IDirectPlay8Peer
initialize a
b = cocreate CLSID_DirectPlay8Peer IID_IDirectPlay8Peer
initialize b
x = cocreate CLSID_DirectPlay8Address IID_IDirectPlay8Address
setsp x CLSID_DP8SP_TCPIP
addport x 23913
setdevice x adapter
settraversal x 0
host a x session
y = cocreate CLSID_DirectPlay8Address IID_IDirectPlay8Address
setsp y CLSID_DP8SP_TCPIP
addport y 23913
addhost y 127.0.0.1
d = cocreate CLSID_DirectPlay8Address IID_IDirectPlay8Address
setsp d CLSID_DP8SP_TCPIP
addport d 23914
setdevice d adapter
dp8connect b y d
cbwait connect-complete 1 t=15000
cbwait create-player 4 t=15000
sendpeer b 1 "ping"
cbwait receive 1 t=15000
sendpeer a last "ack"
cbwait receive 2 t=15000
dp8close a
dp8close b
release y
release x
release b
release a
comfree
