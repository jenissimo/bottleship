const output=document.querySelector('#output'),button=document.querySelector('#export');
const hash=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');
button.onclick=async()=>{
    button.disabled=true;output.textContent='Reading saved cache…';
    try{
        const root=await navigator.storage.getDirectory();
        const bs=await root.getDirectoryHandle('bottleship'),games=await bs.getDirectoryHandle('games');
        const game=await games.getDirectoryHandle('app-nfs-underground'),aot=await game.getDirectoryHandle('aot');
        const result={schema:1,mode:'game-capture',source:'saved-opfs-aot',origin:location.origin,status:'ok',rows:[]};
        for await(const [key,dir] of aot.entries()){
            if(dir.kind!=='directory')continue;
            const indexFile=await(await dir.getFileHandle('index.json')).getFile();
            const indexText=await indexFile.text(),index=JSON.parse(indexText),units=[];
            for(const u of index.units){
                if(u.file!==`${u.entryPage.toString(16)}.wasm`)throw Error('Unexpected filename');
                const bytes=await(await(await dir.getFileHandle(u.file)).getFile()).arrayBuffer();
                if(bytes.byteLength!==u.bytes)throw Error('Stored byte length mismatch');
                let binary='';for(const b of new Uint8Array(bytes))binary+=String.fromCharCode(b);
                units.push({...u,base64:btoa(binary),sha256:await hash(bytes)});
            }
            if(await(await(await dir.getFileHandle('index.json')).getFile()).text()!==indexText)throw Error('Index changed during export');
            result.rows.push({key,indexLastModified:indexFile.lastModified,aot:{version:index.version,units}});
            output.textContent+=`\n${key}: ${units.length} units, ${units.reduce((n,u)=>n+u.bytes,0)} bytes`;
        }
        if(!result.rows.length)throw Error('No saved AOT versions');
        const cfg=await(await fetch('/apps/source-pair-lab/config.json')).json();
        const response=await fetch(cfg.collector,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
        if(!response.ok)throw Error('Collector HTTP '+response.status);
        output.textContent+='\nSaved to local collector.';
    }catch(e){output.textContent+='\n'+String(e.stack||e);}
    finally{button.disabled=false;}
};
