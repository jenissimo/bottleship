/* flat-pair mini libc implementation (see include/bslibc.h). Deterministic, integer-heavy, no
 * platform calls: the same code runs in every arm. Float formatting/parsing/libm are simple and
 * NOT correctly rounded in general; the Lua scripts only feed them exact values. */
#include "bslibc.h"

#if defined(_MSC_VER) && !defined(__clang__)
void __halt(void);
#pragma intrinsic(__halt)
const unsigned int bs_huge_bits[2] = { 0u, 0x7ff00000u };
static void bs_die(void) { for (;;) __halt(); }
#else
static void bs_die(void) { __builtin_trap(); }
#endif

void bs_out(unsigned int v);

int errno;
unsigned int bs_print_hash = 2166136261u;
unsigned int bs_print_bytes;

/* ---------------- memory: size classes over a static arena, reset per phase ---------------- */
#define ARENA_BYTES (24u << 20)
#define NCLASS 96
static double g_arena_d[ARENA_BYTES / 8];
static unsigned char* const g_arena = (unsigned char*)g_arena_d;
static size_t g_top;
static void* g_free[NCLASS];

static unsigned int cls_of(size_t n) {
    if (n <= 1024) return (unsigned int)((n + 15) >> 4);          /* 1..64, cap = c*16 */
    { unsigned int k = 11; while (((size_t)1 << k) < n) k++; return 64 + (k - 10); } /* 65.. */
}
static size_t cap_of(unsigned int c) { return c <= 64 ? (size_t)c * 16 : (size_t)1 << (c - 64 + 10); }

void bs_heap_reset(void) {
    unsigned int i;
    g_top = 0;
    for (i = 0; i < NCLASS; i++) g_free[i] = 0;
}
void* malloc(size_t n) {
    unsigned int c;
    unsigned char* p;
    if (n == 0) n = 1;
    c = cls_of(n);
    if (c >= NCLASS) { bs_out(0xDEAD0001u); bs_die(); }
    if (g_free[c]) { p = (unsigned char*)g_free[c]; g_free[c] = *(void**)p; return p; }
    if (g_top + 8 + cap_of(c) > ARENA_BYTES) { bs_out(0xDEAD0002u); bs_die(); }
    p = g_arena + g_top;
    *(unsigned int*)p = c;
    g_top += 8 + cap_of(c);
    return p + 8;
}
void free(void* q) {
    unsigned char* p = (unsigned char*)q;
    unsigned int c;
    if (!p) return;
    c = *(unsigned int*)(p - 8);
    *(void**)p = g_free[c];
    g_free[c] = p;
}
void* realloc(void* q, size_t n) {
    unsigned char* p = (unsigned char*)q;
    unsigned int c;
    void* r;
    if (!p) return malloc(n);
    if (n == 0) { free(p); return 0; }
    c = *(unsigned int*)(p - 8);
    if (cap_of(c) >= n && (c <= 64 || cap_of(c) / 2 < n)) return p;
    r = malloc(n);
    memcpy(r, p, cap_of(c) < n ? cap_of(c) : n);
    free(p);
    return r;
}
void* calloc(size_t n, size_t m) { void* p = malloc(n * m); memset(p, 0, n * m); return p; }
void abort(void) { bs_out(0xDEAD0003u); bs_die(); }
void exit(int code) { bs_out(0xDEAD0100u | (unsigned)code); bs_die(); }
char* getenv(const char* n) { (void)n; return 0; }
int system(const char* c) { (void)c; return -1; }
int abs(int x) { return x < 0 ? -x : x; }
long labs(long x) { return x < 0 ? -x : x; }
static unsigned int g_rand = 1;
int rand(void) { g_rand = g_rand * 1103515245u + 12345u; return (int)((g_rand >> 16) & 0x7fff); }
void srand(unsigned s) { g_rand = s; }

/* ---------------- string.h ---------------- */
void* memcpy(void* d, const void* s, size_t n) {
    unsigned char* a = (unsigned char*)d; const unsigned char* b = (const unsigned char*)s;
    while (n >= 4) { *(unsigned int*)a = *(const unsigned int*)b; a += 4; b += 4; n -= 4; }
    while (n--) *a++ = *b++;
    return d;
}
void* memmove(void* d, const void* s, size_t n) {
    unsigned char* a = (unsigned char*)d; const unsigned char* b = (const unsigned char*)s;
    if (a < b) while (n--) *a++ = *b++;
    else { a += n; b += n; while (n--) *--a = *--b; }
    return d;
}
void* memset(void* d, int c, size_t n) { unsigned char* a = (unsigned char*)d; while (n--) *a++ = (unsigned char)c; return d; }
int memcmp(const void* x, const void* y, size_t n) {
    const unsigned char* a = (const unsigned char*)x; const unsigned char* b = (const unsigned char*)y;
    for (; n; n--, a++, b++) if (*a != *b) return *a < *b ? -1 : 1;
    return 0;
}
void* memchr(const void* s, int c, size_t n) {
    const unsigned char* a = (const unsigned char*)s;
    for (; n; n--, a++) if (*a == (unsigned char)c) return (void*)a;
    return 0;
}
size_t strlen(const char* s) { const char* p = s; while (*p) p++; return (size_t)(p - s); }
int strcmp(const char* a, const char* b) {
    while (*a && *a == *b) { a++; b++; }
    return (unsigned char)*a < (unsigned char)*b ? -1 : (unsigned char)*a > (unsigned char)*b;
}
int strncmp(const char* a, const char* b, size_t n) {
    for (; n; n--, a++, b++) { if (*a != *b) return (unsigned char)*a < (unsigned char)*b ? -1 : 1; if (!*a) return 0; }
    return 0;
}
int strcoll(const char* a, const char* b) { return strcmp(a, b); }
char* strchr(const char* s, int c) { for (;; s++) { if (*s == (char)c) return (char*)s; if (!*s) return 0; } }
char* strrchr(const char* s, int c) { const char* r = 0; for (;; s++) { if (*s == (char)c) r = s; if (!*s) return (char*)r; } }
size_t strspn(const char* s, const char* set) { size_t n = 0; while (s[n] && strchr(set, s[n])) n++; return n; }
size_t strcspn(const char* s, const char* set) { size_t n = 0; while (s[n] && !strchr(set, s[n])) n++; return n; }
char* strpbrk(const char* s, const char* set) { for (; *s; s++) if (strchr(set, *s)) return (char*)s; return 0; }
char* strstr(const char* h, const char* n) {
    size_t l = strlen(n);
    if (!l) return (char*)h;
    for (; *h; h++) if (*h == *n && !strncmp(h, n, l)) return (char*)h;
    return 0;
}
char* strcpy(char* d, const char* s) { char* r = d; while ((*d++ = *s++)) {} return r; }
char* strncpy(char* d, const char* s, size_t n) { size_t i = 0; for (; i < n && s[i]; i++) d[i] = s[i]; for (; i < n; i++) d[i] = 0; return d; }
char* strcat(char* d, const char* s) { strcpy(d + strlen(d), s); return d; }
char* strerror(int e) { (void)e; return (char*)"error"; }

/* ---------------- ctype.h (ASCII) ---------------- */
int isdigit(int c) { return c >= '0' && c <= '9'; }
int isupper(int c) { return c >= 'A' && c <= 'Z'; }
int islower(int c) { return c >= 'a' && c <= 'z'; }
int isalpha(int c) { return isupper(c) || islower(c); }
int isalnum(int c) { return isalpha(c) || isdigit(c); }
int isspace(int c) { return c == ' ' || (c >= 9 && c <= 13); }
int isxdigit(int c) { return isdigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
int iscntrl(int c) { return (c >= 0 && c < 32) || c == 127; }
int isprint(int c) { return c >= 32 && c < 127; }
int isgraph(int c) { return c > 32 && c < 127; }
int ispunct(int c) { return isgraph(c) && !isalnum(c); }
int tolower(int c) { return isupper(c) ? c + 32 : c; }
int toupper(int c) { return islower(c) ? c - 32 : c; }

/* ---------------- time / locale ---------------- */
time_t time(time_t* t) { if (t) *t = 0; return 0; }
clock_t clock(void) { return 0; }
static char g_dp[2] = ".";
static struct lconv g_lconv = { g_dp };
struct lconv* localeconv(void) { return &g_lconv; }
char* setlocale(int c, const char* l) { (void)c; (void)l; return (char*)"C"; }

/* ---------------- math (bit-level where possible) ---------------- */
typedef union { double d; unsigned int w[2]; } dbits;   /* little-endian: w[1] = high word */
static double g_zero = 0.0;
double fabs(double x) { dbits u; u.d = x; u.w[1] &= 0x7fffffffu; return u.d; }
double floor(double x) {
    dbits u; int e; unsigned int lo_mask, hi_mask, had = 0;
    u.d = x;
    e = (int)((u.w[1] >> 20) & 0x7ff) - 1023;
    if (e >= 52) return x;
    if (e < 0) { if (x >= 0.0) return (u.w[1] >> 31) ? x : 0.0; return -1.0; }
    if (e >= 20) { lo_mask = 0xffffffffu >> (e - 20); hi_mask = 0; if (e == 52) lo_mask = 0; }
    else { lo_mask = 0xffffffffu; hi_mask = 0x000fffffu >> e; }
    had = (u.w[0] & lo_mask) | (u.w[1] & hi_mask);
    u.w[0] &= ~lo_mask; u.w[1] &= ~hi_mask;
    if (had && x < 0.0) return u.d - 1.0;
    return u.d;
}
double ceil(double x) { return -floor(-x); }
static double trunc_(double x) { return x < 0.0 ? -floor(-x) : floor(x); }
double fmod(double x, double y) { if (y == 0.0) return g_zero / g_zero; return x - trunc_(x / y) * y; }
double modf(double x, double* ip) { double t = trunc_(x); *ip = t; return x - t; }
double frexp(double x, int* e) {
    dbits u; int ex;
    u.d = x;
    ex = (int)((u.w[1] >> 20) & 0x7ff);
    if (x == 0.0 || ex == 0x7ff) { *e = 0; return x; }
    if (ex == 0) { u.d = x * 18014398509481984.0; ex = (int)((u.w[1] >> 20) & 0x7ff) - 54; }
    *e = ex - 1022;
    u.w[1] = (u.w[1] & 0x800fffffu) | (1022u << 20);
    return u.d;
}
double ldexp(double x, int e) {
    while (e > 1000) { x *= 1.0715086071862673e301; e -= 1000; }   /* 2^1000 */
    while (e < -1000) { x *= 9.3326361850321888e-302; e += 1000; } /* 2^-1000 */
    {
        dbits u;
        if (e >= -1022) { u.w[0] = 0; u.w[1] = (unsigned int)(e + 1023) << 20; return x * u.d; }
        u.w[0] = 0; u.w[1] = (unsigned int)(e + 1022 + 54 + 1023 - 54 + 54) << 20; /* e in [-1000,-1023) */
        return x * u.d * 5.5511151231257827e-17;
    }
}
double sqrt(double x) {
    double g; int e, i;
    if (x <= 0.0) return x == 0.0 ? x : g_zero / g_zero;
    g = frexp(x, &e);
    g = ldexp(0.5 + 0.5 * g, e / 2);
    for (i = 0; i < 8; i++) g = 0.5 * (g + x / g);
    /* exact for perfect squares: fix the last ulp by testing neighbours */
    if (g * g > x) { double h = g - g * 2.2204460492503131e-16; if (h * h >= x) g = h; }
    return g;
}
static const double LN2 = 0.69314718055994530942;
double log(double x) {
    int e, i; double m, s, s2, t, r;
    if (x <= 0.0) return x == 0.0 ? -HUGE_VAL : g_zero / g_zero;
    m = frexp(x, &e);
    if (m < 0.70710678118654752) { m *= 2.0; e--; }
    s = (m - 1.0) / (m + 1.0); s2 = s * s; t = s; r = 0.0;
    for (i = 1; i < 40; i += 2) { r += t / i; t *= s2; }
    return 2.0 * r + e * LN2;
}
double log2(double x) { return log(x) / LN2; }
double log10(double x) { return log(x) / 2.30258509299404568402; }
double exp(double x) {
    double n, r, t, s; int i;
    if (x > 709.0) return HUGE_VAL;
    if (x < -745.0) return 0.0;
    n = floor(x / LN2 + 0.5); r = x - n * LN2;
    t = 1.0; s = 1.0;
    for (i = 1; i < 25; i++) { t *= r / i; s += t; }
    return ldexp(s, (int)n);
}
double pow(double x, double y) {
    double r = 1.0, b = x; int neg = 0; long n;
    if (y == floor(y) && fabs(y) < 2147483647.0) {
        n = (long)y;
        if (n < 0) { neg = 1; n = -n; }
        while (n) { if (n & 1) r *= b; b *= b; n >>= 1; }
        return neg ? 1.0 / r : r;
    }
    if (x < 0.0) return g_zero / g_zero;
    return exp(y * log(x));
}
static const double PI = 3.14159265358979323846;
double sin(double x) {
    double k = floor(x / (2 * PI) + 0.5), r = x - k * 2 * PI, t = r, s = r; int i;
    for (i = 1; i < 20; i++) { t *= -r * r / ((2 * i) * (2 * i + 1)); s += t; }
    return s;
}
double cos(double x) { return sin(x + PI / 2); }
double tan(double x) { return sin(x) / cos(x); }
double atan(double x) {
    int inv = 0, neg = 0, i, halv = 0; double s, t, r, x2;
    if (x < 0) { neg = 1; x = -x; }
    if (x > 1.0) { inv = 1; x = 1.0 / x; }
    while (x > 0.25) { x = x / (1.0 + sqrt(1.0 + x * x)); halv++; }
    x2 = x * x; t = x; s = 0.0;
    for (i = 0; i < 30; i++) { s += t / (2 * i + 1) * (i & 1 ? -1.0 : 1.0); t *= x2; }
    r = s * (double)(1 << halv);
    if (inv) r = PI / 2 - r;
    return neg ? -r : r;
}
double atan2(double y, double x) {
    if (x > 0) return atan(y / x);
    if (x < 0) return y >= 0 ? atan(y / x) + PI : atan(y / x) - PI;
    return y > 0 ? PI / 2 : (y < 0 ? -PI / 2 : 0.0);
}
double asin(double x) { return atan2(x, sqrt(1.0 - x * x)); }
double acos(double x) { return atan2(sqrt(1.0 - x * x), x); }

/* ---------------- strtod / strtol ---------------- */
double strtod(const char* s, char** end) {
    const char* p = s; double v = 0.0; int neg = 0, digits = 0, e10 = 0;
    while (isspace((unsigned char)*p)) p++;
    if (*p == '+' || *p == '-') neg = *p++ == '-';
    while (isdigit((unsigned char)*p)) { v = v * 10.0 + (*p++ - '0'); digits++; }
    if (*p == '.') { p++; while (isdigit((unsigned char)*p)) { v = v * 10.0 + (*p++ - '0'); e10--; digits++; } }
    if (!digits) { if (end) *end = (char*)s; return 0.0; }
    if (*p == 'e' || *p == 'E') {
        const char* q = p + 1; int en = 0, eneg = 0, ed = 0;
        if (*q == '+' || *q == '-') eneg = *q++ == '-';
        while (isdigit((unsigned char)*q)) { if (en < 10000) en = en * 10 + (*q - '0'); q++; ed++; }
        if (ed) { p = q; e10 += eneg ? -en : en; }
    }
    while (e10 > 0) { v *= 10.0; e10--; }
    while (e10 < 0) { v /= 10.0; e10++; }
    if (end) *end = (char*)p;
    return neg ? -v : v;
}
unsigned long strtoul(const char* s, char** end, int base) {
    const char* p = s; unsigned long v = 0; int any = 0, neg = 0;
    while (isspace((unsigned char)*p)) p++;
    if (*p == '+' || *p == '-') neg = *p++ == '-';
    if ((base == 0 || base == 16) && p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) { p += 2; base = 16; }
    if (base == 0) base = 10;
    for (;; p++) {
        int d = isdigit((unsigned char)*p) ? *p - '0' : isalpha((unsigned char)*p) ? tolower((unsigned char)*p) - 'a' + 10 : 99;
        if (d >= base) break;
        v = v * (unsigned long)base + (unsigned long)d; any = 1;
    }
    if (end) *end = (char*)(any ? p : s);
    return neg ? (unsigned long)(-(long)v) : v;
}
long strtol(const char* s, char** end, int base) { return (long)strtoul(s, end, base); }

/* ---------------- printf family ---------------- */
typedef struct { char* buf; size_t cap; size_t len; } outbuf;
static void put(outbuf* o, char c) { if (o->len + 1 < o->cap) o->buf[o->len] = c; o->len++; }
static void puts_n(outbuf* o, const char* s, size_t n) { while (n--) put(o, *s++); }

/* digits of a non-negative integral double (< 2^53) into tmp, returns count (reversed order) */
static int int_digits(double v, char* tmp) {
    int n = 0;
    if (v < 1.0) { tmp[n++] = '0'; return n; }
    while (v >= 1.0 && n < 400) { double q = floor(v / 10.0); int d = (int)(v - q * 10.0); if (d < 0) d = 0; if (d > 9) d = 9; tmp[n++] = (char)('0' + d); v = q; }
    return n;
}
static double pow10i(int k) { double r = 1.0; while (k-- > 0) r *= 10.0; return r; }

static void fmt_double(outbuf* o, double v, char conv, int prec, int alt, int plus, int space, int width, int left, int zero) {
    char body[512]; int bl = 0; char tmp[400]; int n, i, exp10 = 0;
    int upper = conv == 'E' || conv == 'G' || conv == 'F';
    char c = (char)tolower(conv);
    char sign = 0;
    if (v != v) { puts_n(o, upper ? "NAN" : "nan", 3); return; }
    if (v < 0.0 || (v == 0.0 && 1.0 / v < 0.0)) { sign = '-'; v = -v; }
    else if (plus) sign = '+'; else if (space) sign = ' ';
    if (v > 1.7976931348623157e308) { if (sign) put(o, sign); puts_n(o, upper ? "INF" : "inf", 3); return; }
    if (prec < 0) prec = 6;
    if (c == 'g') {
        double m = v; int P = prec == 0 ? 1 : prec;
        if (m != 0.0) { while (m >= 10.0) { m /= 10.0; exp10++; } while (m < 1.0) { m *= 10.0; exp10--; } }
        /* rounding can carry into the next decade */
        if (m != 0.0 && floor(m * pow10i(P - 1) + 0.5) >= pow10i(P)) exp10++;
        if (P > exp10 && exp10 >= -4) { c = 'f'; prec = P - 1 - exp10; }
        else { c = 'e'; prec = P - 1; }
        if (!alt) alt = -1; /* strip trailing zeros */
    }
    if (c == 'f') {
        double ip = floor(v), fp = v - ip, scaled;
        if (ip >= 9007199254740992.0) { scaled = 0; }
        scaled = floor(fp * pow10i(prec) + 0.5);
        if (scaled >= pow10i(prec)) { scaled -= pow10i(prec); ip += 1.0; }
        n = int_digits(ip, tmp);
        for (i = n - 1; i >= 0; i--) body[bl++] = tmp[i];
        if (prec > 0 || alt > 0) {
            body[bl++] = '.';
            n = int_digits(scaled, tmp);
            for (i = prec; i > n; i--) body[bl++] = '0';
            for (i = n - 1; i >= 0 && bl < 500; i--) if (prec >= n || i < prec) body[bl++] = tmp[i];
        }
    } else {
        double m = v, digs; int e = 0;
        if (m != 0.0) { while (m >= 10.0) { m /= 10.0; e++; } while (m < 1.0) { m *= 10.0; e--; } }
        digs = floor(m * pow10i(prec) + 0.5);
        if (digs >= pow10i(prec + 1)) { digs = floor(digs / 10.0); e++; }
        n = int_digits(digs, tmp);
        body[bl++] = tmp[n - 1];
        if (prec > 0 || alt > 0) body[bl++] = '.';
        for (i = n - 2; i >= 0; i--) body[bl++] = tmp[i];
        if (alt < 0) { while (bl > 1 && body[bl - 1] == '0') bl--; if (body[bl - 1] == '.') bl--; alt = 0; }
        body[bl++] = upper ? 'E' : 'e';
        body[bl++] = e < 0 ? '-' : '+';
        if (e < 0) e = -e;
        n = int_digits((double)e, tmp);
        if (n < 2) body[bl++] = '0';
        for (i = n - 1; i >= 0; i--) body[bl++] = tmp[i];
    }
    if (alt < 0) {
        int dot = -1;
        for (i = 0; i < bl; i++) if (body[i] == '.') dot = i;
        if (dot >= 0) { while (bl > dot + 1 && body[bl - 1] == '0') bl--; if (bl == dot + 1) bl--; }
    }
    {
        int total = bl + (sign ? 1 : 0), pad = width > total ? width - total : 0;
        if (!left && !zero) while (pad-- > 0) put(o, ' ');
        if (sign) put(o, sign);
        if (!left && zero) while (pad-- > 0) put(o, '0');
        puts_n(o, body, (size_t)bl);
        if (left) while (pad-- > 0) put(o, ' ');
    }
}

int vsnprintf(char* buf, size_t cap, const char* f, va_list ap) {
    outbuf o; o.buf = buf; o.cap = cap; o.len = 0;
    for (; *f; f++) {
        int left = 0, plus = 0, space = 0, alt = 0, zero = 0, width = 0, prec = -1, lng = 0;
        if (*f != '%') { put(&o, *f); continue; }
        f++;
        for (;; f++) {
            if (*f == '-') left = 1; else if (*f == '+') plus = 1; else if (*f == ' ') space = 1;
            else if (*f == '#') alt = 1; else if (*f == '0') zero = 1; else break;
        }
        if (*f == '*') { width = va_arg(ap, int); f++; } else while (isdigit((unsigned char)*f)) width = width * 10 + (*f++ - '0');
        if (*f == '.') { f++; prec = 0; if (*f == '*') { prec = va_arg(ap, int); f++; } else while (isdigit((unsigned char)*f)) prec = prec * 10 + (*f++ - '0'); }
        while (*f == 'l' || *f == 'h' || *f == 'z' || *f == 'j' || *f == 't' || *f == 'L') { if (*f == 'l') lng++; f++; }
        switch (*f) {
        case 'd': case 'i': case 'u': case 'x': case 'X': case 'o': case 'c': case 'p': {
            unsigned int u; int neg = 0; char tmp[40]; int n = 0, base = 10, i; char sign = 0;
            const char* digs = *f == 'X' ? "0123456789ABCDEF" : "0123456789abcdef";
            if (*f == 'c') { char ch = (char)va_arg(ap, int); int pad = width > 1 ? width - 1 : 0; if (!left) while (pad-- > 0) put(&o, ' '); put(&o, ch); if (left) while (pad-- > 0) put(&o, ' '); break; }
            if (*f == 'p') { u = (unsigned int)(size_t)va_arg(ap, void*); base = 16; alt = 1; }
            else if (lng >= 2) { long long v = va_arg(ap, long long); u = (unsigned int)v; if ((*f == 'd' || *f == 'i') && (int)u < 0) { neg = 1; u = 0u - u; } }
            else { int v = va_arg(ap, int); u = (unsigned int)v; if ((*f == 'd' || *f == 'i') && v < 0) { neg = 1; u = 0u - u; } }
            if (*f == 'x' || *f == 'X') base = 16; else if (*f == 'o') base = 8;
            do { tmp[n++] = digs[u % (unsigned)base]; u /= (unsigned)base; } while (u);
            while (n < prec) tmp[n++] = '0';
            if (neg) sign = '-'; else if (plus && (*f == 'd' || *f == 'i')) sign = '+'; else if (space && (*f == 'd' || *f == 'i')) sign = ' ';
            {
                int pre = (sign ? 1 : 0) + ((alt && base == 16) ? 2 : 0) + ((alt && base == 8 && tmp[n - 1] != '0') ? 1 : 0);
                int pad = width > n + pre ? width - n - pre : 0;
                if (!left && !(zero && prec < 0)) while (pad-- > 0) put(&o, ' ');
                if (sign) put(&o, sign);
                if (alt && base == 16) { put(&o, '0'); put(&o, *f == 'X' ? 'X' : 'x'); }
                if (alt && base == 8 && tmp[n - 1] != '0') put(&o, '0');
                if (!left && zero && prec < 0) while (pad-- > 0) put(&o, '0');
                for (i = n - 1; i >= 0; i--) put(&o, tmp[i]);
                if (left) while (pad-- > 0) put(&o, ' ');
            }
            break;
        }
        case 'e': case 'E': case 'f': case 'F': case 'g': case 'G': case 'a': case 'A':
            fmt_double(&o, va_arg(ap, double), *f == 'a' ? 'g' : *f == 'A' ? 'G' : *f, prec, alt, plus, space, width, left, zero);
            break;
        case 's': {
            const char* s = va_arg(ap, const char*); size_t n = 0; int pad;
            if (!s) s = "(null)";
            while (s[n] && (prec < 0 || (int)n < prec)) n++;
            pad = width > (int)n ? width - (int)n : 0;
            if (!left) while (pad-- > 0) put(&o, ' ');
            puts_n(&o, s, n);
            if (left) while (pad-- > 0) put(&o, ' ');
            break;
        }
        case '%': put(&o, '%'); break;
        default: put(&o, '%'); if (*f) put(&o, *f); else f--; break;
        }
    }
    if (cap) o.buf[o.len < cap ? o.len : cap - 1] = 0;
    return (int)o.len;
}
int snprintf(char* s, size_t n, const char* f, ...) { int r; va_list ap; va_start(ap, f); r = vsnprintf(s, n, f, ap); va_end(ap); return r; }
int sprintf(char* s, const char* f, ...) { int r; va_list ap; va_start(ap, f); r = vsnprintf(s, 0x7fffffff, f, ap); va_end(ap); return r; }

/* ---------------- stdio: output is hashed, files do not exist ---------------- */
static FILE g_files[3] = { { 0 }, { 1 }, { 2 } };
FILE* stdin = &g_files[0];
FILE* stdout = &g_files[1];
FILE* stderr = &g_files[2];
static void hash_bytes(const void* p, size_t n) {
    const unsigned char* b = (const unsigned char*)p;
    bs_print_bytes += (unsigned int)n;
    while (n--) bs_print_hash = (bs_print_hash ^ *b++) * 16777619u;
}
size_t fwrite(const void* p, size_t s, size_t n, FILE* f) { (void)f; hash_bytes(p, s * n); return n; }
int fputs(const char* s, FILE* f) { fwrite(s, 1, strlen(s), f); return 0; }
int fputc(int c, FILE* f) { char ch = (char)c; fwrite(&ch, 1, 1, f); return c; }
int vfprintf(FILE* fp, const char* f, va_list ap) { char b[512]; int r = vsnprintf(b, sizeof b, f, ap); fputs(b, fp); return r; }
int fprintf(FILE* fp, const char* f, ...) { int r; va_list ap; va_start(ap, f); r = vfprintf(fp, f, ap); va_end(ap); return r; }
int printf(const char* f, ...) { int r; va_list ap; va_start(ap, f); r = vfprintf(stdout, f, ap); va_end(ap); return r; }
int fflush(FILE* f) { (void)f; return 0; }
FILE* fopen(const char* n, const char* m) { (void)n; (void)m; errno = EINVAL; return 0; }
FILE* freopen(const char* n, const char* m, FILE* f) { (void)n; (void)m; (void)f; return 0; }
int fclose(FILE* f) { (void)f; return 0; }
size_t fread(void* p, size_t s, size_t n, FILE* f) { (void)p; (void)s; (void)n; (void)f; return 0; }
int getc(FILE* f) { (void)f; return EOF; }
int ungetc(int c, FILE* f) { (void)c; (void)f; return EOF; }
char* fgets(char* s, int n, FILE* f) { (void)s; (void)n; (void)f; return 0; }
int ferror(FILE* f) { (void)f; return 0; }
int feof(FILE* f) { (void)f; return 1; }
void clearerr(FILE* f) { (void)f; }
