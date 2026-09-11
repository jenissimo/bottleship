// Run inline MOVHPS/MOVLHPS and MULPD regressions against the selected built engine.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
for(const [test,...args] of [['sse-flag-contract-diff.mjs'],['sse-move-pagefault.mjs'],['sse-move-pagefault.mjs','--mulpd']]){
    const p=spawnSync(process.execPath,[path.join(root,'vendor/v86/tests',test),...args],{
        cwd:root,env:{...process.env,V86_INLINE_SSE_MOVE:'1'},stdio:'inherit'});
    if(p.error)throw p.error;
    if(p.status!==0)process.exit(p.status||1);
}
