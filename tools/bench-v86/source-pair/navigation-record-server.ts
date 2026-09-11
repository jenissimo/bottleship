import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dir,'../../..');
const directory=fs.mkdtempSync(path.join(root,'logs','nfsu-navigation-'));
const origin='http://127.0.0.1:5174';
const headers={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'};
const server=Bun.serve({hostname:'127.0.0.1',port:0,maxRequestBodySize:16*1024*1024,async fetch(req){
 if(req.headers.get('origin')!==origin)return new Response('origin refused',{status:403});
 if(req.method==='OPTIONS')return new Response(null,{headers});
 if(req.method!=='POST'||new URL(req.url).pathname!=='/record')return new Response('not found',{status:404,headers});
 try{const row=await req.json();if(!Number.isSafeInteger(row.seq)||row.seq<0||typeof row.kind!=='string')throw Error('Invalid record');
 const name=String(row.seq).padStart(6,'0');
 if(row.kind==='checkpoint'&&row.data?.shot?.base64){fs.writeFileSync(path.join(directory,name+'.png'),Buffer.from(row.data.shot.base64,'base64'),{flag:'wx'});row.data.shot={file:name+'.png'};}
 fs.writeFileSync(path.join(directory,name+'.json'),JSON.stringify(row,null,2),{flag:'wx'});
 return Response.json({saved:true},{headers});}catch(e){return Response.json({error:String(e)},{status:400,headers});}
}});
fs.writeFileSync(path.join(import.meta.dir,'navigation-record-config.json'),JSON.stringify({endpoint:`http://127.0.0.1:${server.port}/record`,directory}));
console.log(JSON.stringify({directory,port:server.port}));
