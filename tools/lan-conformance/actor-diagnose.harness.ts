import {harness,closeHarnessConnection} from '../harness';
try {await harness().logRing(20000).openWgb((await Bun.file('logs/lan-conformance/build.json').json()).bundle).run(); await Bun.sleep(1000); const result=await harness().logs(20000).run();
console.log(JSON.stringify(result.named.logs,null,2));} finally{closeHarnessConnection();}
