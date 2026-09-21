# NFS Underground: code corruption during CreateMutexA

The supplied ExitProcess(0) report is secondary to an AV at 0x592a29.
Reading the live guest revealed that 0x5929c0 (function entry in Speed.exe)
had been zeroed. The bytes were intact immediately after openWgb.
Wrapping the dispatch boundary attributed the first change to function ID
1566, kernel32:CreateMutexA (logs/nfsu-code-write.json).

HypercallDataManager allocated an 8192-byte mutex mirror in guest RAM but
writeMutexMirrorState/writeMutexMirrorSlot/liveMutexWord indexed the entire
WASM buffer with the guest address. These accesses omitted cpu.mem8.byteOffset.
The full-table write overwrote guest executable code at the wrong address.
Rust already accesses the published pointer through guest memory helpers.

The fix translates the guest address to a WASM offset for all three JS paths.
Other uncommitted work is preserved; no rollback or stash was used.

Verification:
- Nonzero-origin regression test checks full-table writes, individual updates,
  live reads of a simulated Rust update, and preservation of the wrong-address region.
- 185 targeted scheduler/dispatcher/mirror tests passed; typecheck passed.
- CPU-view and guest-memory-view validators passed.
- Fresh default-config game boot passed profile and menu, countdown and raceState=4.
  logs/nfsu-mutex-fixed-live.json has no page faults, crash or GPU errors.
- The screenshot in logs/nfsu-navigation-woEIVK/1789407797480.png shows Skyline on track.
  The scripted entry reports an image-template mismatch (distance 39.94), not a crash;
  its full visual-template gate is therefore not claimed as passing.
- A further 20-second resumed race advanced present serial 1049 -> 1347 and
  mover counter 4631 -> 9542, remained in raceState=4, with no faults, crash or
  GPU errors. The game was left paused after this check.

Temporary diagnostic hooks were confined to the diagnostic worker; the fixed-game
run used a fresh worker without them. The temporary probe source was removed.
