export { InnoFormatError } from "./errors";
export { BufferSource, type RandomAccessSource } from "../unpack/source";
export { Crc32 } from "../unpack/checksums";
export {
    INNO_VERSION,
    INNO_VERSION_EXT,
    InnoVersion,
    parseVersionString,
    readVersionAt,
    assertSupportedVersion,
    CP_UTF16LE,
    MIN_SUPPORTED_VERSION,
    MAX_SUPPORTED_VERSION,
} from "./version";
export { BinaryReader, StoredFlagAccumulator, type WindowsVersionRange } from "./binary-reader";
export { loadOffsets, type InnoOffsets } from "./offsets";
export { decompressBlockStream, getBlockEndOffset } from "./block-reader";
export { loadHeader, encryptionUsed, type InnoHeader, CompressionMethod } from "./header";
export { parseInnoHeader, type InnoParseResult } from "./parser";
export type { FileEntry } from "./entries/file";
export type { DataEntry } from "./entries/data";
export type { RegistryEntry } from "./entries/registry";
export type { IconEntry } from "./entries/icon";
export type { LanguageEntry } from "./entries/language";
// The WASM decoder backend moved to `formats/unpack` (shared with formats/freearc).
// Import { UnpackDecoder, UNPACK_LZMA1, … } from "formats/unpack" directly.
export {
    CHUNK_MAGIC,
    EmbeddedSliceReader,
    MultiSliceReader,
    parseSliceFile,
    parseSliceSource,
    SLICE_HEADER_SIZE,
    chunkMapKey,
    decompressChunkStream,
    describeChunk,
    type ChunkDescriptor,
    type SliceSource,
    type SliceData,
} from "./chunk-reader";
export {
    extractInno,
    extractInnoToMap,
    normalizeInnoDestination,
    type ExtractOptions,
    type ExtractSink,
} from "./extractor";
export { filterExtractableFiles, handleCollision } from "./collisions";
export { localesOfCheck, checkAllowsLanguage, detectInstallerLanguages, defaultLanguage } from "./check-lang";
export { CaseInsensitivePathMap } from "./path-map";
export { parseGalaxyFiles } from "./goggalaxy";
export { createChecksumHasher, verifyChecksum, Md5, Sha1 } from "../unpack/checksums";
