/**
 * decoder_api.c — Minimal FFmpeg WASM video decoder for Bink, Smacker, AVI, MPEG-PS and
 * the other game containers build.sh lists (Eidos Escape .RPL among them)
 *
 * Compiled with Emscripten to produce public/video-decoder.wasm.
 * Supports up to MAX_HANDLES simultaneous open decoders.
 *
 * Memory ownership:
 *   JS copies file bytes into WASM heap via decoder_alloc() / decoder_free(),
 *   then passes the pointer to decoder_open().  decoder_open() owns the data
 *   from that point; the original JS-side copy may be released.
 *
 *   BGRA output lives in an internal per-session buffer; JS reads it via
 *   decoder_get_frame_rgba_ptr() as a zero-copy view into WASM linear memory.
 *   (Function keeps its name for ABI stability; output is BGRA byte order.)
 *
 *   Audio output is similarly stored in an internal ring; JS drains it via
 *   decoder_get_audio_ptr() / decoder_get_audio_len() after each DoFrame call.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/avutil.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>
#include <libavutil/pixdesc.h>
#include <libswscale/swscale.h>
#include <libswresample/swresample.h>

/* ── Tunables ─────────────────────────────────────────────────────────────── */
#define MAX_HANDLES        8
#define AVIO_BUF_SIZE      32768
/* PCM S16 ring buffer per session: power-of-two for safe masking.
 * 262144 bytes = ~1.5 sec of 44100 Hz stereo S16. */
#define AUDIO_RING_BYTES   262144
#define AUDIO_RING_MASK    (AUDIO_RING_BYTES - 1)

/* Read-call guard: abort if FFmpeg loops too many reads.
 * Per-session, reset on each decoder_open / decoder_do_frame. */
#define MAX_READ_CALLS     100000

/* Max samples per audio frame for the SWR conversion temp buffer.
 * Bink audio frames are typically <= 4096 samples. */
#define MAX_AUDIO_SAMPLES  8192

/* ── Enhancement flags (decoder_set_enhance) — every bit is opt-in; zero is the conversion
 *    a period software player produced ──────────────────────────────────────────────── */
#define ENH_CHROMA_SMOOTH      1   /* filter 4:2:0 chroma up instead of replicating it 2x2 */
#define ENH_DITHER_16          2   /* ordered dither in the RGB565 packer */
#define ENH_DEINTERLACE        4   /* rebuild one field of a frame the decoder flags interlaced */
#define ENH_DEINTERLACE_FORCE  8   /* ...of every frame (fields baked into progressive-coded content) */

static int g_initialized = 0;

static int is_riff_avi(const uint8_t *data, int size) {
    if (!data || size < 12) return 0;
    return memcmp(data, "RIFF", 4) == 0 && memcmp(data + 8, "AVI ", 4) == 0;
}

/* MPEG Program Stream (.mpg/.mpeg): pack (0xBA) or system header (0xBB) start codes */
static int is_mpeg_ps(const uint8_t *data, int size) {
    if (!data || size < 4) return 0;
    if (data[0] != 0x00 || data[1] != 0x00 || data[2] != 0x01) return 0;
    return data[3] == 0xBA || data[3] == 0xBB || data[3] == 0xB3;
}

/* ── In-memory IO state ───────────────────────────────────────────────────── */
typedef struct {
    const uint8_t *data;
    int            size;
    int            pos;
    int            read_call_count;  /* per-session read guard */
} MemIOState;

static int mem_read_packet(void *opaque, uint8_t *buf, int buf_size) {
    MemIOState *s = (MemIOState *)opaque;
    if (++s->read_call_count > MAX_READ_CALLS) return AVERROR_EOF;
    int avail = s->size - s->pos;
    if (avail <= 0) return AVERROR_EOF;
    int n = buf_size < avail ? buf_size : avail;
    memcpy(buf, s->data + s->pos, n);
    s->pos += n;
    return n;
}

static int64_t mem_seek(void *opaque, int64_t offset, int whence) {
    MemIOState *s = (MemIOState *)opaque;
    if (whence == AVSEEK_SIZE) return s->size;
    int64_t newpos;
    if      (whence == SEEK_SET) newpos = offset;
    else if (whence == SEEK_CUR) newpos = s->pos + offset;
    else if (whence == SEEK_END) newpos = s->size + offset;
    else return AVERROR(EINVAL);
    if (newpos < 0 || newpos > (int64_t)s->size) return AVERROR(EINVAL);
    s->pos = (int)newpos;
    return newpos;
}

/* ── Per-session state ────────────────────────────────────────────────────── */
typedef struct {
    /* ownership */
    uint8_t       *input_data;    /* malloc'd copy of the entire file */
    int            input_size;

    /* FFmpeg demux */
    MemIOState    *io_state;
    AVIOContext   *avio;
    AVFormatContext *fmt_ctx;
    int            video_stream_idx;
    int            audio_stream_idx;

    /* Video */
    AVCodecContext *video_ctx;
    AVFrame        *raw_frame;
    struct SwsContext *sws_ctx;
    uint8_t        *bgra_buf;
    int             bgra_size;
    int             width, height;
    int             total_frames;
    int             current_frame;
    double          fps;

    /* RGB565 pre-converted buffer (lazily allocated on first request) */
    uint8_t        *rgb565_buf;
    int             rgb565_valid;    /* 1 if rgb565_buf matches current bgra_buf */

    /* Enhancements + what sws_ctx was built for; a frame that disagrees rebuilds it */
    int             enh_flags;
    int             sws_fmt, sws_range, sws_space, sws_enh;
    int             frame_range, frame_space;   /* as the decoder tagged the last frame */
    int             frame_interlaced;          /* last frame carried AV_FRAME_FLAG_INTERLACED */
    int             interlaced_frames;         /* running count, for the harness */

    /* PAL8 support: preserved before sws_scale converts to BGRA */
    uint8_t        *pal8_indices;    /* width*height bytes (palette indices) */
    uint8_t         pal8_palette[1024]; /* 256 entries × 4 bytes (BGRA) */
    int             has_pal8;        /* 1 if codec outputs AV_PIX_FMT_PAL8 */

    /* Audio */
    AVCodecContext  *audio_ctx;
    AVFrame         *audio_raw_frame;
    struct SwrContext *swr_ctx;
    int16_t         *audio_tmp;         /* per-session SWR conversion buffer */
    /* PCM S16 ring — power-of-two sized, indices are uint32_t with masking */
    uint8_t         *audio_ring;
    uint32_t         audio_ring_wr;     /* monotonic write offset (bytes) */
    uint32_t         audio_ring_rd;     /* monotonic read offset (bytes) */
    int              sample_rate;
    int              channels;

    int              valid;
} Session;

static Session sessions[MAX_HANDLES];

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/** Write samples of S16 PCM into the session ring buffer. */
static void audio_ring_write(Session *s, const int16_t *src, int samples) {
    int bytes = samples * s->channels * 2;
    const uint8_t *p = (const uint8_t *)src;
    /* Available space = ring size minus pending data */
    uint32_t pending = s->audio_ring_wr - s->audio_ring_rd;
    uint32_t space = AUDIO_RING_BYTES - pending;
    if ((uint32_t)bytes > space) bytes = (int)space;   /* drop if full */
    uint32_t wr = s->audio_ring_wr & AUDIO_RING_MASK;
    uint32_t chunk1 = AUDIO_RING_BYTES - wr;
    if ((uint32_t)bytes <= chunk1) {
        memcpy(s->audio_ring + wr, p, bytes);
    } else {
        memcpy(s->audio_ring + wr, p, chunk1);
        memcpy(s->audio_ring, p + chunk1, bytes - chunk1);
    }
    s->audio_ring_wr += (uint32_t)bytes;
}

/** Linear copy of all pending PCM bytes from ring into a flat linear buffer.
 *  Returns number of bytes copied (max out_size). */
static int audio_ring_drain(Session *s, uint8_t *dst, int out_size) {
    uint32_t avail = s->audio_ring_wr - s->audio_ring_rd;
    int to_copy = (int)avail < out_size ? (int)avail : out_size;
    if (to_copy <= 0) return 0;
    uint32_t rd = s->audio_ring_rd & AUDIO_RING_MASK;
    uint32_t chunk1 = AUDIO_RING_BYTES - rd;
    if ((uint32_t)to_copy <= chunk1) {
        memcpy(dst, s->audio_ring + rd, to_copy);
    } else {
        memcpy(dst,           s->audio_ring + rd, chunk1);
        memcpy(dst + chunk1,  s->audio_ring,       to_copy - chunk1);
    }
    s->audio_ring_rd += (uint32_t)to_copy;
    return to_copy;
}

/* ── Frame → BGRA ─────────────────────────────────────────────────────────── */

/* AVCOL_SPC_* and SWS_CS_* are NOT the same numbering (AVCOL_SPC_SMPTE170M is 6, an empty
 * row of swscale's table) — map explicitly. */
static int sws_cs_for(int spc) {
    switch (spc) {
    case AVCOL_SPC_BT709:      return SWS_CS_ITU709;
    case AVCOL_SPC_FCC:        return SWS_CS_FCC;
    case AVCOL_SPC_BT470BG:
    case AVCOL_SPC_SMPTE170M:  return SWS_CS_ITU601;
    case AVCOL_SPC_SMPTE240M:  return SWS_CS_SMPTE240M;
    case AVCOL_SPC_BT2020_NCL: return SWS_CS_BT2020;
    default:                   return SWS_CS_DEFAULT;
    }
}

static int is_yuvj(int fmt) {
    return fmt == AV_PIX_FMT_YUVJ420P || fmt == AV_PIX_FMT_YUVJ422P ||
           fmt == AV_PIX_FMT_YUVJ444P || fmt == AV_PIX_FMT_YUVJ440P || fmt == AV_PIX_FMT_YUVJ411P;
}

/* The converter is built from the FRAME, not the codec context: the format is only certain
 * once a frame exists, and range/matrix are what the decoder tagged it with. swscale's own
 * defaults are limited-range BT.601; a full-range source (Bink 'k', MJPEG) converted under
 * them crushes blacks and clips whites. */
static int ensure_sws(Session *s, const AVFrame *f) {
    int fmt = f->format, range = f->color_range, space = f->colorspace;
    int enh = s->enh_flags & ENH_CHROMA_SMOOTH;
    if (s->sws_ctx && fmt == s->sws_fmt && range == s->sws_range &&
        space == s->sws_space && enh == s->sws_enh) return 0;
    if (s->sws_ctx) { sws_freeContext(s->sws_ctx); s->sws_ctx = NULL; }
    /* At 1:1 the scaler flag only decides how 4:2:0 chroma reaches full resolution:
     * SWS_POINT replicates it, the way period software players drew it. */
    int flags = enh ? (SWS_BICUBIC | SWS_FULL_CHR_H_INT | SWS_ACCURATE_RND) : SWS_POINT;
    s->sws_ctx = sws_getContext(s->width, s->height, fmt, s->width, s->height, AV_PIX_FMT_BGRA,
                                flags, NULL, NULL, NULL);
    if (!s->sws_ctx) return -1;
    int src_full = (range == AVCOL_RANGE_JPEG) || is_yuvj(fmt);
    sws_setColorspaceDetails(s->sws_ctx, sws_getCoefficients(sws_cs_for(space)), src_full,
                             sws_getCoefficients(SWS_CS_DEFAULT), 0, 0, 1 << 16, 1 << 16);
    s->sws_fmt = fmt; s->sws_range = range; s->sws_space = space; s->sws_enh = enh;
    return 0;
}

/* Keep the first field in time, rebuild the other from its neighbours (what a bob
 * deinterlacer draws per field). Planar 8-bit only — RGB, palettes and packed layouts are
 * left alone. The decoder may still reference this frame for prediction, so it is made
 * writable (copied) before being touched. */
static void deinterlace_planar(AVFrame *f) {
    const AVPixFmtDescriptor *d = av_pix_fmt_desc_get(f->format);
    if (!d || !(d->flags & AV_PIX_FMT_FLAG_PLANAR) ||
        (d->flags & (AV_PIX_FMT_FLAG_RGB | AV_PIX_FMT_FLAG_PAL | AV_PIX_FMT_FLAG_BITSTREAM)) ||
        d->comp[0].depth != 8) return;
    if (av_frame_make_writable(f) < 0) return;
    int rebuild = (f->flags & AV_FRAME_FLAG_TOP_FIELD_FIRST) ? 1 : 0;
    for (int p = 0; p < 4 && f->data[p]; p++) {
        int chroma = (p == 1 || p == 2);
        int pw = chroma ? AV_CEIL_RSHIFT(f->width,  d->log2_chroma_w) : f->width;
        int ph = chroma ? AV_CEIL_RSHIFT(f->height, d->log2_chroma_h) : f->height;
        int ls = f->linesize[p];
        uint8_t *base = f->data[p];
        if (ph < 2) continue;
        for (int y = rebuild; y < ph; y += 2) {
            const uint8_t *above = base + (y > 0      ? y - 1 : y + 1) * ls;
            const uint8_t *below = base + (y + 1 < ph ? y + 1 : y - 1) * ls;
            uint8_t *row = base + y * ls;
            for (int x = 0; x < pw; x++) row[x] = (uint8_t)((above[x] + below[x] + 1) >> 1);
        }
    }
}

static void convert_frame_to_bgra(Session *s) {
    AVFrame *f = s->raw_frame;
    s->frame_range = f->color_range;
    s->frame_space = f->colorspace;
    s->frame_interlaced = !!(f->flags & AV_FRAME_FLAG_INTERLACED);
    if (s->frame_interlaced) s->interlaced_frames++;
    if ((s->enh_flags & ENH_DEINTERLACE) &&
        (s->frame_interlaced || (s->enh_flags & ENH_DEINTERLACE_FORCE)))
        deinterlace_planar(f);

    /* Preserve PAL8 data before sws_scale destroys it.
     * FFmpeg's Smacker/8-bit decoders output AV_PIX_FMT_PAL8:
     *   data[0] = width*height palette indices
     *   data[1] = 256-entry palette, each entry 4 bytes (BGRA / 0xAARRGGBB) */
    if (f->format == AV_PIX_FMT_PAL8) {
        s->has_pal8 = 1;
        if (!s->pal8_indices) {
            s->pal8_indices = (uint8_t *)malloc(s->width * s->height);
        }
        if (s->pal8_indices) {
            /* raw_frame may have padding (linesize[0] >= width) */
            for (int y = 0; y < s->height; y++) {
                memcpy(s->pal8_indices + y * s->width,
                       f->data[0] + y * f->linesize[0],
                       s->width);
            }
        }
        if (f->data[1]) {
            memcpy(s->pal8_palette, f->data[1], 1024);
        }
    }

    if (ensure_sws(s, f) == 0) {
        const uint8_t *src_d[4] = { f->data[0], f->data[1], f->data[2], f->data[3] };
        int src_ls[4] = { f->linesize[0], f->linesize[1], f->linesize[2], f->linesize[3] };
        uint8_t *dst_d[4]  = { s->bgra_buf, NULL, NULL, NULL };
        int       dst_ls[4] = { s->width * 4, 0, 0, 0 };
        sws_scale(s->sws_ctx, src_d, src_ls, 0, s->height, dst_d, dst_ls);
    }
    s->rgb565_valid = 0;  /* invalidate cached RGB565 — new BGRA data */
    av_frame_unref(f);
}

/* ── Public API ───────────────────────────────────────────────────────────── */

/** One-time initialization: silence FFmpeg log spam in the browser console. */
static void ensure_initialized(void) {
    if (!g_initialized) {
        av_log_set_level(AV_LOG_ERROR);
        g_initialized = 1;
    }
}

/** Allocate n bytes in WASM heap for JS to copy file data into. */
void *decoder_alloc(int32_t n) {
    return malloc((size_t)n);
}

/** Free a previously allocated block. */
void decoder_free(void *ptr) {
    free(ptr);
}

/** Forward declaration */
void decoder_close(int32_t handle);

/**
 * Open a video file from an in-memory buffer already in WASM heap.
 * Returns a session handle (0..MAX_HANDLES-1), or -1 on failure.
 * The caller should NOT free `data` after this call; decoder_close() does so.
 */
int32_t decoder_open(const uint8_t *data, int32_t size) {
    ensure_initialized();

    /* Find free slot */
    int handle = -1;
    for (int i = 0; i < MAX_HANDLES; i++) {
        if (!sessions[i].valid) { handle = i; break; }
    }
    if (handle < 0) return -1;

    Session *s = &sessions[handle];
    memset(s, 0, sizeof(Session));
    s->video_stream_idx = -1;
    s->audio_stream_idx = -1;

    /* Take ownership of the input buffer */
    s->input_data = (uint8_t *)data;
    s->input_size = size;

    /* Build custom AVIO context for in-memory access */
    s->io_state = (MemIOState *)malloc(sizeof(MemIOState));
    if (!s->io_state) goto fail;
    s->io_state->data = s->input_data;
    s->io_state->size = size;
    s->io_state->pos  = 0;
    s->io_state->read_call_count = 0;

    uint8_t *avio_buf = (uint8_t *)av_malloc(AVIO_BUF_SIZE);
    if (!avio_buf) goto fail;
    s->avio = avio_alloc_context(avio_buf, AVIO_BUF_SIZE, 0, s->io_state,
                                  mem_read_packet, NULL, mem_seek);
    if (!s->avio) { av_free(avio_buf); goto fail; }

    /* Open format */
    s->fmt_ctx = avformat_alloc_context();
    if (!s->fmt_ctx) goto fail;
    s->fmt_ctx->pb = s->avio;
    s->fmt_ctx->flags |= AVFMT_FLAG_CUSTOM_IO;

    const AVInputFormat *forced_fmt = NULL;
    if (is_riff_avi(s->input_data, s->input_size)) {
        forced_fmt = av_find_input_format("avi");
    } else if (is_mpeg_ps(s->input_data, s->input_size)) {
        forced_fmt = av_find_input_format("mpeg");
    }
    if (avformat_open_input(&s->fmt_ctx, NULL, forced_fmt, NULL) < 0) goto fail;

    /* Skip avformat_find_stream_info — Bink/Smacker demuxers already populate
     * all stream parameters (width, height, codec_id, sample_rate, etc.) in
     * read_header().  Calling find_stream_info triggers frame decoding for
     * codec probing which hangs on BIKb content. */

    /* Skip find_stream_info for Bink/Smacker due known probing hangs on BIKb.
     * For AVI/other formats allow FFmpeg to populate stream metadata. */
    if (s->fmt_ctx->iformat && s->fmt_ctx->iformat->name) {
        const char *ifmt_name = s->fmt_ctx->iformat->name;
        int is_bink = strstr(ifmt_name, "bink") != NULL;
        int is_smacker = strstr(ifmt_name, "smacker") != NULL;
        if (!is_bink && !is_smacker) {
            avformat_find_stream_info(s->fmt_ctx, NULL);
        }
    }

    /* Pick primary streams the same way FFmpeg tools do. Some legacy AVI files
     * contain auxiliary/empty video streams before the real one. */
    s->video_stream_idx = av_find_best_stream(
        s->fmt_ctx, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    if (s->video_stream_idx < 0) goto fail;   /* no decodable video */

    s->audio_stream_idx = av_find_best_stream(
        s->fmt_ctx, AVMEDIA_TYPE_AUDIO, -1, s->video_stream_idx, NULL, 0);

    /* Open video decoder */
    {
        AVCodecParameters *par = s->fmt_ctx->streams[s->video_stream_idx]->codecpar;
        const AVCodec *codec   = avcodec_find_decoder(par->codec_id);
        if (!codec) goto fail;
        s->video_ctx = avcodec_alloc_context3(codec);
        if (!s->video_ctx) goto fail;
        if (avcodec_parameters_to_context(s->video_ctx, par) < 0) goto fail;
        if (avcodec_open2(s->video_ctx, codec, NULL) < 0) goto fail;
        s->width  = s->video_ctx->width;
        s->height = s->video_ctx->height;
        if (s->width <= 0 || s->height <= 0) goto fail;
    }

    /* Open audio decoder (optional) */
    if (s->audio_stream_idx >= 0) {
        AVCodecParameters *par = s->fmt_ctx->streams[s->audio_stream_idx]->codecpar;
        const AVCodec *codec   = avcodec_find_decoder(par->codec_id);
        if (codec) {
            s->audio_ctx = avcodec_alloc_context3(codec);
            if (s->audio_ctx &&
                avcodec_parameters_to_context(s->audio_ctx, par) >= 0 &&
                avcodec_open2(s->audio_ctx, codec, NULL) >= 0)
            {
                s->sample_rate = s->audio_ctx->sample_rate;
                s->channels    = s->audio_ctx->ch_layout.nb_channels;
                if (s->channels <= 0) s->channels = 1;
                if (s->channels > 2)  s->channels = 2;

                /* Build swresample: codec output → S16 interleaved */
                AVChannelLayout out_layout;
                av_channel_layout_default(&out_layout, s->channels);
                if (swr_alloc_set_opts2(&s->swr_ctx,
                        &out_layout,             AV_SAMPLE_FMT_S16, s->sample_rate,
                        &s->audio_ctx->ch_layout, s->audio_ctx->sample_fmt,
                        s->audio_ctx->sample_rate, 0, NULL) >= 0) {
                    swr_init(s->swr_ctx);
                }
                av_channel_layout_uninit(&out_layout);

                s->audio_ring       = (uint8_t *)calloc(1, AUDIO_RING_BYTES);
                s->audio_tmp        = (int16_t *)malloc(MAX_AUDIO_SAMPLES * s->channels * sizeof(int16_t));
                s->audio_raw_frame  = av_frame_alloc();
            }
        }
    }

    /* FPS and frame count */
    {
        AVStream *vs = s->fmt_ctx->streams[s->video_stream_idx];
        if (vs->avg_frame_rate.den > 0 && vs->avg_frame_rate.num > 0) {
            s->fps = (double)vs->avg_frame_rate.num / (double)vs->avg_frame_rate.den;
        } else if (vs->r_frame_rate.den > 0 && vs->r_frame_rate.num > 0) {
            s->fps = (double)vs->r_frame_rate.num / (double)vs->r_frame_rate.den;
        } else {
            s->fps = 15.0;
        }

        s->total_frames = (int)vs->nb_frames;
        if (s->total_frames <= 0 && vs->duration > 0 && vs->time_base.den > 0) {
            s->total_frames = (int)(s->fps * (double)vs->duration
                                    * vs->time_base.num / vs->time_base.den + 0.5);
        }
        if (s->total_frames <= 0) s->total_frames = 9999;
    }

    /* BGRA buffer — av_mallocz for SIMD alignment + zero-fill */
    s->bgra_size = s->width * s->height * 4;
    s->bgra_buf  = (uint8_t *)av_mallocz(s->bgra_size);
    if (!s->bgra_buf) goto fail;

    s->raw_frame = av_frame_alloc();
    if (!s->raw_frame) goto fail;

    /* sws_ctx is built by the first frame (ensure_sws); until then report the codec's tags */
    s->frame_range = s->video_ctx->color_range;
    s->frame_space = s->video_ctx->colorspace;

    s->valid = 1;
    return handle;

fail:
    decoder_close(handle);
    return -1;
}

/**
 * Decode one video frame (and any interleaved audio packets).
 * Returns 0 on success, -1 on EOF/error.
 *
 * IMPORTANT: produces exactly ONE video frame per call.  If the codec
 * buffers multiple output frames per input packet (B-frame reordering,
 * frame-doubling, etc.), the extras stay in the codec queue and are
 * returned by subsequent calls.  Previous code drained the entire queue
 * in a while-loop, silently consuming N frames but counting only 1 →
 * EOF at total_frames/N → video appeared to end early.
 */
int32_t decoder_do_frame(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return -1;
    Session *s = &sessions[handle];

    /* Reset per-session read guard so each do_frame gets a full budget */
    if (s->io_state) s->io_state->read_call_count = 0;

    /* 1. Check for a frame already queued from a previous send_packet. */
    if (avcodec_receive_frame(s->video_ctx, s->raw_frame) == 0) {
        convert_frame_to_bgra(s);
        s->current_frame++;
        return 0;
    }

    /* 2. Read demuxer packets until the codec produces one video frame. */
    AVPacket *pkt = av_packet_alloc();
    if (!pkt) return -1;

    int got_video = 0;
    while (!got_video) {
        int ret = av_read_frame(s->fmt_ctx, pkt);
        if (ret < 0) {
            /* EOF: flush video decoder — get one frame */
            avcodec_send_packet(s->video_ctx, NULL);
            if (avcodec_receive_frame(s->video_ctx, s->raw_frame) == 0) {
                convert_frame_to_bgra(s);
                got_video = 1;
            }
            break;
        }

        if (pkt->stream_index == s->video_stream_idx) {
            ret = avcodec_send_packet(s->video_ctx, pkt);
            if (ret == AVERROR(EAGAIN)) {
                /* Codec input full — drain one frame first, then retry send */
                if (avcodec_receive_frame(s->video_ctx, s->raw_frame) == 0) {
                    convert_frame_to_bgra(s);
                    got_video = 1;
                }
                if (!got_video) {
                    /* Still EAGAIN with no output — shouldn't happen, skip packet */
                    av_packet_unref(pkt);
                    continue;
                }
                /* Re-send the packet now that we drained a frame */
                avcodec_send_packet(s->video_ctx, pkt);
            } else if (ret == 0) {
                /* Packet accepted — try to get one output frame */
                if (avcodec_receive_frame(s->video_ctx, s->raw_frame) == 0) {
                    convert_frame_to_bgra(s);
                    got_video = 1;
                }
            }
        } else if (pkt->stream_index == s->audio_stream_idx && s->audio_ctx && s->audio_ring) {
            /* Audio: drain all samples (audio doesn't have the 1-frame constraint) */
            if (avcodec_send_packet(s->audio_ctx, pkt) == 0) {
                while (avcodec_receive_frame(s->audio_ctx, s->audio_raw_frame) == 0) {
                    if (s->swr_ctx && s->audio_tmp) {
                        uint8_t *dst = (uint8_t *)s->audio_tmp;
                        int n = swr_convert(s->swr_ctx, &dst, MAX_AUDIO_SAMPLES,
                                            (const uint8_t **)s->audio_raw_frame->data,
                                            s->audio_raw_frame->nb_samples);
                        if (n > 0) audio_ring_write(s, s->audio_tmp, n);
                    }
                    av_frame_unref(s->audio_raw_frame);
                }
            }
        }

        av_packet_unref(pkt);
        if (got_video) break;
    }

    av_packet_free(&pkt);
    if (got_video) s->current_frame++;
    return got_video ? 0 : -1;
}

/** Copy BGRA frame into caller-provided buffer. Returns bytes written or -1. */
int32_t decoder_copy_frame_rgba(int32_t handle, uint8_t *out, int32_t out_size) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return -1;
    Session *s = &sessions[handle];
    int n = s->bgra_size < out_size ? s->bgra_size : out_size;
    memcpy(out, s->bgra_buf, n);
    return n;
}

/** Return pointer to internal BGRA buffer (zero-copy WASM view).
 *  Name kept as "rgba" for ABI stability — output is actually BGRA. */
const uint8_t *decoder_get_frame_rgba_ptr(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return NULL;
    return sessions[handle].bgra_buf;
}

/** Return 1 if the codec outputs PAL8 (8-bit palettized), 0 otherwise. */
int32_t decoder_has_pal8(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return 0;
    return sessions[handle].has_pal8;
}

/** Return pointer to PAL8 index buffer (width*height bytes), or NULL. */
const uint8_t *decoder_get_frame_pal8_ptr(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return NULL;
    Session *s = &sessions[handle];
    if (!s->has_pal8 || !s->pal8_indices) return NULL;
    return s->pal8_indices;
}

/* 4x4 Bayer thresholds, 0..15 */
static const uint8_t BAYER4[16] = { 0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5 };

/**
 * Convert current BGRA frame to RGB565 and return pointer to the buffer.
 * The conversion is done in C/WASM for ~8-15x speedup vs JS byte-level loop.
 * Lazily allocates the RGB565 buffer; caches until next doFrame invalidates it.
 * Returns NULL on error.
 */
const uint8_t *decoder_get_frame_rgb565_ptr(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return NULL;
    Session *s = &sessions[handle];
    if (!s->bgra_buf) return NULL;

    /* Lazy alloc */
    if (!s->rgb565_buf) {
        s->rgb565_buf = (uint8_t *)malloc(s->width * s->height * 2);
        if (!s->rgb565_buf) return NULL;
    }

    /* Convert only once per frame */
    if (!s->rgb565_valid) {
        const uint32_t *src = (const uint32_t *)s->bgra_buf;
        uint16_t *dst = (uint16_t *)s->rgb565_buf;
        int w = s->width, h = s->height;
        if (s->enh_flags & ENH_DITHER_16) {
            /* Ordered dither in the quantizer's own domain: level k = floor(v*(2^n-1)/255 + t/16),
             * so the block mean lands on the source once a 16-bit surface is expanded back
             * ((k<<3)|(k>>2)); dithering v/8 instead sits half a step high. */
            for (int y = 0; y < h; y++) {
                const uint8_t *th = BAYER4 + (y & 3) * 4;
                const uint32_t *row = src + y * w;
                uint16_t *out = dst + y * w;
                for (int x = 0; x < w; x++) {
                    uint32_t px = row[x];
                    int t = th[x & 3] * 255;
                    int r = (int)(((px >> 16) & 0xFF) * 496  + t) / 4080;   /* 31*16 */
                    int g = (int)(((px >> 8)  & 0xFF) * 1008 + t) / 4080;   /* 63*16 */
                    int b = (int)(( px        & 0xFF) * 496  + t) / 4080;
                    out[x] = (uint16_t)((r << 11) | (g << 5) | b);
                }
            }
        } else {
            int count = w * h;
            for (int i = 0; i < count; i++) {
                uint32_t px = src[i];
                /* BGRA u32 (LE): A<<24|R<<16|G<<8|B → RGB565 */
                dst[i] = (uint16_t)(
                    ((px & 0x00F80000u) >> 8) |
                    ((px & 0x0000FC00u) >> 5) |
                    ((px & 0x000000F8u) >> 3)
                );
            }
        }
        s->rgb565_valid = 1;
    }
    return s->rgb565_buf;
}

/** Return pointer to PAL8 palette (256×4 = 1024 bytes, BGRA order), or NULL. */
const uint8_t *decoder_get_frame_palette_ptr(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return NULL;
    Session *s = &sessions[handle];
    if (!s->has_pal8) return NULL;
    return s->pal8_palette;
}

/** Drain available PCM S16 bytes into caller's buffer. Returns bytes written. */
int32_t decoder_get_audio_frame(int32_t handle, uint8_t *out, int32_t out_size) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return 0;
    Session *s = &sessions[handle];
    if (!s->audio_ring) return 0;
    return audio_ring_drain(s, out, out_size);
}

/** Return number of pending audio bytes available to drain. */
int32_t decoder_get_audio_available(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return 0;
    Session *s = &sessions[handle];
    if (!s->audio_ring) return 0;
    return (int32_t)(s->audio_ring_wr - s->audio_ring_rd);
}

/** Advance to next logical frame (no-op; decoder_do_frame already advances). */
void decoder_next_frame(int32_t handle) {
    /* current_frame already incremented by decoder_do_frame */
    (void)handle;
}

/** Returns 0 when ready to decode next frame (timing handled by JS). */
int32_t decoder_wait(int32_t handle) {
    (void)handle;
    return 0;
}

int32_t decoder_get_width(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return 0;
    return sessions[handle].width;
}

int32_t decoder_get_height(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return 0;
    return sessions[handle].height;
}

int32_t decoder_get_frame_count(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return 0;
    return sessions[handle].total_frames;
}

int32_t decoder_get_current_frame(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return 0;
    return sessions[handle].current_frame;
}

float decoder_get_fps(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return 15.0f;
    return (float)sessions[handle].fps;
}

int32_t decoder_get_audio_sample_rate(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return 0;
    return sessions[handle].sample_rate;
}

int32_t decoder_get_audio_channels(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return 0;
    return sessions[handle].channels;
}

void decoder_goto_frame(int32_t handle, int32_t frame) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return;
    Session *s = &sessions[handle];
    /* Seek using stream timebase */
    AVStream *vs = s->fmt_ctx->streams[s->video_stream_idx];
    double ts_secs = (s->fps > 0) ? (double)frame / s->fps : 0.0;
    int64_t ts = (int64_t)(ts_secs / av_q2d(vs->time_base));
    av_seek_frame(s->fmt_ctx, s->video_stream_idx, ts, AVSEEK_FLAG_BACKWARD);
    avcodec_flush_buffers(s->video_ctx);
    if (s->audio_ctx) avcodec_flush_buffers(s->audio_ctx);
    s->current_frame = frame;
    /* Reset audio ring */
    s->audio_ring_rd = s->audio_ring_wr = 0;
}

/** Return the FFmpeg codec ID for the video stream (e.g. AV_CODEC_ID_INDEO3). */
int32_t decoder_get_video_codec_id(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return 0;
    Session *s = &sessions[handle];
    return s->video_ctx ? (int32_t)s->video_ctx->codec_id : 0;
}

/** Return pointer to a null-terminated codec short name (e.g. "indeo3", "cinepak").
 *  Lives in a static buffer — valid until next call. */
static char codec_name_buf[64];
const char *decoder_get_video_codec_name(int32_t handle) {
    codec_name_buf[0] = 0;
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return codec_name_buf;
    Session *s = &sessions[handle];
    if (s->video_ctx && s->video_ctx->codec && s->video_ctx->codec->name) {
        strncpy(codec_name_buf, s->video_ctx->codec->name, 63);
        codec_name_buf[63] = 0;
    }
    return codec_name_buf;
}

/** Return the FourCC (codec_tag) from the video stream, or 0. */
uint32_t decoder_get_video_fourcc(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return 0;
    Session *s = &sessions[handle];
    if (!s->fmt_ctx || s->video_stream_idx < 0) return 0;
    return s->fmt_ctx->streams[s->video_stream_idx]->codecpar->codec_tag;
}

/** Return the source pixel format (AV_PIX_FMT_*) of the video decoder, or -1. */
int32_t decoder_get_video_pix_fmt(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return -1;
    Session *s = &sessions[handle];
    return s->video_ctx ? (int32_t)s->video_ctx->pix_fmt : -1;
}

/** Select the opt-in enhancements (ENH_*) for a session. The 16-bit packing of the current
 *  frame follows immediately; the conversion itself from the next frame on. */
void decoder_set_enhance(int32_t handle, int32_t flags) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return;
    Session *s = &sessions[handle];
    if (s->enh_flags == flags) return;
    s->enh_flags = flags;
    s->rgb565_valid = 0;
}

int32_t decoder_get_enhance(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return 0;
    return sessions[handle].enh_flags;
}

/** 1 if the last decoded frame carried AV_FRAME_FLAG_INTERLACED. */
int32_t decoder_get_frame_interlaced(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return 0;
    return sessions[handle].frame_interlaced;
}

/** How many decoded frames so far were flagged interlaced. */
int32_t decoder_get_interlaced_frames(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return 0;
    return sessions[handle].interlaced_frames;
}

/** AVCOL_RANGE_* the decoder tagged the last frame with (the codec's own before any frame). */
int32_t decoder_get_video_color_range(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return -1;
    return sessions[handle].frame_range;
}

/** AVCOL_SPC_* likewise. */
int32_t decoder_get_video_colorspace(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES || !sessions[handle].valid) return -1;
    return sessions[handle].frame_space;
}

void decoder_close(int32_t handle) {
    if (handle < 0 || handle >= MAX_HANDLES) return;
    Session *s = &sessions[handle];

    if (s->sws_ctx)        { sws_freeContext(s->sws_ctx); s->sws_ctx = NULL; }
    if (s->swr_ctx)        { swr_free(&s->swr_ctx); }
    if (s->video_ctx)      { avcodec_free_context(&s->video_ctx); }
    if (s->audio_ctx)      { avcodec_free_context(&s->audio_ctx); }
    if (s->raw_frame)      { av_frame_free(&s->raw_frame); }
    if (s->audio_raw_frame){ av_frame_free(&s->audio_raw_frame); }
    if (s->fmt_ctx) {
        /* Prevent avformat_close_input from double-freeing our custom pb */
        s->fmt_ctx->pb = NULL;
        avformat_close_input(&s->fmt_ctx);
    }
    if (s->avio) {
        av_freep(&s->avio->buffer);
        avio_context_free(&s->avio);
    }
    free(s->io_state);
    av_free(s->bgra_buf);
    free(s->rgb565_buf);
    free(s->pal8_indices);
    free(s->audio_ring);
    free(s->audio_tmp);
    free(s->input_data);

    memset(s, 0, sizeof(Session));
}
