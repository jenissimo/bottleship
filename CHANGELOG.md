# Changelog

## 2026-10-05

### Library and importing

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
