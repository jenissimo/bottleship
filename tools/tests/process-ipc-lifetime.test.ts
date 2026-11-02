import { afterEach, expect, test } from 'bun:test';
import { ProcessIpc } from '../../src/worker/core/process-ipc';
import { DirectPlayLobbyEndpoint } from '../../src/worker/modules/dplayx/lobby-broker';
import { DirectPlay8LobbyEndpoint } from '../../src/worker/modules/dpnlobby/broker';
import { DP } from '../../src/worker/modules/dplayx/session';
import { DPN } from '../../src/worker/modules/dpnet/constants';
const nodes: ProcessIpc[] = [];
afterEach(() => { for (const node of nodes.splice(0)) node.close(); });
function node(pid=1234) { const ipc=new ProcessIpc(pid,1234); nodes.push(ipc); return ipc; }
function child(root: ProcessIpc,pid=5000) {
    const ipc=node(pid),channel=new MessageChannel(),close=root.connectChild(pid,channel.port1);
    ipc.adoptParent(channel.port2); return {ipc,close};
}
const tick=async()=>{for(let i=0;i<4;i++)await Promise.resolve();};
test('a root guest can restart after child routes retire, while its service survives guest exit', async()=>{
    const root=node(),peer=child(root); let services=0;
    root.registerSystem('host',()=>++services);
    root.markProcessExited(root.pid);
    expect(await peer.ipc.request(0,'host',null)).toBe(1);
    expect(()=>root.beginGuestLifetime()).toThrow('Previous IPC guest routes are still active');
    peer.close(); const generation=root.guestGeneration; root.beginGuestLifetime();
    expect(root.guestGeneration).toBeGreaterThan(generation);
    root.register('guest',data=>data);
    expect(await root.request(root.pid,'guest',42)).toBe(42);
    expect(await root.request(0,'host',null)).toBe(2);
});
test('self exit rejects pending requests and fences both old handlers and queued self service calls',async()=>{
    const root=node(); let oldResolve!:(value:number)=>void, serviceCalls=0;
    root.register('guest',()=>new Promise<number>(resolve=>{oldResolve=resolve;}));
    root.registerSystem('host',()=>++serviceCalls);
    const old=root.request(root.pid,'guest',null).catch(error=>error);
    await tick();
    const staleService=root.request(0,'host',null).catch(error=>error);
    root.markProcessExited(root.pid);
    root.beginGuestLifetime();
    root.register('guest',()=>88);
    expect(await old).toMatchObject({code:'CLOSED'});
    expect(await staleService).toMatchObject({code:'CLOSED'});
    oldResolve(77); await tick();
    expect(serviceCalls).toBe(0);
    expect(await root.request(root.pid,'guest',null)).toBe(88);
    expect(await root.request(0,'host',null)).toBe(1);
});
test('service calls from a live child complete after the root guest exits',async()=>{
    const root=node(),peer=child(root); let ready!:(value:number)=>void;
    root.registerSystem('host',()=>new Promise<number>(resolve=>{ready=resolve;}));
    const answer=peer.ipc.request(0,'host',null);
    for(let i=0;i<100&&!ready;i++)await Bun.sleep(1);
    expect(ready).toBeFunction(); root.markProcessExited(root.pid); ready(77);
    expect(await answer).toBe(77);
});
test('closed child links cannot inject work into the next root lifetime',async()=>{
    const root=node(),old=child(root); let handled=0;
    root.registerSystem('host',()=>++handled);
    old.close(); root.markProcessExited(root.pid); root.beginGuestLifetime();
    expect(old.ipc.post(0,'host',null)).toBe(true);
    await Bun.sleep(4); expect(handled).toBe(0);
    const next=child(root,5001);
    expect(await next.ipc.request(0,'host',null)).toBe(1);
});
test('an old classic lobby endpoint cannot erase the next guest registration or unregister its notification',async()=>{
    const root=node(),old=new DirectPlayLobbyEndpoint(root);
    root.markProcessExited(root.pid); root.beginGuestLifetime();
    const next=new DirectPlayLobbyEndpoint(root),application='a'.repeat(32);
    expect(await next.call({op:'wait',application,flags:0})).toEqual({hr:DP.OK});
    old.close();
    expect(await next.call({op:'findWaiting',application})).toEqual({hr:DP.OK,pid:root.pid});
    expect(await old.call({op:'wait',application,flags:0})).toEqual({hr:DP.UNAVAILABLE});
    expect(await next.call({op:'wait',flags:1})).toEqual({hr:DP.OK}); next.close();
});
test('an old DirectPlay8 endpoint cannot dispatch operations into the next guest lifetime',async()=>{
    const root=node(),old=new DirectPlay8LobbyEndpoint(root);
    expect((await old.call({op:'initialize',token:10})).hr).toBe(DPN.OK);
    expect((await old.call({op:'enum',token:10})).hr).toBe(DPN.OK);
    root.markProcessExited(root.pid); root.beginGuestLifetime();
    const next=new DirectPlay8LobbyEndpoint(root);
    expect((await next.call({op:'initialize',token:20})).hr).toBe(DPN.OK);
    expect((await old.call({op:'enum',token:20})).hr).toBe(DPN.CONNECTIONLOST);
    old.close(); expect((await next.call({op:'enum',token:20})).hr).toBe(DPN.OK); next.close();
});
