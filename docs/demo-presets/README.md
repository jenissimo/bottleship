# Native demo presets

`mafia-demo.reg` contains the 63-byte `LS3D_setup` value written by the original
Mafia demo's Setup after **Save and exit**: 1024 × 768, 32-bit fullscreen,
hardware T&L, compressed textures, stereo sound and EAX disabled. Import it when
packing the original files; the game executable and resource archives stay unchanged.

```powershell
bun tools/make-wgb.ts <extracted-game-dir> mafia-demo.wgb `
  --name "Mafia Original Demo" --game-id app:mafia-original-demo `
  --exe Game.exe --os winxp --width 1024 --height 768 --bpp 32 --ram 256 `
  --skip-video --reg-import docs/demo-presets/mafia-demo.reg
```

Use `harness().openWgb(...)` or CLI `reload` before `openWgb` to verify a fresh
worker. Calling the page facade's `openWgb` directly loads into the existing worker.

`blade-of-darkness/Blade.config` and `blade-of-darkness/d3d.cfg` were written by
the original Blade of Darkness demo's Setup: Direct3D, 640 × 480, 16-bit fullscreen
and Miles Fast 2D Positional Audio. Copy both files into the extracted `Bin`
directory before packing. The native launcher then enables **Play Demo** immediately.

```powershell
Copy-Item docs/demo-presets/blade-of-darkness/* <extracted-game-dir>/Bin/
bun tools/make-wgb.ts <extracted-game-dir> blade-of-darkness-demo.wgb `
  --name "Severance: Blade of Darkness Demo" --game-id app:blade-of-darkness-demo `
  --exe Bin/WinBlade.exe --os win98 --width 640 --height 480 --bpp 16 --ram 256 `
  --skip-video
```

`american-mcgee-alice/config.cfg` seeds the original Alice demo's native video
settings: 1280 × 1024 (`r_mode 8`), 32-bit color and textures, maximum texture
detail (`r_picmip 0`), detail textures and trilinear filtering. Texture and
lightmap compression are disabled; full lighting, sky and stock high geometry
detail are enabled. Default key bindings still come from the original `default.cfg`.

```powershell
bun tools/wgb.ts replace <alice-demo.wgb> rom/demo/config.cfg docs/demo-presets/american-mcgee-alice/config.cfg
bun tools/wgb.ts patch-manifest <alice-demo.wgb> emulator.screenResolution '{"width":1280,"height":1024,"bpp":32}'
```

The engine can save subsequent changes normally. A previously saved `demo/config.cfg`
in the user's overlay takes precedence over this bundled default.
