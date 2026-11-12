/* flat-pair mini libc: the ONE C library every arm of the Lua workload is built against
 * (MSVC freestanding PE, Emscripten, native). Same headers, same implementations, so the
 * library code is part of the paired work rather than a per-platform difference.
 * Only what Lua 5.4 core + base/string/table/math libraries reference. */
#ifndef BSLIBC_H
#define BSLIBC_H

#if defined(__clang__) || defined(__GNUC__)
typedef __SIZE_TYPE__ size_t;
typedef __PTRDIFF_TYPE__ ptrdiff_t;
typedef __builtin_va_list va_list;
#define va_start(ap, v) __builtin_va_start(ap, v)
#define va_arg(ap, t) __builtin_va_arg(ap, t)
#define va_end(ap) __builtin_va_end(ap)
#define va_copy(d, s) __builtin_va_copy(d, s)
#define offsetof(t, m) __builtin_offsetof(t, m)
#define HUGE_VAL (__builtin_huge_val())
#else
typedef unsigned int size_t;
typedef int ptrdiff_t;
typedef char* va_list;
#define BS_VA_SZ(t) ((sizeof(t) + 3) & ~3)
#define va_start(ap, v) ((ap) = (va_list)&(v) + BS_VA_SZ(v))
#define va_arg(ap, t) (*(t*)(((ap) += BS_VA_SZ(t)) - BS_VA_SZ(t)))
#define va_end(ap) ((ap) = (va_list)0)
#define va_copy(d, s) ((d) = (s))
#define offsetof(t, m) ((size_t)&(((t*)0)->m))
extern const unsigned int bs_huge_bits[2];
#define HUGE_VAL (*(const double*)bs_huge_bits)
#endif
typedef int wchar_t_bs;
#ifndef NULL
#define NULL ((void*)0)
#endif

/* limits.h */
#define CHAR_BIT 8
#define SCHAR_MIN (-128)
#define SCHAR_MAX 127
#define UCHAR_MAX 255
#define CHAR_MIN SCHAR_MIN
#define CHAR_MAX SCHAR_MAX
#define SHRT_MIN (-32768)
#define SHRT_MAX 32767
#define USHRT_MAX 65535
#define INT_MIN (-2147483647 - 1)
#define INT_MAX 2147483647
#define UINT_MAX 4294967295u
#define LONG_MIN (-2147483647L - 1)
#define LONG_MAX 2147483647L
#define ULONG_MAX 4294967295uL
#define LLONG_MAX 9223372036854775807LL
#define LLONG_MIN (-LLONG_MAX - 1)
#define ULLONG_MAX 18446744073709551615uLL
#define MB_LEN_MAX 5

/* float.h */
#define FLT_RADIX 2
#define FLT_MANT_DIG 24
#define FLT_DIG 6
#define FLT_EPSILON 1.19209290e-7F
#define FLT_MAX 3.40282347e+38F
#define FLT_MIN 1.17549435e-38F
#define DBL_MANT_DIG 53
#define DBL_DIG 15
#define DBL_EPSILON 2.2204460492503131e-16
#define DBL_MAX 1.7976931348623157e+308
#define DBL_MIN 2.2250738585072014e-308
#define DBL_MAX_EXP 1024
#define DBL_MIN_EXP (-1021)
#define DBL_MAX_10_EXP 308
#define LDBL_MANT_DIG DBL_MANT_DIG
#define LDBL_DIG DBL_DIG
#define LDBL_EPSILON DBL_EPSILON
#define LDBL_MAX DBL_MAX
#define LDBL_MIN DBL_MIN

#ifdef __cplusplus
extern "C" {
#endif
/* string.h */
void* memcpy(void* d, const void* s, size_t n);
void* memmove(void* d, const void* s, size_t n);
void* memset(void* d, int c, size_t n);
int memcmp(const void* a, const void* b, size_t n);
void* memchr(const void* s, int c, size_t n);
size_t strlen(const char* s);
int strcmp(const char* a, const char* b);
int strncmp(const char* a, const char* b, size_t n);
int strcoll(const char* a, const char* b);
char* strchr(const char* s, int c);
char* strrchr(const char* s, int c);
size_t strspn(const char* s, const char* set);
size_t strcspn(const char* s, const char* set);
char* strpbrk(const char* s, const char* set);
char* strstr(const char* h, const char* n);
char* strcpy(char* d, const char* s);
char* strncpy(char* d, const char* s, size_t n);
char* strcat(char* d, const char* s);
char* strerror(int e);

/* ctype.h */
int isalpha(int c); int isdigit(int c); int isalnum(int c); int isspace(int c);
int isupper(int c); int islower(int c); int ispunct(int c); int isxdigit(int c);
int iscntrl(int c); int isgraph(int c); int isprint(int c);
int tolower(int c); int toupper(int c);

/* stdlib.h */
#define EXIT_SUCCESS 0
#define EXIT_FAILURE 1
#define RAND_MAX 0x7fff
void* malloc(size_t n);
void* calloc(size_t n, size_t m);
void* realloc(void* p, size_t n);
void free(void* p);
void abort(void);
void exit(int code);
double strtod(const char* s, char** end);
long strtol(const char* s, char** end, int base);
unsigned long strtoul(const char* s, char** end, int base);
char* getenv(const char* n);
int abs(int x);
long labs(long x);
int rand(void);
void srand(unsigned s);
int system(const char* c);

/* stdio.h */
typedef struct bs_FILE { int id; } FILE;
#define EOF (-1)
#define BUFSIZ 512
#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2
extern FILE* stdin;
extern FILE* stdout;
extern FILE* stderr;
FILE* fopen(const char* n, const char* m);
FILE* freopen(const char* n, const char* m, FILE* f);
int fclose(FILE* f);
size_t fread(void* p, size_t s, size_t n, FILE* f);
size_t fwrite(const void* p, size_t s, size_t n, FILE* f);
int getc(FILE* f);
int ungetc(int c, FILE* f);
char* fgets(char* s, int n, FILE* f);
int fputs(const char* s, FILE* f);
int fputc(int c, FILE* f);
int fflush(FILE* f);
int ferror(FILE* f);
int feof(FILE* f);
void clearerr(FILE* f);
int printf(const char* f, ...);
int fprintf(FILE* fp, const char* f, ...);
int sprintf(char* s, const char* f, ...);
int snprintf(char* s, size_t n, const char* f, ...);
int vsnprintf(char* s, size_t n, const char* f, va_list ap);
int vfprintf(FILE* fp, const char* f, va_list ap);

/* math.h */
double floor(double x); double ceil(double x); double fabs(double x); double fmod(double x, double y);
double sqrt(double x); double pow(double x, double y); double exp(double x); double log(double x);
double log2(double x); double log10(double x); double sin(double x); double cos(double x); double tan(double x);
double asin(double x); double acos(double x); double atan(double x); double atan2(double y, double x);
double frexp(double x, int* e); double ldexp(double x, int e); double modf(double x, double* ip);

/* setjmp.h (Lua's LUAI_TRY/THROW are overridden in bs_luacfg.h; only the type is needed) */
typedef int jmp_buf[16];

/* time.h */
typedef long time_t;
typedef long clock_t;
#define CLOCKS_PER_SEC 1000
time_t time(time_t* t);
clock_t clock(void);

/* locale.h */
struct lconv { char* decimal_point; };
struct lconv* localeconv(void);
char* setlocale(int c, const char* l);
#define LC_ALL 0
#define LC_NUMERIC 4

/* errno.h */
extern int errno;
#define EINVAL 22
#define ERANGE 34

/* the hash of everything Lua printed */
extern unsigned int bs_print_hash;
extern unsigned int bs_print_bytes;
#ifdef __cplusplus
}
#endif
#endif
