import {expect,test} from "bun:test";
import {LanNetwork} from "../../src/worker/net/lan-network";

test("UDP policy snapshot includes changes from reentrant transport and owns ACL",()=>{
    const net=new LanNetwork(),first={listeners:[{id:"a",allowedNodes:[[2,1,127,0,0,1]]}]};
    const second={listeners:[{id:"a",allowedNodes:[[2,1,127,0,0,2]]}]};
    let armed=false;
    net.attach({connected:true,send:()=>true,close(){},connectionState(){
        if(armed){armed=false;net.configureUdpHosts(second);}return true;
    }});
    net.configureUdpHosts(first);
    const old=net.udpHostPolicySnapshot();armed=true;
    const now=net.udpHostPolicySnapshot();
    expect(now.connected).toBe(true);expect(net.udpHostPolicyEpochCurrent(old.epoch)).toBe(false);
    expect(net.udpHostPolicyEpochCurrent(now.epoch)).toBe(true);
    expect(now.capability?.listeners[0].allowedNodes).toEqual([[2,1,127,0,0,2]]);
    second.listeners[0].allowedNodes[0][5]=3;
    expect(now.capability?.listeners[0].allowedNodes[0][5]).toBe(2);
    net.setConnected(false,"test");
    expect(net.udpHostPolicyEpochCurrent(now.epoch)).toBe(false);
});
test("transport retirement also invalidates TCP coherent policy epoch",()=>{
    const net=new LanNetwork();net.attach({connected:true,send:()=>true,close(){}});
    const snapshot=net.tcpHostPolicySnapshot();
    net.setConnected(false,"test");
    expect(net.tcpHostPolicyCurrentEpoch).not.toBe(snapshot.epoch);
});
