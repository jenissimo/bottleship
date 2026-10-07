`ppm-lz.rar.bin` is the uu-decoded `test_read_format_rar_ppmd_lzss_conversion.rar.uu`
from libarchive commit `8bb3bbdc7b117a1e22086a2260f2087aafa90687`:
https://github.com/libarchive/libarchive/blob/8bb3bbdc7b117a1e22086a2260f2087aafa90687/libarchive/test/test_read_format_rar_ppmd_lzss_conversion.rar.uu

The upstream test supplies the independent output length (241,647,978 bytes) and
the final 42-byte text. The archive also carries the output CRC32. It switches
between PPMd and LZ three times and exercises PPM state reuse after an LZ block.
License: `LICENSE-libarchive.txt`.
