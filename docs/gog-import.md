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

In Google Chrome, **Add game** also offers **Installed game folder…** and **GOG installer
folder…**. The first option takes the game's installed directory, including its subfolders;
the second takes a directory containing one offline setup EXE and its matching BIN parts.
For a download directory holding several installers, use Choose files to select one game.
The picker grants read access. The worker reads files in chunks to build an independent WGB,
so launching the saved package later does not require renewed access to the original folder.
The wizard still lets you choose among executable candidates and adjust settings before saving.

New imports default to **1024×768**, **32-bit color**, **128 MB RAM**, **Windows 98**,
and **Skip video: no**. Explicit bundle settings and curated overrides take precedence.

The same importer is available through **Add game** in the library and **Load File…**
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
exhausted quota produces an error directing you to **Settings → Storage**.

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

- Single-file and multipart Inno Setup installers in the parser's supported 5.2–6.x families,
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
bun tools/gog-to-wgb.ts --extract-only setup_game.exe ./out-dir
```

Place matching `.bin` files alongside the EXE for multipart CLI inputs. The CLI has its own
packing path; the browser's OPFS memory guarantees do not describe CLI heap usage.
Curated emulator settings live in `public/gog-overrides.json`, keyed by the product ID from
`goggame-*.info`.
