import {expect,test} from "bun:test";
import type {InnoParseResult} from "@bottleship/formats/inno";
import {synthesizeInstallerManifest,normalizeInstallDir} from "@bottleship/repack/installer-layout";
import {synthesizeManifest} from "@bottleship/repack/manifest-synth";
const text=(s:string)=>new TextEncoder().encode(s);
const parsed={header:{appName:"Installer Title",appVersion:"1"},files:[],icons:[],
    directories:[{name:"{app}\\save"}],version:{isUnicode:()=>false},
    registryEntries:[{hive:2,key:"Software\\Fixture",name:"InstallDir",type:1,value:text("{app}\\\0")},
        {hive:2,key:"Software\\Fixture",name:"CD",type:1,value:text("D:\\CD\\\0")}]} as unknown as InnoParseResult;
function opts() {return {parsed,gameFiles:new Map([
    ["goggame-123.info",text(JSON.stringify({gameId:"123",name:"Localized Display",playTasks:[{isPrimary:true,path:"bin/game.exe",workingDir:"."}]}))],
    ["goggame-123.script",text(JSON.stringify({actions:[{install:{action:"setRegistry",arguments:{
        root:"HKLM",subkey:"Software\\Fixture",valueName:"Executable",valueType:"string",valueData:"{app}\\bin\\game.exe"}}}]}))]
])};}
test("new installer root joins primary task, registry, cwd and empty directories",()=>{
    const s=synthesizeInstallerManifest(opts());
    expect(s.installDir).toBe("C:\\Games\\gog-123");
    expect(s.romPrefix).toBe("rom/Games/gog-123/");
    expect(s.manifest.entrypoint).toBe("rom/Games/gog-123/bin/game.exe");
    expect((s.manifest.emulator as any).workingDir).toBe("C:\\Games\\gog-123");
    expect((s.manifest.emulator as any).createDirs).toEqual(["C:\\Games\\gog-123\\save"]);
    const values=(s.registry as any[])[0].values;
    expect(values.find((v:any)=>v.name==="InstallDir").data).toBe("C:\\Games\\gog-123\\");
    expect(values.find((v:any)=>v.name==="Executable").data).toBe("C:\\Games\\gog-123\\bin\\game.exe");
    expect(values.find((v:any)=>v.name==="CD").data).toBe("D:\\CD\\");
    expect(synthesizeInstallerManifest({...opts(),cli:{name:"Other title"}}).romPrefix).toBe(s.romPrefix);
});
test("explicit install-dir is coherent; legacy reg-install alone keeps root payload",()=>{
    const a=synthesizeInstallerManifest({...opts(),cli:{installDir:"c:/My Game/"}});
    expect(a.manifest.entrypoint).toBe("rom/My Game/bin/game.exe");
    expect((a.registry as any[])[0].values[0].data).toBe("C:\\My Game\\");
    const b=synthesizeInstallerManifest({...opts(),cli:{regInstall:"D:\\Legacy"}});
    expect(b.manifest.entrypoint).toBe("rom/bin/game.exe");
    expect((b.registry as any[])[0].values[0].data).toBe("D:\\Legacy\\");
    const c=synthesizeInstallerManifest({...opts(),cli:{installDir:"C:\\New",regInstall:"D:\\Intentional"}});
    expect(c.romPrefix).toBe("rom/New/");
    expect((c.registry as any[])[0].values[0].data).toBe("D:\\Intentional\\");
});
test("raw folder synth remains flat and existing absolute cwd/arguments stay intentional",()=>{
    const raw=synthesizeManifest(opts());
    expect(raw.manifest.entrypoint).toBe("rom/bin/game.exe");
    expect((raw.registry as any[])[0].values[0].data).toBe("C:\\");
    const s=synthesizeInstallerManifest({...opts(),cli:{args:"-cd D:\\MEDIA"},override:{manifest:{emulator:{workingDir:"D:\\MEDIA"}}}});
    expect(s.manifest.args).toBe("-cd D:\\MEDIA");
    expect((s.manifest.emulator as any).workingDir).toBe("D:\\MEDIA");
});
test("shortcut {app} args/cwd and safe fallback share install directory",()=>{
    const s=synthesizeInstallerManifest({parsed:{...parsed,icons:[{filename:"{app}\\bin\\game.exe",parameters:"-data {app}\\data",workingDir:"{app}"}]} as unknown as InnoParseResult,gameFiles:new Map()});
    expect(s.manifest.entrypoint).toBe("rom/Games/app-installer-title/bin/game.exe");
    expect(s.manifest.args).toBe("-data C:\\Games\\app-installer-title\\data");
    expect((s.manifest.emulator as any).workingDir).toBe("C:\\Games\\app-installer-title");
});
test("unsafe/foreign-drive installation paths fail before packing",()=>{
    for(const p of ["..","D:\\Game","C:Game","\\\\server\\share","C:\\..\\escape","C:\\Game\\.\\x","C:\\A:stream","C:\\CON","C:\\aux.txt","C:\\foo."])
        expect(()=>normalizeInstallDir(p)).toThrow();
    expect(normalizeInstallDir("C:\\")).toBe("C:\\");
});
