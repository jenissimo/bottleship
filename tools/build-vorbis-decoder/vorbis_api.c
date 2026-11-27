#define STB_VORBIS_NO_STDIO
#define STB_VORBIS_NO_PULLDATA_API
#define STB_VORBIS_NO_INTEGER_CONVERSION
#include "stb_vorbis.c"

#define WV_EXPORT(name) __attribute__((export_name(#name)))

static uint8 wv_page[27 + 255 + 65025];

static int wv_wrap(const uint8 *packet, int len, int flags)
{
   int segs, i, last;
   if (len < 0 || len > 65024) return -1;
   segs = len / 255 + 1;
   last = len % 255;
   memset(wv_page, 0, 27);
   memcpy(wv_page, "OggS", 4);
   wv_page[5] = (uint8) flags;
   memset(wv_page + 6, 0xff, 8);
   wv_page[26] = (uint8) segs;
   for (i = 0; i < segs - 1; ++i) wv_page[27 + i] = 255;
   wv_page[27 + segs - 1] = (uint8) last;
   memcpy(wv_page + 27 + segs, packet, len);
   return 27 + segs + len;
}

static void wv_rewind(stb_vorbis *f)
{
   f->previous_length = 0;
   f->page_crc_tests = -1;
   f->discard_samples_deferred = 0;
   f->current_loc_valid = FALSE;
   f->first_decode = FALSE;
   f->samples_output = 0;
   f->channel_buffer_start = 0;
   f->channel_buffer_end = 0;
   f->next_seg = -1;
   f->error = VORBIS__no_error;
}

WV_EXPORT(wv_alloc) void *wv_alloc(int n) { return malloc(n > 0 ? n : 1); }
WV_EXPORT(wv_free) void wv_free(void *p) { free(p); }

WV_EXPORT(wv_open) stb_vorbis *wv_open(const uint8 *id, int idLen, const uint8 *comment, int commentLen, const uint8 *setup, int setupLen)
{
   int total = 3 * (27 + 255) + idLen + commentLen + setupLen;
   uint8 *buf, *p;
   int n, used = 0, err = 0;
   stb_vorbis *f;
   if (idLen > 65024 || commentLen > 65024 || setupLen > 65024) return NULL;
   buf = (uint8 *) malloc(total);
   if (!buf) return NULL;
   p = buf;
   n = wv_wrap(id, idLen, PAGEFLAG_first_page); memcpy(p, wv_page, n); p += n;
   n = wv_wrap(comment, commentLen, 0); memcpy(p, wv_page, n); p += n;
   n = wv_wrap(setup, setupLen, 0); memcpy(p, wv_page, n); p += n;
   f = stb_vorbis_open_pushdata(buf, (int) (p - buf), &used, &err, NULL);
   free(buf);
   if (!f) return NULL;
   wv_rewind(f);
   return f;
}

WV_EXPORT(wv_close) void wv_close(stb_vorbis *f) { if (f) stb_vorbis_close(f); }
WV_EXPORT(wv_reset) void wv_reset(stb_vorbis *f) { wv_rewind(f); }
WV_EXPORT(wv_channels) int wv_channels(stb_vorbis *f) { return f->channels; }
WV_EXPORT(wv_sample_rate) int wv_sample_rate(stb_vorbis *f) { return (int) f->sample_rate; }

WV_EXPORT(wv_decode) int wv_decode(stb_vorbis *f, const uint8 *packet, int len, int16 *out, int maxFrames)
{
   int n, used, channels = 0, frames = 0, c, i;
   float **pcm = NULL;
   n = wv_wrap(packet, len, 0);
   if (n < 0) return -1;
   used = stb_vorbis_decode_frame_pushdata(f, wv_page, n, &channels, &pcm, &frames);
   if (used != n || f->error != VORBIS__no_error) { wv_rewind(f); return -1; }
   if (frames > maxFrames) return -2;
   for (i = 0; i < frames; ++i) {
      for (c = 0; c < channels; ++c) {
         float v = pcm[c][i] * 32768.0f;
         int s;
         if (v >= 32767.0f) s = 32767;
         else if (v <= -32768.0f) s = -32768;
         else s = (int) floorf(v + 0.5f);
         out[i * channels + c] = (int16) s;
      }
   }
   return frames;
}

WV_EXPORT(wv_packet_blocksize) int wv_packet_blocksize(stb_vorbis *f, const uint8 *packet, int len)
{
   int bits = ilog(f->mode_count - 1), mode = 0, i;
   if (len < 1 || (packet[0] & 1)) return -1;
   for (i = 0; i < bits; ++i) {
      int b = 1 + i;
      if ((b >> 3) >= len) return -1;
      mode |= ((packet[b >> 3] >> (b & 7)) & 1) << i;
   }
   if (mode >= f->mode_count) return -1;
   return f->blocksize[f->mode_config[mode].blockflag];
}
