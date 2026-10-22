import {expect,test} from 'bun:test';
import {join} from 'node:path';
for(const mode of ['reply','timeout']){
    test('CDP evaluation '+mode+' releases its transport and deadline before process exit',async()=>{
        const child=Bun.spawn([process.execPath,join(import.meta.dir,'helpers/cdp-eval-process.ts'),mode],{
            stdout:'pipe',stderr:'pipe',
        });
        let timedOut=false;
        const deadline=setTimeout(()=>{timedOut=true;child.kill()},1500);
        try{
            const [code,output,errors]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
            expect({timedOut,code,errors}).toEqual({timedOut:false,code:0,errors:''});
            expect(output).toContain('evaluation verified '+mode);
        }finally{clearTimeout(deadline);if(child.exitCode===null)child.kill()}
    });
}
