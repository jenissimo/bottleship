/* Strict command-line parsing; each rejected owned helper exits before listening. */
const {spawnSync}=require("node:child_process");
const {strict:assert}=require("node:assert");
const helper=process.argv[2];assert(helper);
const valid=["127.0.0.1","0","127.0.0.1","1","19",process.platform==="win32"?"fd:3":"3"];
for(const [index,bad] of [[1," 1"],[1," +1"],[1,"+1"],[1,"-1"],[1,"1x"],[1,"4294967296"],
    [3," 1"],[3,"+1"],[4,"19x"],[4,"4294967296"],[5," 3"],[5,"3x"],
    [5,process.platform==="win32"?"fd: 3":"4294967296"]]) {
    const args=valid.slice();args[index]=bad;
    const result=spawnSync(helper,args,{stdio:["pipe","pipe","pipe","pipe"],timeout:3000,windowsHide:true});
    assert.equal(result.error,undefined,JSON.stringify({args,error:result.error}));
    assert.equal(result.status,2,JSON.stringify({args,status:result.status,signal:result.signal}));
}
for(const acl of ["","127.0.0.1,","127.0.0.1,,127.0.0.2","127.0.0.1,127.0.0.1","224.0.0.1"]) {
    const args=valid.slice();args[2]=acl;
    const result=spawnSync(helper,args,{stdio:["pipe","pipe","pipe","pipe"],timeout:3000,windowsHide:true});
    assert.equal(result.error,undefined,JSON.stringify({acl,error:result.error}));
    assert.equal(result.status,2,JSON.stringify({acl,status:result.status,signal:result.signal}));
}
console.log("native accept CLI rejects malformed integers and ACL: ok");
