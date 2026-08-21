/**
 * The CPU the guest sees, in one place. CPUID leaf 1, GetSystemInfo, the PROCESSOR_*
 * environment block and HKLM\HARDWARE\DESCRIPTION\System\CentralProcessor all describe the
 * same part, and engines of this era gate their MMX/SSE code paths and cache-size heuristics
 * on whichever of them they happen to read — a disagreement makes them select the older path.
 *
 * These mirror `eax = 3 | 7 << 4 | 6 << 8` in
 * vendor/v86/src/rust/cpu/instructions_0f.rs (family 6, model 7, stepping 3).
 */

export const GUEST_CPU_FAMILY = 6;
export const GUEST_CPU_MODEL = 7;
export const GUEST_CPU_STEPPING = 3;
export const GUEST_CPU_VENDOR = "GenuineIntel";

/** dwProcessorType: PROCESSOR_INTEL_PENTIUM, what NT reports for every P5-and-later x86. */
export const GUEST_PROCESSOR_TYPE = 586;
/** SYSTEM_INFO.wProcessorLevel is the CPUID family, not a fixed 5. */
export const GUEST_PROCESSOR_LEVEL = GUEST_CPU_FAMILY;
/** SYSTEM_INFO.wProcessorRevision is (model << 8) | stepping. */
export const GUEST_PROCESSOR_REVISION = (GUEST_CPU_MODEL << 8) | GUEST_CPU_STEPPING;

/** Single-threaded scheduler: one logical processor, everywhere. */
export const GUEST_NUMBER_OF_PROCESSORS = 1;

export const GUEST_PROCESSOR_ARCHITECTURE = "x86";
/** The exact string NT composes for %PROCESSOR_IDENTIFIER%. */
export const GUEST_PROCESSOR_IDENTIFIER =
    `x86 Family ${GUEST_CPU_FAMILY} Model ${GUEST_CPU_MODEL} Stepping ${GUEST_CPU_STEPPING}, ${GUEST_CPU_VENDOR}`;
/** %PROCESSOR_REVISION% is the revision word as four lowercase hex digits. */
export const GUEST_PROCESSOR_REVISION_STRING =
    GUEST_PROCESSOR_REVISION.toString(16).padStart(4, "0");
