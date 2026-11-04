// Hitman: Codename 47 demo on an emulated iPhone 15 Pro: the on-screen controls steer.
//
// The class of behaviour: a title whose movement keys nothing at the API boundary
// reveals (it reads WM_KEYDOWN in its window procedure and walks on Numpad 8/2/4/6)
// must be steerable from the touch layer once the player picks the cluster in the HUD.
// Asserts, in both orientations:
//   - the HUD offers "Move with: Numpad" and the choice reaches the stick;
//   - the floating stick, held up, posts WM_KEYDOWN VK_NUMPAD8 with the bare 0x48 scan
//     code and NO extended bit, and releases it on lift;
//   - a second finger on Fire posts WM_LBUTTONDOWN/UP while the stick key stays held;
//   - the picture actually moves (camera travel well above the scene's idle churn).
//
// The mission is entered directly: Hitman.ini's DefaultScene is rewritten in the guest
// overlay (the game's own ini directive), so the menu's relative cursor never needs to be
// navigated. WGB: the original demo repack; default under G:\WGB\prod-library.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { harness, closeHarnessConnection } from "../../harness";

const wgb = process.env.WGB ?? "G:/WGB/prod-library/hitman-codename-47-demo.wgb";
const out = resolve("logs", process.env.BS_TAB ?? "hitman-touch", "hitman-touch-controls");
mkdirSync(out, { recursive: true });

const SCENE = "C1_HongKong\\C1_3.zip";
const INI = `DefaultScene=${SCENE}\r\nInclude Setup\\Locale.zip\r\nDrawDll RenderD3D.dll\r\nSoundDll Sound.dll\r\nScriptDll GSC.dll\r\nLocaleDLL Locale.dll\r\nResolution 800x600\r\n`;
const WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_LBUTTONDOWN = 0x201, WM_LBUTTONUP = 0x202;
const VK_NUMPAD8 = 0x68;

type Pt = { x: number; y: number; w: number; h: number };
const rectOf = (sel: string) => `(()=>{const e=${sel};if(!e)return null;e.scrollIntoView({block:'nearest',behavior:'instant'});` +
    `const r=e.getBoundingClientRect();if(r.bottom>innerHeight||r.top<0)return null;` +
    `return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height})})()`;

function must<T>(cond: T, why: string): asserts cond {
    if (!cond) throw new Error(why);
}

async function evalJson<T>(expr: string): Promise<T | null> {
    const r = await harness().evalPage(expr).run();
    const v = r.named?.evalPage;
    return typeof v === "string" ? JSON.parse(v) as T : null;
}

/** 32x24 grayscale fingerprint of a guest screenshot, decoded by the page. */
async function fingerprint(base64: string): Promise<number[]> {
    const fp = await evalJson<number[]>(`(async()=>{const b=await (await fetch('data:image/png;base64,${base64}')).blob();` +
        `const bm=await createImageBitmap(b,{resizeWidth:32,resizeHeight:24,resizeQuality:'medium'});` +
        `const c=new OffscreenCanvas(32,24);const g=c.getContext('2d');g.drawImage(bm,0,0);` +
        `const d=g.getImageData(0,0,32,24).data;const o=[];for(let i=0;i<d.length;i+=4)o.push((d[i]+d[i+1]+d[i+2])/3);` +
        `return JSON.stringify(o)})()`);
    must(fp && fp.length === 32 * 24, "could not fingerprint a guest screenshot");
    return fp;
}
const distance = (a: number[], b: number[]) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

async function guestShot(name: string): Promise<string> {
    const r = await harness().shot().run();
    const b64 = (r.named as any)?.shot?.base64 as string | undefined;
    must(b64, `${name}: no guest screenshot`);
    await Bun.write(resolve(out, `${name}.png`), Buffer.from(b64, "base64"));
    return b64;
}

async function scenario(device: string, flip: { x: number; y: number }): Promise<string> {
    const tag = device.replace("iphone-15-pro-", "");
    // A stray physical mouse over the window flips the pointer-kind latch and hides the
    // touch UI; a touch on a harmless spot (the title in the top bar) re-asserts it.
    const touchFlip = () => harness().touchTimeline([{ ...flip, upMs: 40 }]).sleep(400).run();
    const tap = (p: { x: number; y: number }) => harness().touchTimeline([{ x: p.x, y: p.y, upMs: 90 }]).sleep(500).run();

    await harness().device(device).sleep(1200).run();
    await touchFlip();

    // Two HUD choices, each its own visit (a choice closes the menu): the scheme, then
    // the movement keys. The menu must show both without scrolling.
    for (const [label, shot] of [["Stick+Look", true], ["Numpad", false]] as const) {
        const hud = await evalJson<Pt>(rectOf(`document.querySelector('[aria-label="Game menu"]')`));
        must(hud, `${tag}: the touch HUD handle is not on screen`);
        await tap(hud);
        if (shot) await harness().pageShot(resolve(out, `${tag}-hud.png`)).run();
        const seg = await evalJson<Pt>(rectOf(`[...document.querySelectorAll('[role=group] button')].find(b=>b.textContent.trim()==='${label}')`));
        must(seg, `${tag}: the HUD has no reachable "${label}" choice`);
        await tap(seg);
        await touchFlip();
    }

    await touchFlip();
    const widgets = await evalJson<(Pt & { id: string })[]>(`JSON.stringify([...document.querySelectorAll('[data-widget-id]')]` +
        `.map(e=>{const r=e.getBoundingClientRect();return {id:e.dataset.widgetId,x:r.x,y:r.y,w:r.width,h:r.height}}))`);
    const stick = widgets?.find((w) => w.id === "move");
    const fire = widgets?.find((w) => w.id === "fire");
    must(stick && fire, `${tag}: Move+Look layout lacks its stick or Fire (${JSON.stringify(widgets)})`);
    const caption = await evalJson<string>(`JSON.stringify(document.querySelector('[data-widget-id=move]')?.textContent ?? '')`);
    must(caption === "Numpad", `${tag}: the stick caption reads '${caption}', the Numpad choice did not take`);

    // Idle churn over the same window the steer takes — the scene animates on its own.
    const idle0 = await fingerprint(await guestShot(`${tag}-idle-0`));
    await harness().sleep(2400).run();
    const idle1 = await fingerprint(await guestShot(`${tag}-idle-1`));

    const sx = stick.x + stick.w / 2 + 12, sy = stick.y + stick.h / 2 - 8;
    const fingers = [
        { x: sx, y: sy, x1: sx + 4, y1: sy - Math.max(40, stick.h * 0.45), downMs: 0, upMs: -400 },
        { x: fire.x + fire.w / 2, y: fire.y + fire.h / 2, downMs: 300, upMs: 500 },
    ];
    await harness().wmTrace("clear").wmTrace("start").run();
    const steer0 = await fingerprint(await guestShot(`${tag}-steer-0`));
    let r = await harness().touchTimeline(fingers).inputSab().pageShot(resolve(out, `${tag}-steer.png`))
        .sleep(1800).inputSab().touchTimeline([]).sleep(300).inputSab().wmTrace("read").run();
    must(r.ok, `${tag}: steering chain failed: ${JSON.stringify(r.error)}`);
    const steer1 = await fingerprint(await guestShot(`${tag}-steer-1`));

    const sabs = r.steps.filter((s) => s.cmd === "inputSab").map((s) => (s.result as any)?.keysDown as number[]);
    must(sabs[0]?.includes(VK_NUMPAD8) && sabs[1]?.includes(VK_NUMPAD8),
        `${tag}: VK_NUMPAD8 not held through the Fire tap (record: ${JSON.stringify(sabs)})`);
    must(!sabs[2]?.includes(VK_NUMPAD8), `${tag}: VK_NUMPAD8 still down after the finger lifted (latched)`);

    const trace = ((r.named as any)?.wmTrace?.entries ?? []) as { msg: number; wParam: number; lParam: number }[];
    const down = trace.find((e) => e.msg === WM_KEYDOWN && e.wParam === VK_NUMPAD8);
    must(down, `${tag}: no WM_KEYDOWN VK_NUMPAD8 reached the game window`);
    const lp = down.lParam >>> 0;
    must(((lp >>> 16) & 0xff) === 0x48 && (lp & 0x01000000) === 0,
        `${tag}: VK_NUMPAD8 posted with lParam 0x${lp.toString(16)} (want scan 0x48, extended bit clear)`);
    must(trace.some((e) => e.msg === WM_KEYUP && e.wParam === VK_NUMPAD8), `${tag}: no WM_KEYUP for VK_NUMPAD8`);
    must(trace.some((e) => e.msg === WM_LBUTTONDOWN) && trace.some((e) => e.msg === WM_LBUTTONUP),
        `${tag}: Fire (second finger) produced no WM_LBUTTONDOWN/UP`);

    const idle = distance(idle0, idle1), moved = distance(steer0, steer1);
    must(moved > Math.max(6, idle * 2.5),
        `${tag}: the picture did not move while steering (diff ${moved.toFixed(1)} vs idle ${idle.toFixed(1)})`);
    return `${tag}: numpad walk diff ${moved.toFixed(1)} (idle ${idle.toFixed(1)})`;
}

try {
    // The overlay belongs to the game's container, which exists once the bundle is open:
    // boot, rewrite the ini if it does not already point at the mission, boot again.
    const bootMs = Number(process.env.BOOT_MS ?? 40000);
    const first = await harness().device("iphone-15-pro-landscape").openWgb(wgb).sleep(8000)
        .fsRead("C:\\Hitman.ini").run();
    must(first.ok, `boot failed: ${JSON.stringify(first.error)}`);
    const ini = (first.named as any)?.fsRead;
    const text = ini?.encoding === "base64" ? Buffer.from(ini.content, "base64").toString("latin1") : String(ini?.content ?? "");
    let chain = harness();
    if (!text.includes(SCENE)) {
        chain = chain.fsWrite("C:\\Hitman.ini", INI).call("fsFlush").openWgb(wgb).sleep(bootMs);
    } else {
        chain = chain.sleep(bootMs - 8000);
    }
    const boot = await chain.call("report").run();
    must(boot.ok, `boot failed: ${JSON.stringify(boot.error)}`);
    const rep = boot.named?.report as { crash: unknown; stubs: unknown[] } | undefined;
    must(!rep?.crash && !(rep?.stubs?.length), `guest crashed or hit an unimplemented API: ${JSON.stringify(rep?.stubs ?? rep?.crash)}`);
    // The dev panel opens by default on ?game=dev and pushes the picture off a phone screen.
    await harness().evalPage("(document.querySelector('[class*=emu-btn-active]')?.click(), 1)").run();
    const results = [
        await scenario("iphone-15-pro-landscape", { x: 426, y: 20 }),
        await scenario("iphone-15-pro-portrait", { x: 196, y: 80 }),
    ];
    console.log(`OK — on-screen stick walks Hitman on Numpad, Fire chords with it; ${results.join("; ")}; evidence: ${out}`);
} finally {
    closeHarnessConnection();
}
