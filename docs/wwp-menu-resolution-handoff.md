# Worms World Party Remastered — menu geometry: CLOSED

Bundle: `G:\WGB\todo\worms-world-party-remastered.wgb` (gameId `gog:1433238834`, entry `rom/w2.exe`).
Measured 2026-09-08 against the retail game installed on a real Windows box.

**Verdict: there was never a menu-geometry defect.** Our render, our hit-test routing and our
control rects match the retail game pixel for pixel at the same resolution. What the game does
looks broken until you notice it draws its own cursor at the same scale as its art, so aiming
with the drawn cursor lands the OS cursor on the right control. The real bug behind "clicking a
mode tile hard-crashes" was `GetLastActivePopup`, and it is fixed (§3).

---

## 1. Ground truth — retail game, both resolutions

Read with P/Invoke (`EnumWindows`/`WindowFromPoint`/`GetWindowRect`) plus GDI screen captures
against the running retail game (`tools/probes/wwp/probe2.ps1`). The game's own resolution lives
in `HKCU\Software\Team17DigitalLTD\WormsWorldParty\Options\DisplayXSize/YSize`, so both arms
were taken without touching the desktop mode.

| | retail @3440x1440 | retail @1024x768 | **ours @1024x768** |
|---|---|---|---|
| menu dialog `#32770` | `0,0 640x480` | `0,0 640x480` | `0,0 640x480` |
| `btn1 "(1) Quick against comp"` | `116,137 198x124` | `116,137 198x124` | `116,137 198x124` |
| menu art | centred, scaled | fills screen, x1.6 | fills screen, x1.6 |
| `WindowFromPoint(348,320)` | `(1) Change Config` | `(1) Change Config` | `(1) Change Config` |
| hovering drawn tile 1 | no highlight | highlights tile **4** | highlights tile **4** |
| hovering `btn1` at `(215,199)` | highlights tile **1** | highlights tile **1** | highlights tile **1** |

Evidence: `logs/wwp/real-1024.png`, `real-hover-art.png`, `real3440-hover-art2.png`,
`real3440-hover-btn.png` (retail) next to `logs/wwp/debug/e-hover-btn.png` (ours).

### 1.1 Why it is not broken

The game keeps a 640x480 logical menu: the Win32 dialog and its owner-draw buttons stay at 1:1
in the top-left corner at every resolution, and only the DRAWING is scaled to the backbuffer.
It hides the OS cursor and draws its own at `osPos * scale`. The player aims the drawn cursor;
the OS cursor is then at `drawn / scale`, which is exactly where the matching button is. Our
canvas has `cursor: none` and we draw the guest's cursor, so this works identically for us.

Consequences for anyone who picks this up again:
- Driving the menu from a script means clicking the **Win32 button** rect (`215,199`), not the
  drawn tile (`348,320`). `hitTest` and the retail `WindowFromPoint` agree on that.
- The manifest's 1024x768 is fine. The 640x480 experiment that "fixed" the alignment was a
  coincidence (at scale 1 the two spaces coincide) and is not needed.
- The 5x3 px difference between the template's 645x483 and the 640x480 we produce is what
  Windows produces too. Closed.

### 1.2 Two divergences found on the way, both already fixed in the tree

- `windowFromPoint` read a stale copy of visible/disabled; user32 now owns the fact and the
  manager asks via `registerWindowStateProvider`.
- Hit-testing no longer skips `WS_DISABLED` (Wine `NtUserWindowFromPoint` applies no style
  filter; only `ChildWindowFromPointEx` skips disabled, and only on `CWP_SKIPDISABLED`).
  `tools/tests/window-manager.test.ts` asserted the old behaviour and now asserts this one.
- Forwarded `WM_MOUSEMOVE` carried the parent's lParam; it is converted to child client space.

---

## 2. The mode-tile crash — root cause and fix

Clicking "Quick Game against the CPU" trapped with `eip = 0x6d726f57` ("Worm"), from
`w2.exe+0xc607e`:

```
0x5540a3  mov ecx,[esi+0x20]        ; this dialog's HWND
0x5540ad  call GetParent
0x5540b4  call 0x5fd5a3             ; CWnd::FromHandle
0x5540bb  call 0x4c5f90             ; CDXDialog modal helper on the result
   ...    mov eax,[esi] / mov edx,[eax+0x188] / call edx     ; vtable slot 98
```

`[esi]` was `0x8744dc`, whose RTTI says **`CMainFrame`** — 89 slots, so slot 98 read into a
string. Every `CDXDialog`-derived class (`CQuickCPU`, `CSingleMenu`, …) has ≥100 slots and a
real method there. So the app had been handed the frame where it expected the dialog.

The chain: MFC's `CWnd::GetSafeOwner` calls **`GetLastActivePopup(mainFrame)`** to pick the
owner for the next dialog. We answered with the frame itself, so the "Please Wait" dialog was
created owned by the frame, `GetParent` returned the frame, `FromHandle` mapped it to
`CMainFrame`, and the dialog-only virtual went off the end of its vtable.

`GetLastActivePopup` answered from a record that was only written by the `SetActiveWindow`
export, only for `WS_POPUP` windows, and only onto the immediate owner. Wine's server
(`make_window_active`, `server/window.c:795`) writes it for the window **and every window up its
owner chain**, with no style filter, from `set_active_window` — i.e. wherever activation
happens, click-activate included.

Fixed by moving the record to the one place the active window changes:
- `runtime/windowing/window-manager.ts` — `registerActivationObserver`, invoked from
  `setActiveWindow` (mirrors the child-Z-order and window-state providers).
- `modules/user32/activation-messages.ts` — `recordLastActive` does Wine's owner-chain walk.
- `modules/user32/window.ts` — the old narrow `recordLastActivePopup` is gone, so there is no
  second copy to drift.
- `tools/tests/user32-last-active-popup.test.ts` pins all of it (verified to fail against the
  old shape).

Verified live: the dialog chain is now nested `65553 (single-player menu) → 65560 (please wait)
→ 65563`, where every dialog used to hang off the frame. No trap; the game proceeds.

---

## 3. Next blocker: headless helper processes

**Update:** the headless worker runner now reaches gameplay with the parent alive. See
[headless child processes](headless-child-processes.md) for implementation, evidence and
scope limitations. The remainder of this section records the original diagnosis.

Past the crash, "Quick Game" runs the map generator as a child process:

```
C:\landgen.exe /bridges 94 /water 0 /generate Data\land.dat data\Level\Forest\ data\water\blue ...
```

`Landgen.exe` is a WINDOWS_GUI-subsystem image, so `kernel32/process/process.ts` classifies it
as "a launcher starting the game" and **exec-replaces the session** on it. Landgen then does its
job correctly (a run of `WriteFile`, `CloseHandle`, `ExitProcess(0)` — see the exit report) and
the host reports "Game exited", because the parent it was supposed to return to is gone.

The subsystem is the wrong discriminator: it separates "console tool the parent waits on" from
"GUI image the parent hands off to", and Landgen is a GUI image the parent waits on. The
existing escape hatch only covers console tools on a dev box (`hostToolsEnabled` →
`runGuestToolOnHost`).

What this actually wants is a way to run a bundled helper image **headlessly to completion** and
hand back its exit code, keeping the parent alive — the same shape the host-tool bridge already
has, but in-guest so it works off a dev box. The other known instance of the same need is a game
compiling its own shaders (`fxc.exe`). Until then, `setWorkerFlag('__noReExec', true)` keeps the
parent running (the game sits on its "Please Wait" dialog forever, since the map never appears).

## 4. Harness notes worth keeping

- `BS_TAB=wwp` + `BS_CDP_PORT=<port>` when another agent already holds a Chrome; check which
  instance owns your tab with `curl -s http://127.0.0.1:<port>/json/list`.
- `.click(target)` takes a LABEL or control id. For a point use `.move(x,y).sleep(400).clickHold(x,y,300)`.
- `openWgb()` reloads the page; a chain that also edits `src/worker` in the same window loses its
  CDP session ("Inspected target navigated or closed"). Load in one invocation, drive in the next.
- A re-exec also navigates the tab and takes the run's evidence with it — arm
  `setWorkerFlag('__noReExec', true)` first and read `reExecs()`, which names the image, the
  command line and the guest caller.
- The log ring holds 50 entries by default; `logRing(4000)` before a repro, or use `watchLog`.
- Reading the real Windows side is cheap and was decisive twice. `tools/probes/wwp/probe2.ps1`
  enumerates windows + `WindowFromPoint` for a pid; a GDI `CopyFromScreen` capture of the
  fullscreen D3D9 menu turned out to be reliable enough for geometry at 1024x768 (the 3440x1440
  captures show tearing, so read positions, not pixels, from those).
- Coordinates at 1024x768: title-screen click `(900,700)`; main-menu tile 1 button `(215,199)`;
  single-player "Quick Game against the CPU" button `(189,130)`.
