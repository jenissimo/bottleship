import {expect,test} from "bun:test";
import {DirectPlay4JoinTransaction} from "../../src/worker/modules/dplayx/native-wire/join-transaction";

function lease() {let releases=0;return {release(){releases++;},count:()=>releases};}
test("ordered phases transfer the exact lease once, without claiming publication",()=>{
    const tx=new DirectPlay4JoinTransaction(()=>true), owned=lease();
    expect(tx.playerIdReceived()).toBe(false);
    expect(tx.commit()).toBeUndefined();
    expect(tx.adopt(owned)).toBe(true);
    expect(tx.adopt(owned)).toBe(false);
    expect(owned.count()).toBe(0);
    expect(tx.nameTableReceived()).toBe(false);
    expect(tx.playerIdReceived()).toBe(true);
    expect(tx.nameTableReceived()).toBe(true);
    expect(tx.commit()).toBe(owned);
    expect(tx.stage).toBe("committed");
    tx.cancel();expect(owned.count()).toBe(0);
    expect(tx.current()).toBe(false);
});

test("late duplicate and reentrant adoption never release a transferred lease",async()=>{
    let onCheck=()=>{};
    const tx=new DirectPlay4JoinTransaction(()=>{onCheck();return true;}), owned=lease();
    expect(tx.adopt(owned)).toBe(true);
    expect(tx.playerIdReceived()).toBe(true);
    expect(tx.nameTableReceived()).toBe(true);
    onCheck=()=>{expect(tx.adopt(owned)).toBe(false);};
    expect(tx.commit()).toBe(owned);
    await Promise.resolve().then(()=>{expect(tx.adopt(owned)).toBe(false);});
    expect(owned.count()).toBe(0);
    tx.cancel();expect(owned.count()).toBe(0);
});
test("reentrant adoption of the same lease cannot make outer adopt release it",()=>{
    const owned=lease();
    let nested=false,inner=false;
    const tx=new DirectPlay4JoinTransaction(()=>{
        if (!nested) {nested=true;inner=tx.adopt(owned);}
        return true;
    });
    expect(tx.adopt(owned)).toBe(false);
    expect(inner).toBe(true);expect(owned.count()).toBe(0);
    expect(tx.playerIdReceived()).toBe(true);
    expect(tx.nameTableReceived()).toBe(true);
    expect(tx.commit()).toBe(owned);
    expect(tx.adopt(owned)).toBe(false);expect(owned.count()).toBe(0);
});
test("cancel retires old exact lease, aborts and disposes a late result only once",()=>{
    const tx=new DirectPlay4JoinTransaction(()=>true), old=lease(), late=lease();
    expect(tx.adopt(old)).toBe(true);
    let observed="";
    tx.signal.addEventListener("abort",()=>{observed=tx.stage;tx.cancel();tx.adopt(old);});
    tx.cancel();
    expect(observed).toBe("cancelled");expect(old.count()).toBe(1);
    expect(tx.adopt(late)).toBe(false);expect(tx.adopt(late)).toBe(false);
    expect(late.count()).toBe(1);expect(tx.playerIdReceived()).toBe(false);
});

test("loss of cache or transport ownership blocks the next stage and retires lease",()=>{
    let cache=true,transport=true;
    const tx=new DirectPlay4JoinTransaction(()=>cache&&transport), owned=lease();
    expect(tx.adopt(owned)).toBe(true);
    cache=false;
    expect(tx.playerIdReceived()).toBe(false);expect(tx.signal.aborted).toBe(true);
    expect(owned.count()).toBe(1);
    cache=true;transport=true;
    expect(tx.nameTableReceived()).toBe(false);expect(tx.stage).toBe("cancelled");
});

test("reentrant invalidation during liveness never advances or transfers",()=>{
    let action:()=>void=()=>{};
    const tx=new DirectPlay4JoinTransaction(()=>{action();return true;}), owned=lease();
    expect(tx.adopt(owned)).toBe(true);
    action=()=>tx.cancel();
    expect(tx.playerIdReceived()).toBe(false);
    expect(tx.stage).toBe("cancelled");expect(owned.count()).toBe(1);
    expect(tx.commit()).toBeUndefined();
});

test("old late completion cannot release a replacement attempt",()=>{
    let current=true;
    const oldTx=new DirectPlay4JoinTransaction(()=>current), newTx=new DirectPlay4JoinTransaction(()=>true);
    const old=lease(), replacement=lease();
    current=false;
    expect(oldTx.adopt(old)).toBe(false);expect(old.count()).toBe(1);
    expect(newTx.adopt(replacement)).toBe(true);oldTx.cancel();
    expect(replacement.count()).toBe(0);
    expect(newTx.playerIdReceived()).toBe(true);
    expect(newTx.nameTableReceived()).toBe(true);
    expect(newTx.commit()).toBe(replacement);
});

test("liveness exceptions fail closed",()=>{
    const tx=new DirectPlay4JoinTransaction(()=>{throw new Error("transport gone");}), owned=lease();
    expect(tx.adopt(owned)).toBe(false);
    expect(owned.count()).toBe(1);
    expect(tx.stage).toBe("cancelled");
});
