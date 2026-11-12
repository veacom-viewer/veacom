// Counts the regular files a process opens and the bytes it reads from them, for files under the folders named in
// IOCOUNT_ROOTS (':'-separated, canonical paths). Loaded into the engine by tools/check-open-speed.cjs with
// LD_PRELOAD (Linux) or DYLD_INSERT_LIBRARIES (macOS); never part of the app. On SIGUSR1 it writes
// { sequence, files opened, read calls, bytes read } as four little-endian uint64 to the start of IOCOUNT_FILE, and
// again when the process exits.
// Linux: cc -O2 -shared -fPIC -o io-count.so io-count.c -ldl      macOS: cc -O2 -dynamiclib -o io-count.dylib io-count.c
#undef _FORTIFY_SOURCE // the C library's checked inline read/open wrappers would clash with the definitions below
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <unistd.h>

static _Atomic uint64_t sequence, opened, calls, bytes;
static char roots[8][PATH_MAX];
static size_t root_count;
static int out = -1;

static int fd_path(int fd, char *buffer) {
#ifdef __APPLE__
  return fcntl(fd, F_GETPATH, buffer) == 0 ? 0 : -1;
#else
  char link[64];
  snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
  ssize_t n = readlink(link, buffer, PATH_MAX - 1);
  if (n < 0) return -1;
  buffer[n] = 0;
  return 0;
#endif
}

// A regular file under one of the roots.
static int watched(int fd) {
  struct stat st;
  char path[PATH_MAX];
  if (!root_count || fd < 0 || fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || fd_path(fd, path) != 0) return 0;
  for (size_t i = 0; i < root_count; i++) {
    size_t n = strlen(roots[i]);
    if (strncmp(path, roots[i], n) == 0 && (path[n] == '/' || path[n] == 0)) return 1;
  }
  return 0;
}
static void counted_open(int fd) { if (watched(fd)) opened++; }
static void counted_read(int fd, ssize_t n) { if (n > 0 && watched(fd)) { calls++; bytes += (uint64_t)n; } }

static void dump(int signal_number) {
  (void)signal_number;
  uint64_t record[4] = { ++sequence, opened, calls, bytes }; // little-endian on every supported machine
  if (out >= 0) (void)!pwrite(out, record, sizeof record, 0);
}

#ifdef __APPLE__
// macOS: dyld's interpose section replaces the calls in every other image.
#define INTERPOSE(replacement, replacee) \
  __attribute__((used)) static struct { const void *a; const void *b; } interpose_##replacee \
  __attribute__((section("__DATA,__interpose"))) = { (const void *)&replacement, (const void *)&replacee };
static int my_open(const char *path, int flags, ...) {
  int mode = 0;
  if (flags & O_CREAT) { va_list ap; va_start(ap, flags); mode = va_arg(ap, int); va_end(ap); }
  int fd = open(path, flags, mode); counted_open(fd); return fd;
}
static int my_openat(int dir, const char *path, int flags, ...) {
  int mode = 0;
  if (flags & O_CREAT) { va_list ap; va_start(ap, flags); mode = va_arg(ap, int); va_end(ap); }
  int fd = openat(dir, path, flags, mode); counted_open(fd); return fd;
}
static ssize_t my_read(int fd, void *buf, size_t n) { ssize_t r = read(fd, buf, n); counted_read(fd, r); return r; }
static ssize_t my_pread(int fd, void *buf, size_t n, off_t at) { ssize_t r = pread(fd, buf, n, at); counted_read(fd, r); return r; }
static ssize_t my_readv(int fd, const struct iovec *v, int c) { ssize_t r = readv(fd, v, c); counted_read(fd, r); return r; }
INTERPOSE(my_open, open)
INTERPOSE(my_openat, openat)
INTERPOSE(my_read, read)
INTERPOSE(my_pread, pread)
INTERPOSE(my_readv, readv)
static int real_open_for_output(const char *path) { return open(path, O_WRONLY | O_CREAT | O_CLOEXEC, 0600); }
#else
// Linux: LD_PRELOAD puts these definitions ahead of the C library's; dlsym(RTLD_NEXT) finds the originals.
#define REAL(name) static __typeof__(name) *real_##name; if (!real_##name) real_##name = (__typeof__(name) *)dlsym(RTLD_NEXT, #name)
#ifndef __O_TMPFILE
#define __O_TMPFILE 0
#endif
static int mode_of(int flags, va_list ap) { return (flags & O_CREAT) || (__O_TMPFILE && (flags & __O_TMPFILE) == __O_TMPFILE) ? va_arg(ap, int) : 0; }
int open(const char *path, int flags, ...) { REAL(open); va_list ap; va_start(ap, flags); int mode = mode_of(flags, ap); va_end(ap); int fd = real_open(path, flags, mode); counted_open(fd); return fd; }
int open64(const char *path, int flags, ...) { REAL(open64); va_list ap; va_start(ap, flags); int mode = mode_of(flags, ap); va_end(ap); int fd = real_open64(path, flags, mode); counted_open(fd); return fd; }
int openat(int dir, const char *path, int flags, ...) { REAL(openat); va_list ap; va_start(ap, flags); int mode = mode_of(flags, ap); va_end(ap); int fd = real_openat(dir, path, flags, mode); counted_open(fd); return fd; }
int openat64(int dir, const char *path, int flags, ...) { REAL(openat64); va_list ap; va_start(ap, flags); int mode = mode_of(flags, ap); va_end(ap); int fd = real_openat64(dir, path, flags, mode); counted_open(fd); return fd; }
ssize_t read(int fd, void *buf, size_t n) { REAL(read); ssize_t r = real_read(fd, buf, n); counted_read(fd, r); return r; }
ssize_t pread(int fd, void *buf, size_t n, off_t at) { REAL(pread); ssize_t r = real_pread(fd, buf, n, at); counted_read(fd, r); return r; }
ssize_t pread64(int fd, void *buf, size_t n, off64_t at) { REAL(pread64); ssize_t r = real_pread64(fd, buf, n, at); counted_read(fd, r); return r; }
ssize_t readv(int fd, const struct iovec *v, int c) { REAL(readv); ssize_t r = real_readv(fd, v, c); counted_read(fd, r); return r; }
ssize_t preadv(int fd, const struct iovec *v, int c, off_t at) { REAL(preadv); ssize_t r = real_preadv(fd, v, c, at); counted_read(fd, r); return r; }
ssize_t preadv64(int fd, const struct iovec *v, int c, off64_t at) { REAL(preadv64); ssize_t r = real_preadv64(fd, v, c, at); counted_read(fd, r); return r; }
static int real_open_for_output(const char *path) { REAL(open); return real_open(path, O_WRONLY | O_CREAT | O_CLOEXEC, 0600); }
#endif

__attribute__((constructor)) static void start(void) {
  const char *list = getenv("IOCOUNT_ROOTS"), *file = getenv("IOCOUNT_FILE");
  if (!list || !file) return;
  for (const char *at = list; *at && root_count < 8;) {
    const char *end = strchr(at, ':');
    size_t n = end ? (size_t)(end - at) : strlen(at);
    if (n && n < PATH_MAX) { memcpy(roots[root_count], at, n); roots[root_count][n] = 0; root_count++; }
    at += n + (end ? 1 : 0);
  }
  out = real_open_for_output(file);
  struct sigaction action;
  memset(&action, 0, sizeof action);
  action.sa_handler = dump;
  action.sa_flags = SA_RESTART;
  sigemptyset(&action.sa_mask);
  sigaction(SIGUSR1, &action, NULL);
}
__attribute__((destructor)) static void finish(void) { dump(0); }
