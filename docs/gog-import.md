# GOG installer import

BottleShip accepts supported GOG offline installers directly. Use the Windows **offline
backup installer** from your account, rather than the GOG Galaxy downloader. Compatibility
depends on the exact Win32 edition; a modern remaster is a different build.

## From a demo to your full game

Re-Volt and Heroes of Might & Magic III have a GOG prompt on their demo pages. Click
**Import full game**, or drop the installer onto the game. For a multipart installer,
select `setup_*.exe` **and every matching `.bin` file together**, with their original names.
The loading overlay shows extraction and packing progress, then launches your copy.
Files stay on your device.

In Google Chrome, **Add game** also offers **Installed game folderРІР‚В¦** and **GOG installer
folderРІР‚В¦**. The first option takes the game's installed directory, including its subfolders;
the second takes a directory containing one offline setup EXE and its matching BIN parts.
For a download directory holding several installers, use Choose files to select one game.
The picker grants read access. The worker reads files in chunks to build an independent WGB,
so launching the saved package later does not require renewed access to the original folder.
The wizard still lets you choose among executable candidates and adjust settings before saving.

New imports default to **1024Р“вЂ”768**, **32-bit color**, **128 MB RAM**, **Windows 98**,
and **Skip video: no**. Explicit bundle settings and curated overrides take precedence.

New **GOG installer** packages put the installed files below
`C:\Games\gog-<product-id>`, rather than directly in the drive root. Without a numeric GOG
product ID, a safe slug derived from the installer name is used. The entrypoint, installer
`{app}` registry/shortcut paths and installer-created directories use the same location.
A primary GOG task or installer shortcut can supply its working directory; otherwise the
loader uses the executable's directory. Literal absolute DOS paths, including CD paths,
are preserved. Installed-folder imports, existing WGBs and cached packages are unchanged;
this is a layout policy for newly generated installer packages, not a migration.


The same importer is available through **Add game** in the library and **Load FileРІР‚В¦**
in the dev panel. The wizard lets you review the executable and settings before choosing
**Play now**, **Save to library**, or **Download WGB**. Play now saves the configured
bundle to the cache and launches that bundle without extracting the installer again.

## Large installers and storage

The browser worker reads the EXE/BIN inputs by range, decompresses in chunks, and writes
files to an OPFS disk workspace. Packing and finalization produce a store-only ZIP64 WGB
by range. Download passes a disk-backed `File` to the host; where a save picker is available,
the host writes it in chunks. The game payload and resulting WGB do not need to fit together
in the JavaScript heap. Decoder dictionaries and archive metadata still use memory.

Allow enough browser storage for roughly **three times the unpacked game size**, plus any
existing cached copy. Browser quota and available disk space still limit an import. An
exhausted quota produces an error directing you to **Settings РІвЂ вЂ™ Storage**.

Successful library/play finalization removes its import workspace. Cancelled imports,
downloads and interrupted sessions can leave temporary files. After imports and downloads
finish, use **Free temporary files** in Storage to remove those files. That action preserves
cached games and saves. Cached WGBs can be downloaded or evicted separately in Storage;
keep a downloaded WGB if you want an independent copy of your package.

The disk path applies to directly selected Inno installers, Chrome directory handles for
installed games/GOG setups, and existing WGBs. Other wizard
formats, including nested installer archives, legacy buffered folder inputs, ISO and 7z, can still use buffered
extraction. This change does not make every archive format suitable for multi-GB imports.
An InstallShield cabinet directory must be supplied through its archive, or installed first
and then packaged through Installed game folder.

## Supported inputs

- Single-file and multipart Inno Setup installers in the parser's supported 5.2РІР‚вЂњ6.x families,
  including supported GOG Galaxy file assembly records.
- Numeric and lettered slice names, validated before extraction. Missing, duplicate or
  unrelated parts fail with a message instead of silently importing a partial game.
- Plain executables continue through the PE loader when they are not Inno installers.

Encrypted installers, unsupported Inno layouts, 64-bit games and unsupported copy protection
remain outside this path. Extraction success alone does not establish game compatibility.

## CLI

The CLI uses the project's built-in parser by default:

```sh
bun tools/gog-to-wgb.ts setup_game.exe game.wgb
bun tools/gog-to-wgb.ts setup_game.exe unused.wgb --extract-only --extract-dir ./out-dir
```

Place matching `.bin` files alongside the EXE for multipart CLI inputs. In addition to
standard Inno slices, the CLI recognizes older GOG installers whose numbered BIN files
are independent RAR4 archives containing `game/` and `support/app/` trees. It merges the
install staging files into the game directory, preserves empty directories, and uses the
installer metadata for the entrypoint and registry. It does not execute installer code.
True split RAR volumes, encryption, missing numbered parts and ambiguous destinations
are rejected. This RAR path is a CLI capability; it does not add browser importer support.

The CLI reads installer payloads by range, extracts to a disk workspace, and writes a
store-only ZIP64 WGB in chunks. Use `--extract-dir <new-directory>` to keep that workspace
on a drive with enough space. The RAR path verifies CRC before publishing each group and
retains at most one decoded solid group, with a 1 GiB output limit; it does not yet stream
inside that group. Decoder dictionaries and small metadata still occupy memory.

Curated emulator settings live in `public/gog-overrides.json`, keyed by the product ID from
`goggame-*.info`.


### Choosing a guest installation directory

```sh
bun tools/gog-to-wgb.ts setup_game.exe game.wgb --install-dir "C:\Games\MyGame"
```

`--install-dir` changes the payload layout and the default installer-registry root together.
It accepts an absolute directory on C: (the WGB ROM drive); UNC paths, traversal and
ambiguous/reserved Win32 components are rejected. `--install-dir "C:\"` explicitly selects
the old flat layout. An extract-only workspace remains installation-relative on the host.

The older `--reg-install` flag retains its **registry-only** meaning. When supplied without
`--install-dir`, it also retains the legacy flat payload layout so existing packaging
recipes do not silently move files. If both are supplied, `--install-dir` determines the
payload and `--reg-install` is an intentional registry override; keep them consistent
unless the installer requires otherwise. Registry seeds are still generated from Inno/GOG
metadata; literal paths in that metadata are not guessed or rewritten.

Local wrapper DLLs remain an explicit compatibility choice, never an automatic policy.
For example, `--app-dir-dlls ddraw.dll` asks the loader to use that copy from
the executable's directory. It does not alter their bytes or enable every native DLL.
