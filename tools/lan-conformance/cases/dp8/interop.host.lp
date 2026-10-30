# STATUS: scripts encode the design; no goldens — native two-process DP8 over the adapter socket
# STATUS: does not complete yet (host receives no query; adapter/firewall diagnosis pending).
# Native DP8 host role: hosts on a real adapter socket and confirms the
# guest's datagram through the coordinator. Runs natively under --as.
cominit
h = cocreate CLSID_DirectPlay8Peer IID_IDirectPlay8Peer
initialize h
x = cocreate CLSID_DirectPlay8Address IID_IDirectPlay8Address
setsp x CLSID_DP8SP_TCPIP
addport x 23913
setdevice x adapter
settraversal x 0
host h x session
publiship host 127.0.0.1 23913
cbwait receive 1 t=30000
signal got-ping
dp8close h
release h
comfree
