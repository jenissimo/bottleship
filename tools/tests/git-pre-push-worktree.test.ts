import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

test('pre-push in a linked worktree accepts published submodule pins and refuses unpublished ones',()=>{
    const root=mkdtempSync(join(tmpdir(),'bs-pre-push-'));
    const hookDir=fileURLToPath(new URL('../../.githooks',import.meta.url));
    const git=(cwd:string,args:string[],required=true)=>{
        const r=Bun.spawnSync(['git',...args],{cwd,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
        if(required&&r.exitCode)throw new Error(r.stderr.toString()+r.stdout.toString());
        return {code:r.exitCode,out:r.stdout.toString().trim(),err:r.stderr.toString()};
    };
    const init=(path:string,bare=false)=>{
        mkdirSync(path,{recursive:true});git(path,['init','--initial-branch=main',...(bare?['--bare']:[])]);
        if(!bare){git(path,['config','user.name','Hook Test']);git(path,['config','user.email','hook@example.invalid']);}
    };
    try {
        const source=join(root,'sub-source'),remote=join(root,'sub.git');
        init(source);init(remote,true);writeFileSync(join(source,'data'),'published');
        git(source,['add','data']);git(source,['commit','-m','published']);
        const published=git(source,['rev-parse','HEAD']).out;
        git(source,['remote','add','origin',remote]);git(source,['push','origin','main']);
        writeFileSync(join(source,'data'),'unpublished');git(source,['commit','-am','unpublished']);
        const unpublished=git(source,['rev-parse','HEAD']).out;
        const parent=join(root,'parent'),parentRemote=join(root,'parent.git'),linked=join(root,'linked');
        init(parent);init(parentRemote,true);
        mkdirSync(join(parent,'vendor'),{recursive:true});
        git(parent,['clone',remote,'vendor/v86']);
        git(parent,['config','-f','.gitmodules','submodule.vendor/v86.path','vendor/v86']);
        git(parent,['config','-f','.gitmodules','submodule.vendor/v86.url',remote]);
        git(parent,['add','.gitmodules']);
        git(parent,['update-index','--add','--cacheinfo',`160000,${published},vendor/v86`]);
        git(parent,['commit','-m','parent']);git(parent,['remote','add','origin',parentRemote]);
        git(parent,['worktree','add','-b','task',linked]);
        const sub=join(linked,'vendor','v86');mkdirSync(sub,{recursive:true});
        writeFileSync(join(sub,'.git'),`gitdir: ${join(parent,'vendor','v86','.git').replaceAll('\\','/')}\n`);
        git(linked,['config','core.hooksPath',hookDir]);
        const accepted=git(linked,['push','origin','HEAD:refs/heads/published'],false);
        expect(accepted.code,accepted.err).toBe(0);
        git(linked,['update-index','--cacheinfo',`160000,${unpublished},vendor/v86`]);
        git(linked,['commit','-m','unpublished pin']);
        const refused=git(linked,['push','origin','HEAD:refs/heads/unpublished'],false);
        expect(refused.code).not.toBe(0);expect(refused.err).toContain('is not on its remote');
        expect(git(parentRemote,['show-ref','--verify','refs/heads/unpublished'],false).code).not.toBe(0);
    } finally {
        const actual=realpathSync(root),base=realpathSync(tmpdir());
        if(!resolve(actual).startsWith(resolve(base)+'\\')&&!resolve(actual).startsWith(resolve(base)+'/'))throw Error('unsafe fixture cleanup');
        rmSync(actual,{recursive:true,force:true});
    }
},20000);
