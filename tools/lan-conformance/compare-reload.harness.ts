/** Compare two PE boots in one Worker, including actual guest IPC teardown. */
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { harness, closeHarnessConnection } from '../harness';
const buildPath=resolve(process.env.BS_ORACLE_BUILD ?? 'logs/lan-conformance/directplay-lobby/build.json');
const build=await Bun.file(buildPath).json();
const reference=new Uint8Array(await Bun.file(build.reference).arrayBuffer());
const header=new DataView(reference.buffer), nonce=header.getUint32(8,true);
if(header.getUint32(0,true)!==0x42534c4e || header.getUint32(4,true)*4!==reference.length)throw Error('Invalid native record');
const negative=process.env.BS_IPC_RELOAD_NEGATIVE==='1';
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
if(build.referenceSha256 && digest(reference)!==build.referenceSha256)throw Error('Native reference changed');
async function call(name:string,...args:unknown[]){
    const answer=await harness().call(name,...args).run();
    if(!answer.ok)throw Error(JSON.stringify(answer));
    return answer.named[name] as any;
}
async function completed(){
    const deadline=Date.now()+30000;
    let lastIpc: unknown = null, lastDataSha256: string | null = null;
    while(Date.now()<deadline){
        const result=await harness().fsRead('C:\\lan-oracle.bin').run();
        const encoded=(result.named.fsRead as {content?:string}|undefined)?.content;
        if(result.ok && encoded){
            const data=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0)),view=new DataView(data.buffer);
            if(data.length===reference.length && view.getUint32(8,true)===nonce){
                const state=await call('processIpcState');
                lastIpc=state; lastDataSha256=digest(data);
                if(state && !state.alive && state.pending===0)return{data,state};
            }
        }
        await Bun.sleep(500);
    }
    const report=await harness().report().run();
    const evidence={fixture:build.fixture,nonce,negative,referenceSha256:digest(reference),lastDataSha256,lastIpc,report};
    const output=join(dirname(buildPath),'same-worker-failure-'+nonce+'.json');
    await Bun.write(output,JSON.stringify(evidence,null,2)+'\n');
    throw Error('Guest did not complete: '+JSON.stringify({output,lastIpc,lastDataSha256,referenceSha256:digest(reference)}));
}
try{
    const firstLoad=await harness().openWgb(build.bundle).run();
    if(!firstLoad.ok)throw Error(JSON.stringify(firstLoad));
    const first=await completed();
    if(digest(first.data)!==digest(reference))throw Error('First PE observations differ');
    const marker=await call('evalWorker',
        'state.ipcReloadMarker = {timeOrigin:performance.timeOrigin, generation:System.getInstance().process.resetGeneration}; return state.ipcReloadMarker;');
    if(negative)await call('evalWorker',
        'state.originalIpcExit=System.getInstance().postProcessExitWhenDurable; System.getInstance().postProcessExitWhenDurable=function(){ state.suppressedIpcExit=true; }; return true;');
    const nextLoad=await harness().openWgb(build.bundle,{reload:false}).run();
    if(!nextLoad.ok)throw Error(JSON.stringify(nextLoad));
    const next=await completed();
    if(digest(next.data)!==digest(reference))throw Error('Second PE observations differ');
    const after=await call('evalWorker',
        'return {marker:state.ipcReloadMarker??null,timeOrigin:performance.timeOrigin,generation:System.getInstance().process.resetGeneration};');
    if(!after.marker || after.timeOrigin!==marker.timeOrigin || after.marker.generation!==marker.generation ||
        after.generation<=marker.generation || next.state.generation<=first.state.generation)throw Error('Worker was replaced or guest lifetime did not advance');
    const proof={fixture:build.fixture,nonce,comparedAt:new Date().toISOString(),
        observationsPerBoot:reference.length/4-3,boots:2,executableSha256:build.executableSha256,
        referenceSha256:digest(reference),firstSha256:digest(first.data),secondSha256:digest(next.data),
        firstIpc:first.state,secondIpc:next.state,worker:after};
    const output=join(dirname(buildPath),'same-worker-'+nonce+'.json');
    await Bun.write(output,JSON.stringify(proof,null,2)+'\n');
    console.log(JSON.stringify({output,...proof},null,2));
}finally{
    if(negative)await call('evalWorker','if(state.originalIpcExit){System.getInstance().postProcessExitWhenDurable=state.originalIpcExit;delete state.originalIpcExit;} return true;').catch(()=>{});
    closeHarnessConnection();
}
