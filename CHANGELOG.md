# Changelog

## 2026-10-07

- Added self-hosted MSI payload extraction and a CLI, including compound-file streams, installed directory/file tables, embedded or adjacent cabinets, and installed-file size/MD5 validation. Appended Microsoft Cabinet self-extractors can also be opened directly; installer custom actions are not executed.
- D3D9 frame capture now records the separate render worker's draws without blocking future frame messages; remote Present closes the recording at the frame boundary. Overlapping requests and capture timeouts are handled explicitly.

- Added the original English Need for Speed: Underground 2 PC demo with original PC box artwork. Free Roam driving, keyboard controls and the City Hall Circuit race are verified, including a production HTTP launch. Cold startup/level loading can take several minutes.

- Guest threads that suspend themselves now park when every peer is blocked and stay parked until resumed. Regression tests execute the caller on v86 with interpreter and production JIT settings.
- Added the original English Gothic 1.08h demo with original cover artwork and required save directories. Dialogue exit, HUD, movement and native saving are verified; restoring a saved game can still stall.

- Legacy Direct3D now reports four simultaneous texture samplers, matching the renderer, while retaining eight arithmetic blend stages. Manifest overrides cannot exceed this limit. This fixes invisible dialogue text and HUD in the Gothic USA demo.

- Added the original English The Bard's Tale (2005) and Deponia 1.1 demos with original cover artwork. Bard's tutorial, summoning and Mountain Tomb movement are verified; Deponia's tutorial, first room and native saving/loading across reload are verified.
- OpenGL texture readback now preserves uploaded image contents and applies pixel packing, fixing corrupted texture atlases and cursors in Deponia.
- Cursor warps immediately update the WASM GetCursorPos cache, preventing stale coordinates within the same guest tick.
- Added Unicode CRT file opening and long-path queries; CRT and WinAPI now share the process working directory, and drive-relative full paths resolve against it. Release CRT modules no longer expose debug-only exports through a warmed GetProcAddress cache.
- Added the original English Blackwell Legacy and KKND2: Krossfire demos with real cover artwork. Both retain native saves across page reload; KKND2 mission control and Blackwell’s apartment introduction are verified.
- Added a self-hosted NSIS 2 ANSI/non-solid zlib payload reader and extraction CLI. It verifies installer CRC, reconstructs static installation paths and rejects unsupported conditional/dynamic file sections. Installer plugins and custom actions are not executed.
- InstallShield extraction supports explicit recovery of plaintext data incorrectly marked as obfuscated; size and MD5 verification remain enabled. This unblocks packaging the original KKND2 demo without modifying its executable.

## 2026-10-06

- Borland CRT directory enumeration now uses its native Win32 implementation, so games can find and load save files written through the VFS-backed stdio layer.
- USER32 timers now continue while the only guest thread is blocked in GetMessage, preventing native installer message loops from stalling with a frozen virtual clock.
- Added the original English Harry Potter and the Chamber of Secrets demo and Tomb Raider II Great Wall demo, with real cover artwork and verified level movement.
- The Tomb Raider II demo includes its native 640 × 480, 16-bit video settings for a fresh-container launch. The unconfigured setup dialog remains a known failure.
- CRT process termination now uses the same child hand-off and durability barrier as ExitProcess, preserving a game launched by an exiting front-end and terminating all parent threads.
- Added Racer with real cover artwork; the Boonta Training Course race is playable.
- Added the English Discworld Noir interactive demo with original PC box artwork, native installation settings, and verified saving/loading across reload. Automatic attract-mode playback is disabled in the demo's menu resource, avoiding stripped-scene `bogus.scn` errors and a blank menu on return; its executable is unchanged. The WGB downloads into OPFS before launch for reliable CRT file reads.

## 2026-10-05

### Library and importing

- Added Red Faction Worldwide Demo and both Half-Life demos (Uplink and Day One) to the public catalog with original covers.
- Both Half-Life demos include a tested 1024 × 768, 16-bit video configuration: Direct3D for Uplink and OpenGL for Day One.
- Added the Far Cry Research demo to the public catalog with the original PC cover.

- Added Warcraft III Demo, Quake II, American McGee's Alice, XIII, Hitman: Codename 47,
  Serious Sam: The First Encounter, Worms Armageddon and System Shock 2 demos to the catalog.
- Demo pages with a GOG edition now explain how to launch an owned
  GOG copy and offer an offline-installer picker, including EXE + BIN selection.
- Large GOG imports extract and build WGBs in browser storage, with progress and multipart
  validation. WGB export streams from disk; Storage can clear abandoned import/download files
  while keeping cached games and saves.
- The WGB wizard supports inspecting and configuring packages, saving them to the library,
  downloading them, and launching the configured cached bundle.
- Chrome users can select an installed game folder or a GOG installer folder. Files are
  read in chunks by the worker; matching BIN parts are selected automatically.
- Added embedded InstallShield 5 cabinet headers and early descriptors without MD5.
  Loose media files are resolved by path, size and stored checksum, avoiding collisions
  between equally named language files. Truncated cabinet reads fail explicitly.

### Games, graphics and sound

- WGB manifests can select a complete virtual graphics-adapter identity. DirectDraw 4/7
  and Direct3D 8/9 report the same vendor, device, driver and version.
- The Far Cry Research demo includes stored PAK entries and its compiled shader cache,
  reducing the measured cold level load from about 196 to 93 seconds while preserving fog.

- Fixed retained splash images on 8-bit DirectDraw surfaces, including Worms Armageddon.
- Palette presentation releases its temporary GPU buffers after submission, preventing
  continuous GPU memory growth. Owned topmost dialogs now receive menu clicks correctly.
- Repacked the Serious Sam: The First Encounter demo with its original English text and audio.
- Expanded the compatibility list with the builds reported working in the current game
  collection, including Far Cry, Mafia, GTA: Vice City, NFS Underground 2, XIII, Painkiller,
  KKND2, Serious Sam, Deponia and Chains of Satinav. Demo-only coverage is stated explicitly.
- Direct3D 9 rendering runs in a separate worker by default. Graphics coverage includes
  additional D3DX effects/shader constants, texture and surface formats, fog and render states.
- Improved DirectSound cursor handling, Miles/OpenAL coverage, video playback and child-process
  display/input routing.
- Added touch controls, configurable virtual gamepad layouts and an on-screen keyboard.

### Runtime and maintenance

- Broadened Win32 and CRT coverage, exception handling and static library recognition.
- Improved CPU scheduling/JIT paths and code-cache tooling, with validation of guest memory,
  generated code publication and render ownership.
- Removed stale release-independent plans/handoffs and a closed A/B probe from tracked files.
  Touch templates and readback diagnostics no longer run as regression scenarios. Regression
  scripts now fail when their assertions or worker steps fail.
- Fixed Linux CI failures caused by video-plane and GDI canvas mocks leaking into EDIT
  control tests. Fixtures restore the original globals, including absent properties.
- Removed engine-specific first-run file creation, runtime INI overrides and fabricated
  renderer-probe processes. Missing files report the normal error, and child programs
  execute guest code with real waitable lifetimes and shared filesystem effects.
- Hidden child windows retain the parent's display. Exiting a visible child restores
  the live parent's display, input and audio registrations.
- The GOG CLI uses the project's installer reader without external unpacker fallbacks.

See [compatibility](docs/compatibility.md) for edition limits and [GOG import](docs/gog-import.md)
for storage requirements.
