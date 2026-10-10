#!/usr/bin/env bun
/** Capture a catalog card at desktop and phone sizes through the project's CDP transport. */
import {connect, DEFAULT_DEV_URL, pageEval, screenshot} from './cdp-core';
import {applyDevice} from './cdp-touch';
import {resolve} from 'node:path';

const [id, rawUrl=DEFAULT_DEV_URL, out='logs/catalog-preview']=process.argv.slice(2);
if (!id) throw new Error('usage: catalog-preview <game-id> [dev-url] [output-directory] (BS_TAB selects the owned tab)');
const url=new URL(rawUrl);
url.searchParams.delete('game');
url.searchParams.delete('load');
if (process.env.BS_TAB) url.searchParams.set('bs',process.env.BS_TAB);
const {session}=await connect({urlMatch:url.origin});
try {
    await session.send('Page.navigate',{url:url.href});
    for (const profile of ['desktop','phone-portrait']) {
        await applyDevice(session,profile);
        const card=await pageEval(session,`(async()=>{
            const r=await fetch('/games-catalog.json');
            const g=(await r.json()).find(g=>g.id===${JSON.stringify(id)});
            if (!g?.enabled) throw new Error('catalog entry missing or disabled');
            let card;
            for(let i=0;i<100;i++) {
                card=[...document.querySelectorAll('article[role="button"]')].find(e=>[...e.querySelectorAll('div')].some(d=>d.textContent===g.name));
                if(card) break;
                await new Promise(r=>setTimeout(r,100));
            }
            if (!card) throw new Error('catalog card missing');
            card.scrollIntoView({block:'center'});
            await new Promise(r=>setTimeout(r,1000));
            const rect=card.getBoundingClientRect();
            const images=[...card.querySelectorAll('img')];
            return {id:g.id,title:g.name,text:card.innerText,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},viewport:{width:innerWidth,height:innerHeight},overflow:document.documentElement.scrollWidth>innerWidth,brokenImages:images.filter(i=>!i.complete||!i.naturalWidth).length,enabled:card.tabIndex>=0};
        })()`);
        if (!card.enabled || card.overflow || card.brokenImages || card.rect.x<0 || card.rect.x+card.rect.width>card.viewport.width+1) {
            throw new Error(`catalog layout failed: ${JSON.stringify(card)}`);
        }
        const file=resolve(out,`${id}-${profile}.png`);
        await Bun.write(file,Buffer.from(await screenshot(session),'base64'));
        await Bun.write(resolve(out,`${id}-${profile}.json`),JSON.stringify(card,null,2));
        console.log(JSON.stringify({profile,...card,file}));
    }
} finally {
    await applyDevice(session,'desktop').catch(()=>{});
    session.close();
}
