import { scopeRigToFile } from "./helpers/d3d9-savestate-rig";
import { defineD3D9FailureSuite } from "./helpers/d3d9-savestate-suite-failures";

scopeRigToFile();
defineD3D9FailureSuite();
