/**
 * ISO9660 / BIN+CUE disc-image reading for WGB repacking.
 *
 * Environment-agnostic: feed any `RandomAccessSource` (in-memory `BufferSource`,
 * or a file-backed source in tooling). See `tools/iso-to-wgb.ts` for the headless
 * packer that turns a disc image into a .wgb bundle.
 */

export {
    LOGICAL_BLOCK_SIZE,
    FIRST_VD_LBA,
    type SectorLayout,
    LAYOUT_ISO,
    LAYOUT_MODE1_2352,
    LAYOUT_MODE2_2352,
    LAYOUT_MODE2_2336,
    detectSectorLayout,
    IsoImage,
} from "./sector-source";

export {
    type IsoFileEntry,
    type IsoFilesystem,
    parseIso9660,
    readVolumeLabel,
    extractIsoToMap,
} from "./iso9660";

export {
    type CueTrack,
    type CueSheet,
    parseCue,
} from "./cue";
