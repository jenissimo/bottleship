import { readWwtBundle } from "./wwt-bundle";

const provider = "/wwt-provider/";
const url = (path: string) => new URL(provider + path, location.href).href;
const dependency = (path: string) => import(/* @vite-ignore */ url(path));
const terminal = new TextDecoder("windows-1252");

export async function openWwtPlayer(root: HTMLElement, load: string | null) {
    const status = document.createElement("p");
    const chooser = document.createElement("input");
    chooser.type = "file";
    chooser.accept = ".wgb";
    chooser.setAttribute("aria-label", "Open a WGB game");
    const stage = document.createElement("div");
    Object.assign(stage.style, { position: "relative", width: "min(100%, 1024px)" });
    const screen = document.createElement("canvas");
    screen.width = 1024; screen.height = 768; screen.tabIndex = 0;
    screen.style.width = "100%";
    stage.append(screen);
    root.replaceChildren(status, chooser, stage);
    status.textContent = "Open a WGB to run with the experimental WWT engine.";
    let active = false;
    async function launch(blob: Blob) {
        if (active) return;
        active = true;
        chooser.disabled = true;
        const surface = document.createElement("canvas");
        Object.assign(surface.style, {position: "absolute", pointerEvents: "none"});
        surface.hidden = true;
        stage.append(surface);
        const lifetime = new AbortController();
        const options = { signal: lifetime.signal };
        let worker: Worker | undefined, audio: AudioContext | undefined, port: MessagePort | undefined;
        let animation = 0;
        const close = () => {
            if (lifetime.signal.aborted) return;
            cancelAnimationFrame(animation);
            lifetime.abort();
            worker?.terminate(); port?.close();
            if (audio) void audio.close();
            surface.remove();
            active = false;
            chooser.disabled = false;
            chooser.value = "";
            if (document.pointerLockElement === screen) document.exitPointerLock();
        };
        try {
            if (!crossOriginIsolated) throw Error("WWT requires cross-origin isolation");
            status.textContent = "Opening game bundle…";
            const [bundle, input, keys, sound] = await Promise.all([readWwtBundle(blob),
                dependency("runtime/wine/input-ring.mjs"), dependency("runtime/web/keys.mjs"), dependency("runtime/wine/audio-sink.mjs")]);
            const ring = input.InputRing.create();
            const size = bundle.displaySize;
            if (size && Number.isInteger(size.width) && Number.isInteger(size.height) &&
                size.width > 0 && size.width <= 4096 && size.height > 0 && size.height <= 4096) {
                screen.width = size.width;
                screen.height = size.height;
            } else {
                screen.width = 1024;
                screen.height = 768;
            }
            const pixels = new SharedArrayBuffer(screen.width * screen.height * 4);
            const serial = new Int32Array(new SharedArrayBuffer(4));
            const rgba = new Uint8ClampedArray(pixels);
            const ctx = screen.getContext("2d")!;
            const frame = ctx.createImageData(screen.width, screen.height);
            let last = -1;
            const paint = () => {
                const n = Atomics.load(serial,0);
                if (n !== last) { frame.data.set(rgba); ctx.putImageData(frame,0,0); last=n; }
                animation=requestAnimationFrame(paint);
            };
            paint();
            const bus = new MessageChannel();
            port = bus.port1;
            port.onmessage = e => {
                if (e.data.type === "perf") window.dispatchEvent(new CustomEvent("wwt-present", {detail:e.data}));
            };
            const control = new Worker(url("runtime/web/worker.mjs"), {type:"module"});
            worker = control;
            let capture = false;
            const held = new Map<string,{vk:number;scan:number;flags:number}>();
            screen.addEventListener("keydown", e => { const k=keys.windowsKey(e.code); if(k){held.set(e.code,k);ring.key(k.vk,k.scan,k.flags);e.preventDefault();} }, options);
            screen.addEventListener("keyup", e => { const k=keys.windowsKey(e.code); if(k){held.delete(e.code);ring.key(k.vk,k.scan,k.flags|2);e.preventDefault();} }, options);
            screen.addEventListener("blur", () => { for(const k of held.values())ring.key(k.vk,k.scan,k.flags|2);held.clear(); }, options);
            function mouse(e: MouseEvent, flags: number, wheel = 0) {
                const rect = screen.getBoundingClientRect();
                if (document.pointerLockElement === screen) ring.mouse(e.movementX,e.movementY,flags|65536,wheel);
                else ring.mouse(Math.floor((e.clientX-rect.left)*screen.width/rect.width),Math.floor((e.clientY-rect.top)*screen.height/rect.height),flags,wheel);
            }
            screen.addEventListener("pointermove",e=>mouse(e,0),options);
            screen.addEventListener("pointerdown",e=>{screen.focus();if(capture) Promise.resolve(screen.requestPointerLock?.()).catch(()=>{});mouse(e,[2,32,8][e.button]||0);},options);
            screen.addEventListener("pointerup",e=>mouse(e,[4,64,16][e.button]||0),options);
            screen.addEventListener("wheel",e=>{mouse(e,2048,e.deltaY<0?120:-120);e.preventDefault();},{...options,passive:false});
            screen.addEventListener("contextmenu",e=>e.preventDefault(),options);
            const ringBuffer = sound.createAudioRing();
            const noSound = bundle.argv.some(a=>a.toLowerCase()==="-nosound");
            if (!noSound) audio = await sound.playAudioRing(ringBuffer);
            screen.addEventListener("pointerdown",()=>{if(audio?.state==="suspended")void audio.resume();},options);
            window.addEventListener("pagehide",close,{...options,once:true});
            let lastError = "";
            control.onerror=e=>{status.textContent=e.message;close();};
            control.onmessage=({data:m})=>{
                if(m.type==="files")window.dispatchEvent(new CustomEvent("wwt-files",{detail:m.files}));
                else if(m.type==="status")window.dispatchEvent(new CustomEvent("wwt-status",{detail:m.status}));
                else if(m.type==="log")console.info("[WWT]",m.text);
                else if(m.type==="stderr"){lastError=terminal.decode(m.bytes);console.warn("[WWT]",lastError);}
                else if(m.type==="screen"){screen.focus();status.textContent=bundle.exeName;}
                else if(m.type==="clip")capture=!!m.rect;
                else if(m.type==="d3d-window"){
                    const pct=(n:number,size:number)=>100*n/size+"%";
                    Object.assign(surface.style,{left:pct(m.x,screen.width),top:pct(m.y,screen.height),width:pct(m.width,screen.width),height:pct(m.height,screen.height)});
                    surface.hidden=!m.visible || !m.width || !m.height;
                } else if(m.type==="exit"){status.textContent=m.code===null?lastError||"Guest stopped":`Guest exited (${m.code})`;close();}
            };
            const gpu = surface.transferControlToOffscreen();
            status.textContent = "Starting " + bundle.exeName;
            control.postMessage({...bundle,wine:true,display:{width:screen.width,height:screen.height,screen:pixels,frame:serial.buffer,input:ring.buffer},
                audio:audio?{buffer:ringBuffer,rate:audio.sampleRate}:undefined,d3dCanvas:gpu,d3dPort:bus.port2,
                translatorUrl:url("target/wasm32-unknown-unknown/release-wasm/wwt_wasm.wasm"),bundleUrl:url("target/wine-bundle/")},
                [bundle.exeBytes,...Object.values(bundle.files),gpu,bus.port2]);
        } catch(e) {close();status.textContent=String(e);console.error(e);}
    }
    chooser.onchange=()=>{if(chooser.files?.[0])void launch(chooser.files[0]);};
    if(load){
        chooser.disabled = true;
        try {
            const response = await fetch(load);
            if (!response.ok) throw Error("WGB download failed: " + response.status);
            await launch(await response.blob());
        } catch (error) {
            status.textContent = String(error);
            chooser.disabled = false;
        }
    }
}
