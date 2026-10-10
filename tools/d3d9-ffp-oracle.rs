// D3D9 fixed-function ORACLE — answers a state question from Microsoft's own REF rasterizer
// instead of from argument.  The companion to tools/d3dx-oracle.ts (which pins the shader
// assembler to the shipped d3dx9): where that one asks "what does real d3dx emit?", this asks
// "what does real D3D9 DRAW?".  Reach for it before changing any FFP rule to match one game.
//
// Build + run (needs rustc and the Windows SDK; no cargo project):
//   LIB="C:/Program Files (x86)/Windows Kits/10/Lib/10.0.22621.0/um/x64"
//   rustc -O -o tmp/d3d9-ffp-oracle.exe -L "$LIB" tools/d3d9-ffp-oracle.rs && tmp/d3d9-ffp-oracle.exe
//   tmp/d3d9-ffp-oracle.exe --blend   # HAL/REF blend factors and MIN/MAX, JSON lines
//
// bun:ffi cannot stand in for this: calling a COM vtable slot through CFunction segfaults on
// Windows x64 (the interface pointer is truncated in the call), which is why this is Rust.
//
// As shipped it answers the question Red Alert 3 raised — LIGHTING enabled, zero lights, no
// material, and a vertex format with NO NORMAL.  REF renders that BLACK, matching wined3d,
// DXVK and our own FFP, which is how we knew the RA3 black screen was NOT an FFP lighting bug.
// Edit the render states below to ask a different question.
#![allow(non_snake_case, non_camel_case_types)]
use std::ffi::c_void;
use std::ptr::null_mut;

type HRESULT = i32;
type HWND = *mut c_void;

#[repr(C)]
struct PresentParameters {
    BackBufferWidth: u32, BackBufferHeight: u32, BackBufferFormat: u32, BackBufferCount: u32,
    MultiSampleType: u32, MultiSampleQuality: u32, SwapEffect: u32,
    hDeviceWindow: HWND, Windowed: i32, EnableAutoDepthStencil: i32,
    AutoDepthStencilFormat: u32, Flags: u32,
    FullScreen_RefreshRateInHz: u32, PresentationInterval: u32,
}
#[repr(C)]
struct LockedRect { Pitch: i32, pBits: *mut c_void }

#[link(name = "d3d9")]
extern "system" { fn Direct3DCreate9(SDKVersion: u32) -> *mut c_void; }
#[link(name = "user32")]
extern "system" {
    fn CreateWindowExW(ex: u32, cls: *const u16, name: *const u16, style: u32,
                       x: i32, y: i32, w: i32, h: i32,
                       parent: HWND, menu: *mut c_void, inst: *mut c_void, param: *mut c_void) -> HWND;
}

unsafe fn slot(iface: *mut c_void, idx: usize) -> *const c_void {
    let vtbl = *(iface as *const *const *const c_void);
    *vtbl.add(idx)
}
fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }

fn main() { unsafe {
    if std::env::args().any(|a| a == "--blend") {
        run(1, true);
        run(2, true);
    } else { run(2, false); }
} }

unsafe fn run(device_type: u32, blend: bool) {
    let d3d = Direct3DCreate9(32);
    if d3d.is_null() { println!("Direct3DCreate9 failed"); return; }

    let cls = wide("STATIC");
    let title = wide("ffp-oracle");
    let hwnd = CreateWindowExW(0, cls.as_ptr(), title.as_ptr(), 0x00CF0000,
                               0, 0, 64, 64, null_mut(), null_mut(), null_mut(), null_mut());
    if hwnd.is_null() { println!("CreateWindowExW failed"); return; }

    let mut pp = PresentParameters {
        BackBufferWidth: 64, BackBufferHeight: 64, BackBufferFormat: 22 /* X8R8G8B8 */,
        BackBufferCount: 1, MultiSampleType: 0, MultiSampleQuality: 0,
        SwapEffect: 1 /* DISCARD */, hDeviceWindow: hwnd, Windowed: 1,
        EnableAutoDepthStencil: 0, AutoDepthStencilFormat: 0, Flags: 0,
        FullScreen_RefreshRateInHz: 0, PresentationInterval: 0,
    };
    let mut dev: *mut c_void = null_mut();
    type CreateDevice = extern "system" fn(*mut c_void, u32, u32, HWND, u32,
                                           *mut PresentParameters, *mut *mut c_void) -> HRESULT;
    let create: CreateDevice = std::mem::transmute(slot(d3d, 16));
    // D3DDEVTYPE_REF = 2, D3DCREATE_SOFTWARE_VERTEXPROCESSING = 0x20
    let hr = create(d3d, 0, device_type, hwnd, 0x20, &mut pp, &mut dev);
    if hr < 0 || dev.is_null() { println!("CreateDevice({}) failed 0x{:08x}", device_type, hr as u32); return; }

    if blend { blend_probe(dev, device_type); return; }
    println!("REF device created");

    type SetRS = extern "system" fn(*mut c_void, u32, u32) -> HRESULT;
    type SetTSS = extern "system" fn(*mut c_void, u32, u32, u32) -> HRESULT;
    type SetXf = extern "system" fn(*mut c_void, u32, *const [f32; 16]) -> HRESULT;
    type Nullary = extern "system" fn(*mut c_void) -> HRESULT;
    type ClearFn = extern "system" fn(*mut c_void, u32, *const c_void, u32, u32, f32, u32) -> HRESULT;
    type DrawUP = extern "system" fn(*mut c_void, u32, u32, *const c_void, u32) -> HRESULT;
    type SetFVFFn = extern "system" fn(*mut c_void, u32) -> HRESULT;

    let set_rs: SetRS = std::mem::transmute(slot(dev, 57));
    let set_tss: SetTSS = std::mem::transmute(slot(dev, 67));
    let set_xf: SetXf = std::mem::transmute(slot(dev, 44));
    let begin: Nullary = std::mem::transmute(slot(dev, 41));
    let end: Nullary = std::mem::transmute(slot(dev, 42));
    let clear: ClearFn = std::mem::transmute(slot(dev, 43));
    let draw: DrawUP = std::mem::transmute(slot(dev, 83));
    let set_fvf: SetFVFFn = std::mem::transmute(slot(dev, 89));

    let ident: [f32; 16] = [1.,0.,0.,0., 0.,1.,0.,0., 0.,0.,1.,0., 0.,0.,0.,1.];
    for ts in [256u32 /* WORLD */, 2 /* VIEW */, 3 /* PROJECTION */] { set_xf(dev, ts, &ident); }

    set_fvf(dev, 0x002 | 0x040);        // D3DFVF_XYZ | D3DFVF_DIFFUSE  — deliberately NO normal
    set_rs(dev, 137, 1);                // LIGHTING = TRUE      <-- the state under test
    set_rs(dev, 139, 0);                // AMBIENT = 0
    set_rs(dev, 141, 1);                // COLORVERTEX = TRUE
    set_rs(dev, 145, 1);                // DIFFUSEMATERIALSOURCE = D3DMCS_COLOR1
    set_rs(dev, 22, 1);                 // CULLMODE = NONE
    set_rs(dev, 7, 0);                  // ZENABLE = FALSE
    set_tss(dev, 0, 1, 2); set_tss(dev, 0, 2, 0);   // COLOROP=SELECTARG1, ARG1=DIFFUSE
    set_tss(dev, 0, 4, 2); set_tss(dev, 0, 5, 0);   // ALPHAOP=SELECTARG1, ARG1=DIFFUSE
    set_tss(dev, 1, 1, 1);                          // stage1 COLOROP = DISABLE

    #[repr(C)] #[derive(Clone, Copy)] struct V { x: f32, y: f32, z: f32, c: u32 }
    let verts = [
        V { x: -1., y: -1., z: 0.5, c: 0xffff_ffff },
        V { x: -1., y:  1., z: 0.5, c: 0xffff_ffff },
        V { x:  1., y: -1., z: 0.5, c: 0xffff_ffff },
        V { x:  1., y:  1., z: 0.5, c: 0xffff_ffff },
    ];
    clear(dev, 0, null_mut(), 1 /* TARGET */, 0xff00_0000, 1.0, 0);
    begin(dev);
    draw(dev, 5 /* TRIANGLESTRIP */, 2, verts.as_ptr() as *const c_void,
         std::mem::size_of::<V>() as u32);
    end(dev);

    type GetBack = extern "system" fn(*mut c_void, u32, u32, u32, *mut *mut c_void) -> HRESULT;
    type CreateOffscreen = extern "system" fn(*mut c_void, u32, u32, u32, u32,
                                              *mut *mut c_void, *mut c_void) -> HRESULT;
    type GetRTData = extern "system" fn(*mut c_void, *mut c_void, *mut c_void) -> HRESULT;
    type LockR = extern "system" fn(*mut c_void, *mut LockedRect, *const c_void, u32) -> HRESULT;

    let get_back: GetBack = std::mem::transmute(slot(dev, 18));
    let create_off: CreateOffscreen = std::mem::transmute(slot(dev, 36));
    let get_rt: GetRTData = std::mem::transmute(slot(dev, 32));

    let mut back: *mut c_void = null_mut();
    get_back(dev, 0, 0, 0, &mut back);
    let mut sys: *mut c_void = null_mut();
    create_off(dev, 64, 64, 22, 2 /* SYSTEMMEM */, &mut sys, null_mut());
    let hr = get_rt(dev, back, sys);
    if hr < 0 { println!("GetRenderTargetData failed 0x{:08x}", hr as u32); return; }

    let lock: LockR = std::mem::transmute(slot(sys, 13));
    let mut lr = LockedRect { Pitch: 0, pBits: null_mut() };
    if lock(sys, &mut lr, std::ptr::null(), 0) < 0 { println!("LockRect failed"); return; }
    let px = *(lr.pBits as *const u8).add(32 * lr.Pitch as usize + 32 * 4).cast::<u32>();
    let (r, g, b) = ((px >> 16) & 0xff, (px >> 8) & 0xff, px & 0xff);
    println!("centre pixel = R{} G{} B{}  (0x{:08x})", r, g, b, px);
    if r == 0 && g == 0 && b == 0 {
        println!("=> REF RENDERS IT BLACK. Wine, DXVK and our FFP all agree; RA3 must reach this draw differently.");
    } else {
        println!("=> REF PASSES THE VERTEX COLOUR THROUGH. A normal-less vertex is NOT lit — OUR FFP IS WRONG.");
    }
}

unsafe fn blend_probe(dev: *mut c_void, device_type: u32) {
    type SetRS = extern "system" fn(*mut c_void, u32, u32) -> HRESULT;
    type GetRS = extern "system" fn(*mut c_void, u32, *mut u32) -> HRESULT;
    type SetTSS = extern "system" fn(*mut c_void, u32, u32, u32) -> HRESULT;
    type SetFVF = extern "system" fn(*mut c_void, u32) -> HRESULT;
    type Nullary = extern "system" fn(*mut c_void) -> HRESULT;
    type Clear = extern "system" fn(*mut c_void, u32, *const c_void, u32, u32, f32, u32) -> HRESULT;
    type Draw = extern "system" fn(*mut c_void, u32, u32, *const c_void, u32) -> HRESULT;
    type GetBack = extern "system" fn(*mut c_void, u32, u32, u32, *mut *mut c_void) -> HRESULT;
    type CreateOff = extern "system" fn(*mut c_void, u32, u32, u32, u32, *mut *mut c_void, *mut c_void) -> HRESULT;
    type Copy = extern "system" fn(*mut c_void, *mut c_void, *mut c_void) -> HRESULT;
    type Lock = extern "system" fn(*mut c_void, *mut LockedRect, *const c_void, u32) -> HRESULT;
    let rs: SetRS = std::mem::transmute(slot(dev, 57));
    let get_rs: GetRS = std::mem::transmute(slot(dev, 58));
    let tss: SetTSS = std::mem::transmute(slot(dev, 67));
    let fvf: SetFVF = std::mem::transmute(slot(dev, 89));
    let begin: Nullary = std::mem::transmute(slot(dev, 41));
    let end: Nullary = std::mem::transmute(slot(dev, 42));
    let clear: Clear = std::mem::transmute(slot(dev, 43));
    let draw: Draw = std::mem::transmute(slot(dev, 83));
    let back_fn: GetBack = std::mem::transmute(slot(dev, 18));
    let off_fn: CreateOff = std::mem::transmute(slot(dev, 36));
    let copy: Copy = std::mem::transmute(slot(dev, 32));
    let mut back = null_mut();
    let mut off = null_mut();
    assert!(back_fn(dev, 0, 0, 0, &mut back) >= 0);
    assert!(off_fn(dev, 64, 64, 22, 2, &mut off, null_mut()) >= 0);
    let lock: Lock = std::mem::transmute(slot(off, 13));
    let unlock: Nullary = std::mem::transmute(slot(off, 14));
    fvf(dev, 0x004 | 0x040);
    rs(dev, 137, 0); rs(dev, 22, 1); rs(dev, 7, 0); rs(dev, 27, 1);
    rs(dev, 206, 0);
    tss(dev, 0, 1, 2); tss(dev, 0, 2, 0);
    tss(dev, 0, 4, 2); tss(dev, 0, 5, 0); tss(dev, 1, 1, 1);
    #[repr(C)] struct V { x: f32, y: f32, z: f32, w: f32, c: u32 }
    let verts = [
        V { x: 0., y: 0., z: 0.5, w: 1., c: 0x80cc8040 },
        V { x: 0., y: 64., z: 0.5, w: 1., c: 0x80cc8040 },
        V { x: 64., y: 0., z: 0.5, w: 1., c: 0x80cc8040 },
        V { x: 64., y: 64., z: 0.5, w: 1., c: 0x80cc8040 },
    ];
    for (src, dst, op) in [(2, 1, 1), (1, 1, 1), (0, 0, 1), (0xdead, 0xdead, 1), (u32::MAX, u32::MAX, 1), (2, 1, 0xdead), (5, 6, 4), (0, 0, 5)] {
        let a = rs(dev, 19, src); let b = rs(dev, 20, dst); let c = rs(dev, 171, op);
        let mut read_src = 0; let mut read_dst = 0; let mut read_op = 0;
        get_rs(dev, 19, &mut read_src); get_rs(dev, 20, &mut read_dst); get_rs(dev, 171, &mut read_op);
        assert!(clear(dev, 0, null_mut(), 1, 0xff336699, 1., 0) >= 0);
        assert!(begin(dev) >= 0);
        let drawn = draw(dev, 5, 2, verts.as_ptr().cast(), std::mem::size_of::<V>() as u32);
        assert!(end(dev) >= 0);
        let copied = copy(dev, back, off);
        assert!(copied >= 0);
        let mut lr = LockedRect { Pitch: 0, pBits: null_mut() };
        assert!(lock(off, &mut lr, std::ptr::null(), 0) >= 0);
        let px = *(lr.pBits as *const u8).add(32 * lr.Pitch as usize + 32 * 4).cast::<u32>();
        assert!(unlock(off) >= 0);
        println!("{{\"deviceType\":{},\"src\":{},\"dst\":{},\"op\":{},\"setHr\":[{},{},{}],\"readStates\":[{},{},{}],\"drawHr\":{},\"rgb\":{}}}",
            device_type, src, dst, op, a, b, c, read_src, read_dst, read_op, drawn, px & 0xffffff);
    }
}
