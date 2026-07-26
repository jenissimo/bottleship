/**
 * Command registration wiring. Imports the HarnessService singleton and every
 * cmds/* registrar and installs them. Importing THIS module (for its side effect)
 * is all the worker needs to make the harness live.
 *
 * Kept separate from service.ts to avoid import cycles: cmd modules depend only
 * on the HarnessService *type*; the singleton + concrete registration meet here.
 * New command domains (input, time, breakpoints, capture, textures, fs, reg) add
 * one import + one call below as their stages land.
 */

import { harnessService } from "./service";
import { registerStateCommands } from "./cmds/state";
import { registerInputCommands } from "./cmds/input";
import { registerTimeCommands } from "./cmds/time";
import { registerLogCommands } from "./cmds/logs";
import { registerScreenCommands } from "./cmds/screen";
import { registerBreakpointCommands } from "./cmds/breakpoints";
import { registerTextureCommands } from "./cmds/textures";
import { registerFsCommands } from "./cmds/fs";
import { registerFixtureCommands } from "./cmds/fixture";
import { registerRegistryCommands } from "./cmds/reg";
import { registerWmTraceCommands } from "./cmds/wm-trace";
import { registerAssertCommands } from "./cmds/assert";
import { registerRecordCommands } from "./cmds/record";
import { registerMemTrapCommands } from "./cmds/memtrap";
import { registerPerfCommands } from "./cmds/perf";
import { registerFadeProbeCommands } from "./cmds/fadeprobe";
import { registerAudioCommands } from "./cmds/audio";
import { registerDbgCommands } from "./cmds/dbg";
import { registerCodegenCommands } from "./cmds/codegen";

let installed = false;

/** Idempotent: wire all harness commands onto the singleton. */
export function installHarnessCommands(): void {
    if (installed) return;
    installed = true;
    registerStateCommands(harnessService);
    registerInputCommands(harnessService);
    registerTimeCommands(harnessService);
    registerLogCommands(harnessService);
    registerScreenCommands(harnessService);
    registerBreakpointCommands(harnessService);
    registerTextureCommands(harnessService);
    registerFsCommands(harnessService);
    registerFixtureCommands(harnessService);
    registerRegistryCommands(harnessService);
    registerWmTraceCommands(harnessService);
    registerAssertCommands(harnessService);
    registerRecordCommands(harnessService);
    registerMemTrapCommands(harnessService);
    registerPerfCommands(harnessService);
    registerFadeProbeCommands(harnessService);
    registerAudioCommands(harnessService);
    registerDbgCommands(harnessService);
    registerCodegenCommands(harnessService);
}

// Install on import so a bare `import './harness/commands'` is sufficient.
installHarnessCommands();
