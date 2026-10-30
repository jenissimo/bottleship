# STATUS: scripts encode the design; no goldens — native two-process DP8 over the adapter socket
# STATUS: does not complete yet (host receives no query; adapter/firewall diagnosis pending).
# Emulated DP8 peer role: connects to the native host's published address
# (through the relay gateway under --as) and waits for the coordinator
# confirmation that the datagram arrived.
cominit
p = cocreate CLSID_DirectPlay8Peer IID_IDirectPlay8Peer
initialize p
y = cocreate CLSID_DirectPlay8Address IID_IDirectPlay8Address
setsp y CLSID_DP8SP_TCPIP
addport y 23913
d = cocreate CLSID_DirectPlay8Address IID_IDirectPlay8Address
setsp d CLSID_DP8SP_TCPIP
addport d 23914
setdevice d adapter
hostaddr = waitaddr host t=30000
addhostfromaddr y hostaddr
dp8connect p y d
cbwait connect-complete 1 t=30000
sendpeer p 1 "ping"
gate got-ping t=30000
dp8close p
release p
comfree
