/* lanprobe — one generic x86 Winsock conformance probe.
 *
 * Reads a .lp script, performs the API calls, logs every result as text.
 * The same PE runs natively and in the emulator; logs are compared line by
 * line, so every nondeterminism must be named symbolically BY the probe:
 * socket handles are the variable names they are assigned to, ephemeral
 * ports are printed as "<socket>.port", and error codes as WSAE* names.
 *
 * Usage: lanprobe.exe <script.lp> <log.txt>
 * Exit codes: 0 ok, 2 script error, 3 cannot open script/log, 90 watchdog,
 *             108 unhandled exception (also logged as a "crash" line).
 *
 * Bind every socket whose address may appear in a log line: an unbound
 * peer's ephemeral port prints as a raw number and is not reproducible.
 *
 * Script language (one command per line):
 *   # comment                       — not logged
 *   echo <text>                     — logged as "# text"
 *   [v =] wsastartup <ver>          — ver like 0x202; logs negotiated versions
 *   wsacleanup / wsasetlasterror <code>
 *   [v =] socket <af> <type> <proto>
 *   closesocket <s> / shutdown <s> <how>
 *   bind <s> <addr>                 — addr "d.d.d.d:port" or "<sym>[.addr]"
 *   getsockname <s> / getpeername <s> / listen <s> <backlog>
 *   [v =] accept <s> / connect <s> <addr>
 *   send <s> <data> [peek|oob] / recv <s> <size> [peek|oob]
 *   sendto <s> <addr> <data> / recvfrom <s> <size> [peek|oob]
 *   ioctlsocket <s> <cmd> [u32:<v>]    (FIONBIO / FIONREAD / SIOCATMARK)
 *   wsaioctl <s> <cmd> [in=<buf>] [out=<size>]
 *   setsockopt <s> <level> <opt> <buf> / getsockopt <s> <level> <opt> <size>
 *   select [t=<ms>] [r=s1,s2] [w=..] [e=..]    (t=-1 blocks)
 *   sleep <ms>
 *   gate <name> [t=<ms>]            — role barrier: logs "enter", then blocks
 *                                     until <logdir>/gate-<name>.open appears
 *   [v =] udp_open_port             — bind 127.0.0.1:0, keep open
 *   [v =] udp_closed_port           — bind 127.0.0.1:0, close
 * Data literals: "bytes", u8:<v>, u32:<v> (LE), buf:<n>.
 * Multi-role cases use FIXED ports on every role so addresses stay symbolic.
 */
#define _WIN32_WINNT 0x0600
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>

#define MAX_LINE 512
#define MAX_TOKS 24
#define MAX_SYM 128
#define SYM_NAME 24
#define SEL_MAX 16

typedef struct {
    char name[SYM_NAME];
    int used;
    int hasHandle;
    SOCKET handle;
    int isAddr;                 /* standalone address value (udp_closed_port) */
    int hasAddr;                /* bound address known */
    SOCKADDR_IN addr;
} Sym;

static HANDLE logHandle = INVALID_HANDLE_VALUE;
static Sym syms[MAX_SYM];
static WSADATA wsaData;
static int commandsRun;
static int scriptErrors;
static int failedCommands;      /* commands whose API call returned failure */

/* ---------------- tiny libc ---------------- */

static DWORD wstrlen(const char *s) { DWORD n = 0; while (s[n]) n++; return n; }
static int wmemeq(const char *a, const char *b, DWORD n) {
    DWORD i;
    for (i = 0; i < n; i++) if (a[i] != b[i]) return 0;
    return 1;
}
static int wstreq(const char *a, const char *b) {
    DWORD la = wstrlen(a), lb = wstrlen(b);
    return la == lb && wmemeq(a, b, la);
}
static void wcopy(char *d, const char *s, DWORD n) { while (n--) *d++ = *s++; }
static void memzero(void *p, DWORD n) { BYTE *b = (BYTE *)p; while (n--) *b++ = 0; }

static void out_append(char **p, const char *s) { DWORD n = wstrlen(s); wcopy(*p, s, n); *p += n; **p = 0; }
static void out_ch(char **p, char c) { *(*p)++ = c; **p = 0; }

static void out_int(char **p, long v) {
    char tmp[16]; int neg = v < 0; DWORD i = 0;
    unsigned long u = neg ? (unsigned long)-(v + 1) + 1u : (unsigned long)v;
    **p = 0;
    if (u == 0) tmp[i++] = '0';
    while (u) { tmp[i++] = (char)('0' + (u % 10)); u /= 10; }
    if (neg) out_ch(p, '-');
    while (i) out_ch(p, tmp[--i]);
}
static void out_hex(char **p, unsigned long v) {
    char tmp[12]; DWORD i = 0; **p = 0;
    if (v == 0) tmp[i++] = '0';
    while (v) { unsigned d = (unsigned)(v & 15); tmp[i++] = (char)(d < 10 ? '0' + d : 'a' + d - 10); v >>= 4; }
    out_ch(p, '0'); out_ch(p, 'x');
    while (i) out_ch(p, tmp[--i]);
}

/* ---------------- constants ---------------- */

struct NameValue { const char *name; long value; };
static const struct NameValue constants[] = {
    {"AF_INET", AF_INET}, {"AF_INET6", AF_INET6}, {"AF_UNSPEC", AF_UNSPEC},
    {"SOCK_STREAM", SOCK_STREAM}, {"SOCK_DGRAM", SOCK_DGRAM}, {"SOCK_RAW", SOCK_RAW},
    {"IPPROTO_ICMP", IPPROTO_ICMP}, {"IPPROTO_TCP", IPPROTO_TCP}, {"IPPROTO_UDP", IPPROTO_UDP},
    {"SOL_SOCKET", SOL_SOCKET},
    {"SO_TYPE", SO_TYPE}, {"SO_SNDBUF", SO_SNDBUF}, {"SO_RCVBUF", SO_RCVBUF},
    {"SO_REUSEADDR", SO_REUSEADDR}, {"SO_KEEPALIVE", SO_KEEPALIVE}, {"SO_BROADCAST", SO_BROADCAST},
    {"SO_DONTROUTE", SO_DONTROUTE}, {"SO_ERROR", SO_ERROR}, {"SO_RCVTIMEO", SO_RCVTIMEO},
    {"SO_SNDTIMEO", SO_SNDTIMEO}, {"SO_LINGER", SO_LINGER}, {"SO_OOBINLINE", SO_OOBINLINE},
    {"FIONREAD", FIONREAD}, {"FIONBIO", FIONBIO}, {"SIOCATMARK", SIOCATMARK},
    {"SIO_UDP_CONNRESET", 0x9800000cL}, {"SIO_UDP_NETERR", 0x9800000fL},
    {"MSG_PEEK", MSG_PEEK}, {"MSG_OOB", MSG_OOB}, {"MSG_DONTROUTE", MSG_DONTROUTE},
    {"SD_RECEIVE", SD_RECEIVE}, {"SD_SEND", SD_SEND}, {"SD_BOTH", SD_BOTH},
    {0, 0}
};

/* WSA error names, in value order so the table doubles as a range check. */
static const struct NameValue errTable[] = {
    {"WSAEINTR", 10004}, {"WSAEBADF", 10009}, {"WSAEACCES", 10013}, {"WSAEFAULT", 10014},
    {"WSAEINVAL", 10022}, {"WSAEMFILE", 10024}, {"WSAEWOULDBLOCK", 10035},
    {"WSAEINPROGRESS", 10036}, {"WSAEALREADY", 10037}, {"WSAENOTSOCK", 10038},
    {"WSAEDESTADDRREQ", 10039}, {"WSAEMSGSIZE", 10040}, {"WSAEPROTOTYPE", 10041},
    {"WSAENOPROTOOPT", 10042}, {"WSAEPROTONOSUPPORT", 10043}, {"WSAESOCKTNOSUPPORT", 10044},
    {"WSAEOPNOTSUPP", 10045}, {"WSAEPFNOSUPPORT", 10046}, {"WSAEAFNOSUPPORT", 10047},
    {"WSAEADDRINUSE", 10048}, {"WSAEADDRNOTAVAIL", 10049}, {"WSAENETDOWN", 10050},
    {"WSAENETUNREACH", 10051}, {"WSAENETRESET", 10052}, {"WSAECONNABORTED", 10053},
    {"WSAECONNRESET", 10054}, {"WSAENOBUFS", 10055}, {"WSAEISCONN", 10056},
    {"WSAENOTCONN", 10057}, {"WSAESHUTDOWN", 10058}, {"WSAETOOMANYREFS", 10059},
    {"WSAETIMEDOUT", 10060}, {"WSAECONNREFUSED", 10061}, {"WSAELOOP", 10062},
    {"WSAENAMETOOLONG", 10063}, {"WSAEHOSTDOWN", 10064}, {"WSAEHOSTUNREACH", 10065},
    {"WSAENOTEMPTY", 10066}, {"WSAEPROCLIM", 10067}, {"WSAEUSERS", 10068},
    {"WSAEDQUOT", 10069}, {"WSAESTALE", 10070}, {"WSAEREMOTE", 10071},
    {"WSASYSNOTREADY", 10091}, {"WSAVERNOTSUPPORTED", 10092}, {"WSANOTINITIALISED", 10093},
    {"WSAEDISCON", 10101},
    {0, 0}
};

static const char *errName(long e) {
    DWORD i;
    for (i = 0; errTable[i].name; i++) if (errTable[i].value == e) return errTable[i].name;
    return 0;
}
static const char *constName(long v) {
    DWORD i;
    for (i = 0; constants[i].name; i++) if (constants[i].value == v) return constants[i].name;
    return 0;
}

/* ---------------- logging ---------------- */

static void log_line(const char *buf) {
    DWORD written;
    WriteFile(logHandle, buf, wstrlen(buf), &written, 0);
    WriteFile(logHandle, "\n", 1, &written, 0);
}

static char lineBuf[MAX_LINE * 2];

/* Data: printable bytes are quoted (\" and \\ escapes), anything else hex. */
static void append_data(char **p, const char *data, int n) {
    int printable = 1, i;
    for (i = 0; i < n; i++) {
        char c = data[i];
        if (c != '"' && c != '\\' && ((unsigned char)c < 0x20 || (unsigned char)c > 0x7e)) { printable = 0; break; }
    }
    if (printable) {
        out_ch(p, '"');
        for (i = 0; i < n; i++) {
            if (data[i] == '"' || data[i] == '\\') out_ch(p, '\\');
            out_ch(p, data[i]);
        }
        out_ch(p, '"');
    } else {
        out_append(p, "hex:");
        for (i = 0; i < n; i++) {
            static const char hx[] = "0123456789abcdef";
            out_ch(p, hx[((unsigned char)data[i]) >> 4]);
            out_ch(p, hx[((unsigned char)data[i]) & 15]);
        }
    }
}

static void append_addr(char **p, const SOCKADDR_IN *a) {
    unsigned long ip = ntohl(a->sin_addr.s_addr);
    WORD port = ntohs(a->sin_port);
    out_int(p, (long)((ip >> 24) & 255)); out_ch(p, '.');
    out_int(p, (long)((ip >> 16) & 255)); out_ch(p, '.');
    out_int(p, (long)((ip >> 8) & 255)); out_ch(p, '.');
    out_int(p, (long)(ip & 255)); out_ch(p, ':');
    /* symbolic port: the first bound socket symbol carrying this port */
    {
        DWORD i;
        for (i = 0; i < MAX_SYM; i++) {
            if (syms[i].used && syms[i].hasAddr && ntohs(syms[i].addr.sin_port) == port) {
                out_ch(p, '<');
                out_append(p, syms[i].name);
                out_append(p, ">.port");
                return;
            }
        }
    }
    out_int(p, (long)port);
}

/* Every Winsock call is preceded by clear_error(): with a known-zero preset,
 * the error read AFTER the call is deterministic on both sides — a success
 * that leaves a real error behind (truncated recv -> WSAEMSGSIZE) is logged,
 * and a stale error left untouched by a success reads as err=0. */
static void clear_error(void) { WSASetLastError(0); }

static void append_err(char **p, long err) {
    const char *name = errName(err);
    out_append(p, " err=");
    if (err == 0) out_append(p, "0");
    else if (name) out_append(p, name);
    else out_int(p, err);
}

/* Log "<prefix> -> ret=R err=E<suffix>". */
static void log_result_e(const char *prefix, long ret, int ok, long err, const char *suffix) {
    char *p = lineBuf;
    out_append(&p, prefix);
    out_append(&p, " -> ret=");
    out_int(&p, ret);
    append_err(&p, err);
    if (ok && suffix && suffix[0]) out_append(&p, suffix);
    if (!ok) failedCommands++;
    *p = 0;
    log_line(lineBuf);
}
static void log_result(const char *prefix, long ret, int ok, const char *suffix) {
    log_result_e(prefix, ret, ok, (long)WSAGetLastError(), suffix);
}

/* ---------------- symbols ---------------- */

static Sym *sym_find(const char *name, DWORD len) {
    DWORD i;
    if (len >= SYM_NAME) return 0;
    for (i = 0; i < MAX_SYM; i++) {
        if (syms[i].used && wstrlen(syms[i].name) == len && wmemeq(syms[i].name, name, len)) return &syms[i];
    }
    return 0;
}
static Sym *sym_make(const char *name, DWORD len) {
    DWORD i;
    Sym *s = sym_find(name, len);
    if (s) return s;
    if (len >= SYM_NAME) return 0;
    for (i = 0; i < MAX_SYM; i++) {
        if (!syms[i].used) {
            Sym *sym = &syms[i];
            memzero(sym, sizeof(*sym));
            sym->used = 1;
            wcopy(sym->name, name, len);
            sym->name[len] = 0;
            return sym;
        }
    }
    return 0;
}
static Sym *sym_socket(const char *name, DWORD len, SOCKET h) {
    Sym *s = sym_make(name, len);
    if (!s) return 0;
    s->hasHandle = 1;
    s->handle = h;
    return s;
}
static void record_addr(Sym *s) {
    int n = sizeof(SOCKADDR_IN);
    if (getsockname(s->handle, (struct sockaddr *)&s->addr, &n) == 0 && n >= sizeof(SOCKADDR_IN)) s->hasAddr = 1;
}

/* ---------------- script parsing ---------------- */

static char scriptBuf[64 * 1024];
static DWORD scriptLen;

struct Token { const char *start; DWORD len; int isStr; };
static struct Token tokenBuf[MAX_TOKS];
static struct Token *toks;      /* tokenBuf + shift past "[name =]" */
static int ntok;

static void tok_text(struct Token *t, char *out) {
    wcopy(out, t->start, t->len);
    out[t->len] = 0;
}

static int parse_int_text(const char *s, DWORD len, long *out) {
    char tmp[32];
    DWORD i;
    if (len == 0 || len >= sizeof(tmp)) return 0;
    /* <sym>.port — port of a bound socket symbol */
    for (i = 0; i < len; i++) {
        if (s[i] == '.') {
            Sym *base;
            if (i + 5 != len || s[i + 1] != 'p') return 0;
            base = sym_find(s, i);
            if (!base || !base->hasAddr) return 0;
            *out = (long)ntohs(base->addr.sin_port);
            return 1;
        }
    }
    /* symbol: handle value, or port of a bare address symbol */
    {
        Sym *sym = sym_find(s, len);
        if (sym) {
            if (sym->hasHandle) { *out = (long)sym->handle; return 1; }
            if (sym->isAddr) { *out = (long)ntohs(sym->addr.sin_port); return 1; }
            return 0;
        }
    }
    /* named constant */
    {
        char nm[SYM_NAME];
        DWORD k;
        if (len < SYM_NAME) {
            wcopy(nm, s, len); nm[len] = 0;
            for (k = 0; constants[k].name; k++) if (wstreq(nm, constants[k].name)) { *out = constants[k].value; return 1; }
        }
    }
    /* number */
    wcopy(tmp, s, len);
    tmp[len] = 0;
    if (len > 2 && tmp[0] == '0' && (tmp[1] == 'x' || tmp[1] == 'X')) {
        long v = 0;
        DWORD j;
        for (j = 2; j < len; j++) {
            char c = tmp[j];
            long d;
            if (c >= '0' && c <= '9') d = c - '0';
            else if (c >= 'a' && c <= 'f') d = c - 'a' + 10;
            else if (c >= 'A' && c <= 'F') d = c - 'A' + 10;
            else return 0;
            v = v * 16 + d;
        }
        *out = v;
        return 1;
    }
    {
        long v = 0;
        int neg = 0;
        DWORD j = 0;
        if (tmp[0] == '-') { neg = 1; j = 1; }
        if (j >= len) return 0;
        for (; j < len; j++) {
            if (tmp[j] < '0' || tmp[j] > '9') return 0;
            v = v * 10 + (tmp[j] - '0');
        }
        *out = neg ? -v : v;
        return 1;
    }
}
static int parse_int_tok(int idx, long *out) {
    if (idx >= ntok || toks[idx].isStr) return 0;
    return parse_int_text(toks[idx].start, toks[idx].len, out);
}

/* "<sym>" (address symbol) | "<sym>.addr" | "d.d.d.d:<port>" */
static int parse_addr_tok(int idx, SOCKADDR_IN *out) {
    char tmp[MAX_LINE];
    DWORD i, n;
    if (idx >= ntok || toks[idx].isStr || toks[idx].len >= sizeof(tmp)) return 0;
    tok_text(&toks[idx], tmp);
    n = wstrlen(tmp);
    for (i = 0; i < n; i++) if (tmp[i] == ':') break;
    if (i == n) {
        Sym *s;
        if (n > 5 && tmp[n - 5] == '.' && tmp[n - 4] == 'a' && tmp[n - 3] == 'd' && tmp[n - 2] == 'd' && tmp[n - 1] == 'r') {
            s = sym_find(tmp, n - 5);
        } else {
            s = sym_find(tmp, n);
        }
        if (s && (s->isAddr || s->hasAddr)) { *out = s->addr; return 1; }
        return 0;
    }
    {
        unsigned long ip;
        long port = 0;
        tmp[i] = 0;
        ip = inet_addr(tmp);
        if (ip == INADDR_NONE) return 0;
        if (!parse_int_text(tmp + i + 1, n - i - 1, &port)) return 0;
        memzero(out, sizeof(*out));
        out->sin_family = AF_INET;
        out->sin_port = htons((unsigned short)port);
        out->sin_addr.s_addr = ip;
        return 1;
    }
}

/* data token: "str" | u8:v | u32:v | buf:n — returns byte count, -1 on error */
static int parse_data_tok_inline(const struct Token *tok, char *out) {
    char tmp[MAX_LINE];
    DWORD j;
    if (tok->isStr) {
        if (tok->len > 400) return -1;
        wcopy(out, tok->start, tok->len);
        return (int)tok->len;
    }
    if (tok->len >= sizeof(tmp)) return -1;
    tok_text((struct Token *)tok, tmp);
    if (tmp[0] == 'u' && tmp[1] == '8' && tmp[2] == ':') {
        long v;
        if (!parse_int_text(tmp + 3, wstrlen(tmp) - 3, &v)) return -1;
        out[0] = (char)(v & 255);
        return 1;
    }
    if (tmp[0] == 'u' && tmp[1] == '3' && tmp[2] == '2' && tmp[3] == ':') {
        unsigned long u = 0;
        j = 4;
        if (tmp[j] == '0' && (tmp[j + 1] == 'x' || tmp[j + 1] == 'X')) {
            for (j += 2; tmp[j]; j++) {
                char c = tmp[j];
                int d;
                if (c >= '0' && c <= '9') d = c - '0';
                else if (c >= 'a' && c <= 'f') d = c - 'a' + 10;
                else if (c >= 'A' && c <= 'F') d = c - 'A' + 10;
                else return -1;
                u = (u << 4) | (unsigned)d;
            }
        } else {
            for (; tmp[j]; j++) {
                if (tmp[j] < '0' || tmp[j] > '9') return -1;
                u = u * 10 + (unsigned long)(tmp[j] - '0');
            }
        }
        out[0] = (char)(u & 255);
        out[1] = (char)((u >> 8) & 255);
        out[2] = (char)((u >> 16) & 255);
        out[3] = (char)((u >> 24) & 255);
        return 4;
    }
    if (tmp[0] == 'b' && tmp[1] == 'u' && tmp[2] == 'f' && tmp[3] == ':') {
        long n = 0;
        int k;
        for (j = 4; tmp[j]; j++) {
            if (tmp[j] < '0' || tmp[j] > '9') return -1;
            n = n * 10 + (tmp[j] - '0');
        }
        if (n > 400) return -1;
        for (k = 0; k < (int)n; k++) out[k] = 0;
        return (int)n;
    }
    return -1;
}
static int parse_data_tok(int idx, char *out) {
    if (idx >= ntok) return -1;
    return parse_data_tok_inline(&toks[idx], out);
}

/* Canonical "<verb> <args...>" prefix for the log line; strings re-quoted. */
static void build_prefix(char *out) {
    char *p = out;
    char tmp[MAX_LINE];
    int k;
    for (k = 0; k < ntok; k++) {
        if (k) out_ch(&p, ' ');
        if (toks[k].isStr) {
            out_ch(&p, '"');
            wcopy(tmp, toks[k].start, toks[k].len);
            tmp[toks[k].len] = 0;
            out_append(&p, tmp);
            out_ch(&p, '"');
        } else {
            tok_text(&toks[k], tmp);
            out_append(&p, tmp);
        }
    }
    *p = 0;
}

/* ---------------- commands ---------------- */

static char prefixBuf[MAX_LINE * 2];
static char suffixBuf[MAX_LINE];
static char dataBuf[448];
static char dataBuf2[448];
static char tmp2buf[MAX_LINE];

static void err_line(const char *msg) {
    log_line(msg);
    scriptErrors++;
}

static void udp_port_cmd(const char *assigned, int keepOpen) {
    SOCKET s;
    SOCKADDR_IN a;
    Sym *sym;
    int r;
    long err;
    char *p;
    const char *verb = keepOpen ? "udp_open_port" : "udp_closed_port";
    if (!assigned) { err_line("error udp_open_port/udp_closed_port requires assignment"); return; }
    clear_error();
    s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (s == INVALID_SOCKET) { log_result(verb, -1, 0, ""); return; }
    memzero(&a, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    a.sin_port = 0;
    clear_error();
    r = bind(s, (struct sockaddr *)&a, sizeof(a));
    err = (long)WSAGetLastError();
    if (r != 0) { closesocket(s); log_result_e(verb, -1, 0, err, ""); return; }
    sym = sym_socket(assigned, wstrlen(assigned), s);
    if (!sym) { closesocket(s); err_line("error symbol table full"); return; }
    record_addr(sym);
    p = prefixBuf;
    out_append(&p, verb);
    out_append(&p, " -> ret=");
    out_append(&p, assigned);
    append_err(&p, err);
    out_append(&p, " addr=");
    if (sym->hasAddr) append_addr(&p, &sym->addr); else out_append(&p, "?");
    *p = 0;
    log_line(prefixBuf);
    if (!keepOpen) {
        clear_error();
        if (closesocket(s) != 0) log_result("closesocket", -1, 0, "");
        sym->hasHandle = 0;
        sym->isAddr = 1;
    }
}

/* ---------------- role barriers ---------------- */

/* Gate files live next to the log: natively the host coordinator writes them
 * into the run directory; in the emulator the role driver mirrors them into
 * the guest FS via the harness fsWrite verb. Two log lines per gate — the
 * "enter" line is how the coordinator sees the role arrive. */
static char gateDir[MAX_LINE];

static void cmd_gate(const char *name, long timeoutMs) {
    char path[MAX_LINE];
    DWORD start = GetTickCount();
    char *p;
    p = lineBuf;
    out_append(&p, "gate ");
    out_append(&p, name);
    out_append(&p, " enter");
    *p = 0;
    log_line(lineBuf);

    p = path;
    out_append(&p, gateDir);
    out_append(&p, "gate-");
    out_append(&p, name);
    out_append(&p, ".open");
    *p = 0;
    for (;;) {
        if (GetFileAttributesA(path) != INVALID_FILE_ATTRIBUTES) {
            p = lineBuf;
            out_append(&p, "gate ");
            out_append(&p, name);
            out_append(&p, " -> ret=0");
            *p = 0;
            log_line(lineBuf);
            return;
        }
        if (GetTickCount() - start > (DWORD)timeoutMs) {
            p = lineBuf;
            out_append(&p, "gate ");
            out_append(&p, name);
            out_append(&p, " -> ret=-1 timeout");
            *p = 0;
            log_line(lineBuf);
            failedCommands++;
            return;
        }
        Sleep(40);
    }
}

static void run_line(const char *lineStart, DWORD lineLen) {
    const char *s = lineStart;
    DWORD remain = lineLen;
    char assignedName[SYM_NAME];
    const char *assigned = 0;
    char verb[24];
    char tmp[MAX_LINE];

    while (remain && (*s == ' ' || *s == '\t')) { s++; remain--; }
    if (!remain || *s == '#') return;

    /* tokenize; strings become single isStr tokens; bare # ends the line */
    {
        int count = 0;
        while (remain && count < MAX_TOKS) {
            while (remain && (*s == ' ' || *s == '\t')) { s++; remain--; }
            if (!remain || *s == '#') break;
            if (*s == '"') {
                const char *q = s + 1;
                tokenBuf[count].start = q;
                tokenBuf[count].isStr = 1;
                tokenBuf[count].len = 0;
                while (q < s + remain && *q != '"') { q++; tokenBuf[count].len++; }
                count++;
                if (q >= s + remain) { err_line("error unterminated string"); return; }
                remain -= (DWORD)(q + 1 - s);
                s = q + 1;
            } else {
                tokenBuf[count].start = s;
                tokenBuf[count].isStr = 0;
                tokenBuf[count].len = 0;
                while (remain && *s != ' ' && *s != '\t' && *s != '#') {
                    s++;
                    remain--;
                    tokenBuf[count].len++;
                }
                count++;
            }
        }
        toks = tokenBuf;
        ntok = count;
    }
    if (!ntok) return;
    commandsRun++;

    /* [name =] verb ... */
    if (ntok >= 2 && !toks[1].isStr && toks[1].len == 1 && toks[1].start[0] == '=') {
        if (toks[0].isStr || toks[0].len >= SYM_NAME) { err_line("error bad assignment"); return; }
        tok_text(&toks[0], assignedName);
        assigned = assignedName;
        toks += 2;
        ntok -= 2;
    }
    if (!ntok) { err_line("error missing verb"); return; }
    if (toks[0].isStr || toks[0].len >= sizeof(verb)) { err_line("error bad verb"); return; }
    tok_text(&toks[0], verb);

    /* echo — logged as a comment line */
    if (wstreq(verb, "echo")) {
        char *p = lineBuf;
        int k;
        out_append(&p, "#");
        for (k = 1; k < ntok; k++) {
            out_ch(&p, ' ');
            tok_text(&toks[k], tmp);
            out_append(&p, tmp);
        }
        *p = 0;
        log_line(lineBuf);
        return;
    }
    if (wstreq(verb, "sleep")) {
        long ms = 0;
        if (!parse_int_tok(1, &ms) || ms < 0) { err_line("error sleep needs a millisecond value"); return; }
        build_prefix(prefixBuf);
        Sleep((DWORD)ms);
        log_result(prefixBuf, 0, 1, "");
        return;
    }
    if (wstreq(verb, "wsastartup")) {
        long ver = 0, err;
        int r;
        char *p;
        if (!parse_int_tok(1, &ver)) { err_line("error wsastartup needs a version"); return; }
        clear_error();
        r = WSAStartup((WORD)ver, &wsaData);
        err = (long)WSAGetLastError();
        p = prefixBuf;
        out_append(&p, "wsastartup ");
        out_hex(&p, (unsigned long)ver);
        *p = 0;
        if (r == 0) {
            char *q = lineBuf;
            out_append(&q, prefixBuf);
            out_append(&q, " -> ret=0");
            append_err(&q, err);
            out_append(&q, " ver=");
            out_int(&q, LOBYTE(wsaData.wVersion));
            out_ch(&q, '.');
            out_int(&q, HIBYTE(wsaData.wVersion));
            out_append(&q, " high=");
            out_int(&q, LOBYTE(wsaData.wHighVersion));
            out_ch(&q, '.');
            out_int(&q, HIBYTE(wsaData.wHighVersion));
            *q = 0;
            log_line(lineBuf);
        } else {
            log_result_e(prefixBuf, r, 0, err, "");
        }
        return;
    }
    if (wstreq(verb, "wsacleanup")) {
        int r;
        clear_error();
        r = WSACleanup();
        log_result("wsacleanup", r, r == 0, "");
        return;
    }
    if (wstreq(verb, "wsasetlasterror")) {
        long code = 0;
        if (!parse_int_tok(1, &code)) { err_line("error wsasetlasterror needs a code"); return; }
        WSASetLastError((int)code);
        build_prefix(prefixBuf);
        {
            char *p = lineBuf;
            out_append(&p, prefixBuf);
            out_append(&p, " -> ret=0");
            *p = 0;
            log_line(lineBuf);
        }
        return;
    }
    if (wstreq(verb, "socket")) {
        long af = 0, type = 0, proto = 0, err;
        SOCKET h;
        if (!parse_int_tok(1, &af) || !parse_int_tok(2, &type) || !parse_int_tok(3, &proto)) {
            err_line("error socket needs af/type/proto");
            return;
        }
        if (!assigned) { err_line("error socket requires assignment"); return; }
        build_prefix(prefixBuf);
        clear_error();
        h = socket((int)af, (int)type, (int)proto);
        err = (long)WSAGetLastError();
        if (h == INVALID_SOCKET) {
            log_result_e(prefixBuf, -1, 0, err, "");
            return;
        }
        sym_socket(assigned, wstrlen(assigned), h);
        {
            char *p = lineBuf;
            out_append(&p, prefixBuf);
            out_append(&p, " -> ret=");
            out_append(&p, assigned);
            append_err(&p, err);
            *p = 0;
            log_line(lineBuf);
        }
        return;
    }
    if (wstreq(verb, "closesocket")) {
        Sym *sym;
        SOCKET h;
        int r;
        if (ntok < 2 || toks[1].isStr || !(sym = sym_find(toks[1].start, toks[1].len)) || !sym->hasHandle) {
            err_line("error closesocket needs an open socket symbol");
            return;
        }
        h = sym->handle;
        sym->hasHandle = 0;
        build_prefix(prefixBuf);
        clear_error();
        r = closesocket(h);
        log_result(prefixBuf, r, r == 0, "");
        return;
    }
    if (wstreq(verb, "shutdown")) {
        Sym *sym;
        long how = 0;
        int r;
        if (ntok < 3 || !(sym = sym_find(toks[1].start, toks[1].len)) || !sym->hasHandle || !parse_int_tok(2, &how)) {
            err_line("error shutdown needs a socket and a how value");
            return;
        }
        build_prefix(prefixBuf);
        clear_error();
        r = shutdown(sym->handle, (int)how);
        log_result(prefixBuf, r, r == 0, "");
        return;
    }
    if (wstreq(verb, "bind")) {
        Sym *sym;
        SOCKADDR_IN a;
        int r;
        long err;
        char *q;
        if (ntok < 3 || !(sym = sym_find(toks[1].start, toks[1].len)) || !sym->hasHandle || !parse_addr_tok(2, &a)) {
            err_line("error bind needs a socket and an address");
            return;
        }
        build_prefix(prefixBuf);
        clear_error();
        r = bind(sym->handle, (struct sockaddr *)&a, sizeof(a));
        err = (long)WSAGetLastError();
        if (r == 0) record_addr(sym);
        /* suffix carries the post-bind local address */
        q = suffixBuf;
        if (r == 0) {
            out_append(&q, " addr=");
            if (sym->hasAddr) append_addr(&q, &sym->addr); else out_append(&q, "?");
        }
        *q = 0;
        log_result_e(prefixBuf, r, r == 0, err, suffixBuf);
        return;
    }
    if (wstreq(verb, "getsockname") || wstreq(verb, "getpeername")) {
        Sym *sym;
        SOCKADDR_IN a;
        int n = sizeof(a);
        int r;
        long err;
        char *q;
        int isPeer = wstreq(verb, "getpeername");
        if (ntok < 2 || toks[1].isStr || !(sym = sym_find(toks[1].start, toks[1].len)) || !sym->hasHandle) {
            err_line("error name query needs an open socket symbol");
            return;
        }
        memzero(&a, sizeof(a));
        build_prefix(prefixBuf);
        clear_error();
        r = isPeer
            ? getpeername(sym->handle, (struct sockaddr *)&a, &n)
            : getsockname(sym->handle, (struct sockaddr *)&a, &n);
        err = (long)WSAGetLastError();
        q = suffixBuf;
        if (r == 0) {
            out_append(&q, " addr=");
            append_addr(&q, &a);
            if (!isPeer) { sym->addr = a; sym->hasAddr = 1; }
        }
        *q = 0;
        log_result_e(prefixBuf, r, r == 0, err, suffixBuf);
        return;
    }
    if (wstreq(verb, "listen")) {
        Sym *sym;
        long backlog = 0;
        int r;
        if (ntok < 3 || !(sym = sym_find(toks[1].start, toks[1].len)) || !sym->hasHandle || !parse_int_tok(2, &backlog)) {
            err_line("error listen needs a socket and a backlog");
            return;
        }
        build_prefix(prefixBuf);
        clear_error();
        r = listen(sym->handle, (int)backlog);
        log_result(prefixBuf, r, r == 0, "");
        return;
    }
    if (wstreq(verb, "accept")) {
        Sym *sym;
        SOCKADDR_IN from;
        int fromLen = sizeof(from);
        SOCKET h;
        long err;
        char *p, *q;
        if (!assigned) { err_line("error accept requires assignment"); return; }
        if (ntok < 2 || toks[1].isStr || !(sym = sym_find(toks[1].start, toks[1].len)) || !sym->hasHandle) {
            err_line("error accept needs a listening socket symbol");
            return;
        }
        memzero(&from, sizeof(from));
        build_prefix(prefixBuf);
        clear_error();
        h = accept(sym->handle, (struct sockaddr *)&from, &fromLen);
        err = (long)WSAGetLastError();
        if (h == INVALID_SOCKET) { log_result_e(prefixBuf, -1, 0, err, ""); return; }
        sym_socket(assigned, wstrlen(assigned), h);
        q = suffixBuf;
        out_append(&q, " from=");
        append_addr(&q, &from);
        *q = 0;
        p = lineBuf;
        out_append(&p, prefixBuf);
        out_append(&p, " -> ret=");
        out_append(&p, assigned);
        append_err(&p, err);
        out_append(&p, suffixBuf);
        *p = 0;
        log_line(lineBuf);
        return;
    }
    if (wstreq(verb, "connect")) {
        Sym *sym;
        SOCKADDR_IN a;
        int r;
        if (ntok < 3 || !(sym = sym_find(toks[1].start, toks[1].len)) || !sym->hasHandle || !parse_addr_tok(2, &a)) {
            err_line("error connect needs a socket and an address");
            return;
        }
        build_prefix(prefixBuf);
        clear_error();
        r = connect(sym->handle, (struct sockaddr *)&a, sizeof(a));
        log_result(prefixBuf, r, r == 0, "");
        return;
    }
    if (wstreq(verb, "send") || wstreq(verb, "sendto")) {
        Sym *sym;
        SOCKADDR_IN a;
        int n, r, flags = 0;
        int isSendto = wstreq(verb, "sendto");
        if (ntok < 2 || toks[1].isStr || !(sym = sym_find(toks[1].start, toks[1].len)) || !sym->hasHandle) {
            err_line("error send needs an open socket symbol");
            return;
        }
        n = parse_data_tok(isSendto ? 3 : 2, dataBuf);
        if (n < 0) { err_line("error send needs data"); return; }
        if (isSendto && !parse_addr_tok(2, &a)) { err_line("error sendto needs an address"); return; }
        if (!isSendto && ntok >= 4 && !toks[3].isStr) {
            tok_text(&toks[3], tmp);
            if (wstreq(tmp, "peek")) flags = MSG_PEEK;
            else if (wstreq(tmp, "oob")) flags = MSG_OOB;
            else { err_line("error unknown send flag"); return; }
        }
        build_prefix(prefixBuf);
        clear_error();
        r = isSendto
            ? sendto(sym->handle, dataBuf, n, 0, (struct sockaddr *)&a, sizeof(a))
            : send(sym->handle, dataBuf, n, flags);
        log_result(prefixBuf, r, r >= 0, "");
        return;
    }
    if (wstreq(verb, "recv") || wstreq(verb, "recvfrom")) {
        Sym *sym;
        SOCKADDR_IN from;
        int fromLen = sizeof(from);
        long size = 0;
        int r, flags = 0;
        int isRecvfrom = wstreq(verb, "recvfrom");
        if (ntok < 2 || toks[1].isStr || !(sym = sym_find(toks[1].start, toks[1].len)) || !sym->hasHandle || !parse_int_tok(2, &size)) {
            err_line("error recv needs a socket and a buffer size");
            return;
        }
        if (size < 0 || size > (long)sizeof(dataBuf)) { err_line("error recv size out of range"); return; }
        if (ntok > 3 && !toks[3].isStr) {
            tok_text(&toks[3], tmp);
            if (wstreq(tmp, "peek")) flags = MSG_PEEK;
            else if (wstreq(tmp, "oob")) flags = MSG_OOB;
            else { err_line("error unknown recv flag"); return; }
        }
        memzero(&from, sizeof(from));
        build_prefix(prefixBuf);
        clear_error();
        r = isRecvfrom
            ? recvfrom(sym->handle, dataBuf, (int)size, flags, (struct sockaddr *)&from, &fromLen)
            : recv(sym->handle, dataBuf, (int)size, flags);
        if (r >= 0) {
            long err = (long)WSAGetLastError();
            char *q = suffixBuf;
            if (isRecvfrom) { out_append(&q, " from="); append_addr(&q, &from); }
            out_append(&q, " data=");
            append_data(&q, dataBuf, r);
            *q = 0;
            log_result_e(prefixBuf, r, 1, err, suffixBuf);
        } else {
            log_result(prefixBuf, -1, 0, "");
        }
        return;
    }
    if (wstreq(verb, "ioctlsocket")) {
        Sym *sym;
        long cmd = 0;
        unsigned long value = 0;
        int r;
        long err;
        char *q;
        if (ntok < 3 || !(sym = sym_find(toks[1].start, toks[1].len)) || !sym->hasHandle || !parse_int_tok(2, &cmd)) {
            err_line("error ioctlsocket needs a socket and a command");
            return;
        }
        if (cmd != FIONREAD && cmd != SIOCATMARK) {
            int n;
            if (ntok < 4 || (n = parse_data_tok(3, dataBuf)) < 1) { err_line("error ioctlsocket needs an input value"); return; }
            value = (unsigned long)(unsigned char)dataBuf[0]
                  | ((unsigned long)(unsigned char)dataBuf[1] << 8)
                  | ((unsigned long)(unsigned char)dataBuf[2] << 16)
                  | ((unsigned long)(unsigned char)dataBuf[3] << 24);
        }
        build_prefix(prefixBuf);
        clear_error();
        r = ioctlsocket(sym->handle, (long)cmd, &value);
        err = (long)WSAGetLastError();
        q = suffixBuf;
        if (r == 0 && (cmd == FIONREAD || cmd == SIOCATMARK)) { out_append(&q, " out="); out_int(&q, (long)value); }
        *q = 0;
        log_result_e(prefixBuf, r, r == 0, err, suffixBuf);
        return;
    }
    if (wstreq(verb, "wsaioctl")) {
        Sym *sym;
        long cmd = 0, err;
        int inLen = 0, outSize = 0, r;
        char outBuf[64];
        DWORD bytesReturned = 0;
        char *q;
        int k;
        if (ntok < 3 || !(sym = sym_find(toks[1].start, toks[1].len)) || !sym->hasHandle || !parse_int_tok(2, &cmd)) {
            err_line("error wsaioctl needs a socket and a command");
            return;
        }
        for (k = 3; k < ntok; k++) {
            char arg[MAX_LINE];
            if (toks[k].isStr) { err_line("error bad wsaioctl argument"); return; }
            tok_text(&toks[k], arg);
            if (arg[0] == 'i' && arg[1] == 'n' && arg[2] == '=') {
                struct Token t = toks[k];
                t.start += 3;
                t.len -= 3;
                t.isStr = 0;
                inLen = parse_data_tok_inline(&t, dataBuf2);
                if (inLen < 0) { err_line("error bad wsaioctl input"); return; }
            } else if (arg[0] == 'o' && arg[1] == 'u' && arg[2] == 't' && arg[3] == '=') {
                long v;
                if (!parse_int_text(arg + 4, wstrlen(arg) - 4, &v) || v < 0 || v > (long)sizeof(outBuf)) {
                    err_line("error bad wsaioctl out size");
                    return;
                }
                outSize = (int)v;
            } else {
                err_line("error unknown wsaioctl argument");
                return;
            }
        }
        build_prefix(prefixBuf);
        clear_error();
        r = WSAIoctl(sym->handle, (DWORD)cmd,
                     inLen ? (void *)dataBuf2 : 0, (DWORD)inLen,
                     outSize ? (void *)outBuf : 0, (DWORD)outSize,
                     &bytesReturned, 0, 0);
        err = (long)WSAGetLastError();
        q = suffixBuf;
        if (r == 0 && outSize) {
            out_append(&q, " bytes=");
            out_int(&q, (long)bytesReturned);
            out_append(&q, " out=");
            append_data(&q, outBuf, bytesReturned > (DWORD)outSize ? outSize : (int)bytesReturned);
        }
        *q = 0;
        log_result_e(prefixBuf, r, r == 0, err, suffixBuf);
        return;
    }
    if (wstreq(verb, "setsockopt")) {
        Sym *sym;
        long level = 0, opt = 0;
        int n, r;
        if (ntok < 5 || !(sym = sym_find(toks[1].start, toks[1].len)) || !sym->hasHandle
            || !parse_int_tok(2, &level) || !parse_int_tok(3, &opt)
            || (n = parse_data_tok(4, dataBuf)) < 0) {
            err_line("error setsockopt needs socket/level/opt/value");
            return;
        }
        build_prefix(prefixBuf);
        clear_error();
        r = setsockopt(sym->handle, (int)level, (int)opt, dataBuf, n);
        log_result(prefixBuf, r, r == 0, "");
        return;
    }
    if (wstreq(verb, "getsockopt")) {
        Sym *sym;
        long level = 0, opt = 0, size = 0, err;
        char outBuf[64];
        int n = 0, r;
        char *q;
        if (ntok < 5 || !(sym = sym_find(toks[1].start, toks[1].len)) || !sym->hasHandle
            || !parse_int_tok(2, &level) || !parse_int_tok(3, &opt) || !parse_int_tok(4, &size)
            || size < 0 || size > (long)sizeof(outBuf)) {
            err_line("error getsockopt needs socket/level/opt/size");
            return;
        }
        n = (int)size;
        memzero(outBuf, sizeof(outBuf));
        build_prefix(prefixBuf);
        clear_error();
        r = getsockopt(sym->handle, (int)level, (int)opt, outBuf, &n);
        err = (long)WSAGetLastError();
        q = suffixBuf;
        if (r == 0) {
            out_append(&q, " out=");
            if (n == 4) {
                long v = (long)((unsigned long)(unsigned char)outBuf[0]
                    | ((unsigned long)(unsigned char)outBuf[1] << 8)
                    | ((unsigned long)(unsigned char)outBuf[2] << 16)
                    | ((unsigned long)(unsigned char)outBuf[3] << 24));
                const char *name = constName(v);
                if (name) out_append(&q, name); else out_int(&q, v);
            } else {
                append_data(&q, outBuf, n);
            }
        }
        *q = 0;
        log_result_e(prefixBuf, r, r == 0, err, suffixBuf);
        return;
    }
    if (wstreq(verb, "select")) {
        fd_set rd, wr, ex;
        struct timeval tv;
        char rdNames[SEL_MAX][SYM_NAME], wrNames[SEL_MAX][SYM_NAME], exNames[SEL_MAX][SYM_NAME];
        SOCKET rdS[SEL_MAX], wrS[SEL_MAX], exS[SEL_MAX];
        int rdN = 0, wrN = 0, exN = 0;
        int hasTimeout = 0;
        long ms = -1;
        int r, k;
        char *p;
        FD_ZERO(&rd); FD_ZERO(&wr); FD_ZERO(&ex);
        for (k = 1; k < ntok; k++) {
            char arg[MAX_LINE];
            Sym *sym;
            if (toks[k].isStr || toks[k].len < 3) { err_line("error bad select argument"); return; }
            tok_text(&toks[k], arg);
            if (arg[0] == 't' && arg[1] == '=') {
                if (!parse_int_text(arg + 2, wstrlen(arg) - 2, &ms)) { err_line("error bad select timeout"); return; }
                hasTimeout = 1;
                continue;
            }
            {
                char set = arg[0];
                const char *names = arg + 2;
                DWORD nlen = wstrlen(arg) - 2;
                DWORD start = 0, i;
                int target = set == 'r' ? 0 : set == 'w' ? 1 : set == 'e' ? 2 : -1;
                if (target < 0 || arg[1] != '=') { err_line("error bad select set"); return; }
                for (i = 0; i <= nlen; i++) {
                    if (i == nlen || names[i] == ',') {
                        SOCKET h;
                        DWORD len = i - start;
                        char nm[SYM_NAME];
                        if (len == 0 || len >= SYM_NAME) { err_line("error bad select socket name"); return; }
                        wcopy(nm, names + start, len);
                        nm[len] = 0;
                        sym = sym_find(nm, len);
                        if (!sym || !sym->hasHandle) { err_line("error select socket not open"); return; }
                        h = sym->handle;
                        if (target == 0 && rdN < SEL_MAX) { FD_SET(h, &rd); rdS[rdN] = h; wcopy(rdNames[rdN], nm, len + 1); rdN++; }
                        if (target == 1 && wrN < SEL_MAX) { FD_SET(h, &wr); wrS[wrN] = h; wcopy(wrNames[wrN], nm, len + 1); wrN++; }
                        if (target == 2 && exN < SEL_MAX) { FD_SET(h, &ex); exS[exN] = h; wcopy(exNames[exN], nm, len + 1); exN++; }
                        start = i + 1;
                    }
                }
            }
        }
        build_prefix(prefixBuf);
        clear_error();
        if (hasTimeout && ms >= 0) {
            tv.tv_sec = (long)(ms / 1000);
            tv.tv_usec = (long)(ms % 1000) * 1000;
            r = select(0, &rd, wrN ? &wr : 0, exN ? &ex : 0, &tv);
        } else {
            r = select(0, &rd, wrN ? &wr : 0, exN ? &ex : 0, 0);
        }
        p = lineBuf;
        out_append(&p, prefixBuf);
        out_append(&p, " -> ret=");
        out_int(&p, r);
        if (r >= 0) {
            out_append(&p, " err=0");
            if (rdN) {
                int hit = 0, first = 1;
                for (k = 0; k < rdN; k++) if (FD_ISSET(rdS[k], &rd)) hit++;
                if (hit) {
                    out_append(&p, " rd=");
                    for (k = 0; k < rdN; k++) if (FD_ISSET(rdS[k], &rd)) {
                        if (!first) out_ch(&p, ',');
                        out_append(&p, rdNames[k]);
                        first = 0;
                    }
                }
            }
            if (wrN) {
                int hit = 0, first = 1;
                for (k = 0; k < wrN; k++) if (FD_ISSET(wrS[k], &wr)) hit++;
                if (hit) {
                    out_append(&p, " wr=");
                    for (k = 0; k < wrN; k++) if (FD_ISSET(wrS[k], &wr)) {
                        if (!first) out_ch(&p, ',');
                        out_append(&p, wrNames[k]);
                        first = 0;
                    }
                }
            }
            if (exN) {
                int hit = 0, first = 1;
                for (k = 0; k < exN; k++) if (FD_ISSET(exS[k], &ex)) hit++;
                if (hit) {
                    out_append(&p, " ex=");
                    for (k = 0; k < exN; k++) if (FD_ISSET(exS[k], &ex)) {
                        if (!first) out_ch(&p, ',');
                        out_append(&p, exNames[k]);
                        first = 0;
                    }
                }
            }
        } else {
            const char *name = errName((long)WSAGetLastError());
            out_append(&p, " err=");
            if (name) out_append(&p, name); else out_int(&p, (long)WSAGetLastError());
            failedCommands++;
        }
        *p = 0;
        log_line(lineBuf);
        return;
    }
    if (wstreq(verb, "udp_open_port") || wstreq(verb, "udp_closed_port")) {
        udp_port_cmd(assigned, wstreq(verb, "udp_open_port"));
        return;
    }
    if (wstreq(verb, "gate")) {
        long ms = 30000;
        if (ntok < 2 || toks[1].isStr || toks[1].len >= SYM_NAME) { err_line("error gate needs a name"); return; }
        tok_text(&toks[1], tmp);
        if (ntok >= 3 && !toks[2].isStr) {
            tok_text(&toks[2], tmp2buf);
            if (tmp2buf[0] == 't' && tmp2buf[1] == '=') {
                if (!parse_int_text(tmp2buf + 2, wstrlen(tmp2buf) - 2, &ms)) { err_line("error bad gate timeout"); return; }
            } else { err_line("error unknown gate argument"); return; }
        }
        cmd_gate(tmp, ms);
        return;
    }

    /* unknown */
    {
        char *p = lineBuf;
        out_append(&p, "error unknown verb ");
        out_append(&p, verb);
        *p = 0;
        log_line(lineBuf);
        scriptErrors++;
    }
}

/* ---------------- entry ---------------- */

static char *next_arg(char **pp) {
    char *p = *pp;
    char *start;
    while (*p == ' ' || *p == '\t') p++;
    if (*p == '"') {
        start = ++p;
        while (*p && *p != '"') p++;
    } else {
        start = p;
        while (*p && *p != ' ' && *p != '\t') p++;
    }
    if (*p) { *p = 0; p++; }
    *pp = p;
    return start;
}

static LONG WINAPI crash_filter(EXCEPTION_POINTERS *ep) {
    if (logHandle != INVALID_HANDLE_VALUE) {
        char *p = lineBuf;
        out_append(&p, "crash ");
        out_hex(&p, (unsigned long)ep->ExceptionRecord->ExceptionCode);
        *p = 0;
        log_line(lineBuf);
    }
    ExitProcess(108);
    return EXCEPTION_EXECUTE_HANDLER;
}

static DWORD WINAPI watchdog(LPVOID arg) {
    (void)arg;
    Sleep(120000);
    ExitProcess(90);
    return 0;
}

void entry(void) {
    char *cmd = GetCommandLineA();
    char *scriptPath, *logPath;
    HANDLE file;
    DWORD read = 0, size;
    char *p, *end;

    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    SetUnhandledExceptionFilter(crash_filter);
    CreateThread(0, 0, watchdog, 0, 0, 0);

    next_arg(&cmd);                 /* program name */
    scriptPath = next_arg(&cmd);
    logPath = next_arg(&cmd);
    if (!*scriptPath || !*logPath) ExitProcess(3);

    file = CreateFileA(scriptPath, GENERIC_READ, FILE_SHARE_READ, 0, OPEN_EXISTING, 0, 0);
    if (file == INVALID_HANDLE_VALUE) ExitProcess(3);
    size = GetFileSize(file, 0);
    if (size == INVALID_FILE_SIZE || size > sizeof(scriptBuf) - 1) { CloseHandle(file); ExitProcess(3); }
    if (!ReadFile(file, scriptBuf, size, &read, 0) || read != size) { CloseHandle(file); ExitProcess(3); }
    CloseHandle(file);
    scriptLen = read;

    /* share-read: the multi-role coordinator tails the log while we run */
    logHandle = CreateFileA(logPath, GENERIC_WRITE, FILE_SHARE_READ, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (logHandle == INVALID_HANDLE_VALUE) ExitProcess(3);

    /* gate files are looked up next to the log */
    {
        char *cut = logPath + wstrlen(logPath);
        while (cut > logPath && *cut != '\\' && *cut != '/') cut--;
        if (cut > logPath) {
            wcopy(gateDir, logPath, (DWORD)(cut - logPath + 1));
            gateDir[cut - logPath + 1] = 0;
        } else {
            gateDir[0] = 0;
        }
    }

    p = scriptBuf;
    end = scriptBuf + scriptLen;
    while (p < end) {
        char *nl = p;
        DWORD len;
        while (nl < end && *nl != '\n') nl++;
        len = (DWORD)(nl - p);
        if (len && p[len - 1] == '\r') len--;
        if (len < MAX_LINE) run_line(p, len);
        else { log_line("error line too long"); scriptErrors++; }
        p = nl < end ? nl + 1 : end;
    }

    {
        char *o = lineBuf;
        out_append(&o, "exit ");
        out_int(&o, scriptErrors ? 2 : 0);
        *o = 0;
        log_line(lineBuf);
    }
    CloseHandle(logHandle);
    ExitProcess(scriptErrors ? 2 : 0);
}
