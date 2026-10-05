/**
 * How long a D3D9 shader bytecode stream is.
 *
 * A shader has no length prefix: `CreateVertexShader` takes a bare pointer and the runtime
 * walks to the END token. The walk MUST understand comment blocks, because a comment's payload
 * is arbitrary binary — a CTAB carries constant names and float defaults — and any dword in it
 * can look like an opcode. Scanning for a token whose low half is 0xFFFF stops inside the CTAB
 * of most real shaders, and the truncated stream then fails to parse as "unterminated
 * bytecode": a blob whose own header is perfectly valid, refused for a reason that points at
 * the wrong file.
 *
 * Transcribed from D3DXGetShaderSize (Wine dlls/d3dx9_36/shader.c): compare the WHOLE dword
 * against D3DSIO_END, and skip a comment by its declared length.
 */

/** The END token is the whole dword 0x0000FFFF, not any token ending in 0xFFFF. */
const D3DSIO_END = 0x0000ffff;
const D3DSI_OPCODE_MASK = 0x0000ffff;
const D3DSIO_COMMENT = 0x0000fffe;
const D3DSI_COMMENTSIZE_MASK = 0x7fff0000;
const D3DSI_COMMENTSIZE_SHIFT = 16;

/**
 * Token count of the stream at `at(0)`, INCLUDING the version and END tokens, or `null` when
 * no END is reachable within `limit` tokens.
 *
 * `null` is a real answer, not an error to swallow: silently returning the truncated prefix is
 * what turns a too-small bound into a parse failure attributed to the shader.
 */
export function d3dShaderTokenCount(at: (index: number) => number, limit: number): number | null {
    // The version token is never inspected — a comment cannot be the first token, and a
    // version token can otherwise alias one.
    for (let i = 1; i < limit; i++) {
        const token = at(i) >>> 0;
        if (token === D3DSIO_END) return i + 1;
        if ((token & D3DSI_OPCODE_MASK) === D3DSIO_COMMENT) {
            i += (token & D3DSI_COMMENTSIZE_MASK) >>> D3DSI_COMMENTSIZE_SHIFT;
        }
    }
    return null;
}
