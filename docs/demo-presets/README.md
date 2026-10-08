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
