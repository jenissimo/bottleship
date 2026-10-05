import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const out = path.resolve(process.argv[2] || 'C:/Projects/bottleship-demos/demo_source_pair');
const sdk = path.resolve(process.env.EMSDK || 'C:/Projects/emsdk');
const vs = process.env.VSINSTALLDIR || 'C:/Program Files/Microsoft Visual Studio/2022/Community';
const kit = process.env.WindowsSdkDir || 'C:/Program Files (x86)/Windows Kits/10';
const newest = p => fs.readdirSync(p).filter(n => /^\d+\./.test(n)).sort((a,b) => b.localeCompare(a, undefined, {numeric:true}))[0];
const vc = path.join(vs, 'VC/Tools/MSVC', newest(path.join(vs, 'VC/Tools/MSVC')));
const kv = newest(path.join(kit, 'Include'));
const env = {...process.env,
    INCLUDE: [path.join(vc,'include'), ...['ucrt','shared','um'].map(n=>path.join(kit,'Include',kv,n))].join(';'),
    LIB: [path.join(vc,'lib/x86'), ...['ucrt','um'].map(n=>path.join(kit,'Lib',kv,n,'x86'))].join(';'),
    EM_CONFIG: path.join(sdk,'.emscripten'),
};
for (const n of ['out', 'rom', 'web', 'sources']) fs.mkdirSync(path.join(out,n), {recursive:true});
const history = [];
function run(exe, args, cwd=out, runEnv=env) {
    const r = spawnSync(exe,args,{cwd,env:runEnv,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
    history.push({exe,args,exitCode:r.status,stdout:r.stdout,stderr:r.stderr});
    if(r.error || r.status !== 0) {
        fs.writeFileSync(path.join(out,'build-failed.json'), JSON.stringify(history,null,2));
        throw Error(`${exe}: ${r.error || r.stderr || r.stdout}`);
    }
    return r.stdout;
}
const hash = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sources = fs.readdirSync(path.join(here,'fixture'));
for(const name of sources) fs.copyFileSync(path.join(here,'fixture',name),path.join(out,'sources',name));
const cl = path.join(vc,'bin/Hostx64/x86/cl.exe');
const common = ['/nologo','/c','/O2','/Ob2','/Oi','/GS-','/GR-','/EHs-c-','/GL-','/arch:IA32','/W4'];
for(const name of ['kernel','boundary','windows']) run(cl,[...common,
    `/Fo${path.join(out,'out',name+'.obj')}`, '/FAs', `/Fa${path.join(out,'out',name+'.asm')}`,
    path.join(out,'sources',name+'.cpp')]);
run(path.join(vc,'bin/Hostx64/x86/link.exe'),['/nologo','/MACHINE:X86','/SUBSYSTEM:CONSOLE','/ENTRY:mainCRTStartup',
    '/NODEFAULTLIB','/DYNAMICBASE:NO','/FIXED','/BASE:0x400000', '/OPT:REF','/OPT:ICF',
    `/MAP:${path.join(out,'out','pair.map')}`, `/OUT:${path.join(out,'rom','pair.exe')}`,
    ...['kernel','boundary','windows'].map(n=>path.join(out,'out',n+'.obj')), 'kernel32.lib']);
const python = path.join(sdk,'python',fs.readdirSync(path.join(sdk,'python')).find(n=>n.endsWith('_64bit')),'python.exe');
const emcc = path.join(sdk,'upstream/emscripten/em++.py');
run(python,[emcc,'--version']);
run(python,[emcc, ...['kernel','boundary','emscripten'].map(n=>path.join(out,'sources',n+'.cpp')),
    '-O3','-g2','-fno-exceptions','-fno-rtti','-fno-vectorize','-fno-slp-vectorize',
    '-sMODULARIZE=1','-sEXPORT_ES6=1','-sENVIRONMENT=web,worker,node','-sASYNCIFY=1',
    '-sEXPORTED_FUNCTIONS=["_pair_init","_pair_run","_pair_state","_pair_size"]',
    '-sEXPORTED_RUNTIME_METHODS=["ccall","HEAPU32"]', '-o',path.join(out,'web','pair.mjs')]);
run(path.join(sdk,'upstream/bin/wasm-dis.exe'),[path.join(out,'web','pair.wasm'),'-o',path.join(out,'web','pair.wat')]);
fs.writeFileSync(path.join(out,'out','pair.disasm.txt'),run(path.join(sdk,'upstream/bin/llvm-objdump.exe'),['-d','--x86-asm-syntax=intel',path.join(out,'rom','pair.exe')]));
fs.writeFileSync(path.join(out,'out','pair.headers.txt'),run(path.join(sdk,'upstream/bin/llvm-readobj.exe'),['--file-headers','--sections','--coff-exports','--coff-imports',path.join(out,'rom','pair.exe')]));
fs.writeFileSync(path.join(out,'rom','pair-service.bin'),'source-pair service fixture\n');
run(process.env.BUN_EXE || 'bun',['tools/make-wgb.ts',path.join(out,'rom'),path.join(out,'pair.wgb'),
    '--name','Source Pair Lab','--exe','pair.exe','--ram','128','--os','winnt','--args','73 16384 256 0 1 1'],repo);
const artifacts = ['rom/pair.exe','pair.wgb','web/pair.mjs','web/pair.wasm','web/pair.wat','out/pair.map','out/pair.disasm.txt','out/pair.headers.txt'];
const manifest = {schema:1,builtAt:new Date().toISOString(),repo,out,emsdk:sdk,msvc:vc,windowsSdk:kv,
    host:{hostname:os.hostname(),release:os.release(),arch:os.arch()},
    policy:{pe:'MSVC /O2, IA32, no CRT, no LTO',direct:'Emscripten -O3 scalar, Asyncify, no LTO',
        note:'Same payload; host adapters have different cost. Asyncify is present in all direct modes.'},
    sources:Object.fromEntries(sources.map(n=>[n,hash(path.join(out,'sources',n))])),
    artifacts:Object.fromEntries(artifacts.map(n=>[n,{sha256:hash(path.join(out,n)),bytes:fs.statSync(path.join(out,n)).size}])),history};
fs.writeFileSync(path.join(out,'build.json'),JSON.stringify(manifest,null,2));
fs.writeFileSync(path.join(out,'README.md'),`# Source Pair Lab\n\nCanonical sources and runners: ${here}\n\nRebuild: \`node "${path.join(here,'build.mjs')}" "${out}"\`\n\nSee build.json for exact toolchain commands and artifact hashes. Sources here are build snapshots.\n`);
console.log(JSON.stringify({out,pe:manifest.artifacts['rom/pair.exe'],wasm:manifest.artifacts['web/pair.wasm']}));
