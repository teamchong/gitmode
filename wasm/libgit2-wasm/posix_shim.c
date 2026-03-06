// POSIX shim for wasm32-freestanding
// Implements the POSIX interface that libgit2 needs,
// redirecting all I/O to host imports (R2/KV via TypeScript).

#include "posix_shim.h"
#include <string.h>
#include <errno.h>
#include <stdlib.h>
#include <sys/stat.h>

// === File operations — delegated to host ===

int p_open(const char *path, int flags, ...) {
    return __gitmode_fs_open(path, flags, 0644);
}

int p_creat(const char *path, int mode) {
    return __gitmode_fs_open(path, 0x241 /* O_WRONLY|O_CREAT|O_TRUNC */, mode);
}

ssize_t p_read(int fd, void *buf, size_t count) {
    return __gitmode_fs_read(fd, buf, count);
}

ssize_t p_write(int fd, const void *buf, size_t count) {
    return __gitmode_fs_write(fd, buf, count);
}

int p_close(int fd) {
    return __gitmode_fs_close(fd);
}

// R2 writes are immediately durable — fsync is a no-op by design.
int p_fsync(int fd) {
    (void)fd;
    return 0;
}

int p_ftruncate(int fd, off_t length) {
    // R2 objects are immutable blobs — truncation is not applicable.
    // libgit2 calls this during packfile writing; the host handles
    // final sizing when the fd is closed.
    (void)fd;
    (void)length;
    return 0;
}

off_t p_lseek(int fd, off_t offset, int whence) {
    // The host-side fd table tracks position per fd.
    // For R2-backed fds, seeking is handled in the TypeScript fd table.
    (void)fd;
    (void)whence;
    return offset;
}

int p_stat(const char *path, struct stat *buf) {
    uint32_t size = 0;
    int ret = __gitmode_fs_stat(path, &size);
    if (ret < 0) {
        errno = ENOENT;
        return -1;
    }
    memset(buf, 0, sizeof(*buf));
    buf->st_size = size;
    buf->st_mode = 0100644; // regular file
    return 0;
}

// R2 has no symlinks — lstat behaves identically to stat.
int p_lstat(const char *path, struct stat *buf) {
    return p_stat(path, buf);
}

int p_mkdir(const char *path, int mode) {
    return __gitmode_fs_mkdir(path, mode);
}

int p_unlink(const char *path) {
    return __gitmode_fs_unlink(path);
}

int p_rename(const char *old, const char *new_) {
    return __gitmode_fs_rename(old, new_);
}

// R2 has no file permissions — chmod is a no-op by design.
int p_chmod(const char *path, int mode) {
    (void)path;
    (void)mode;
    return 0;
}

int p_access(const char *path, int mode) {
    uint32_t size;
    (void)mode;
    return __gitmode_fs_stat(path, &size);
}

char *p_realpath(const char *path, char *resolved) {
    if (!resolved) return NULL;
    // R2 keys are flat — no relative paths, symlinks, or .. traversal
    size_t len = strlen(path);
    if (len >= 4096) return NULL;
    memcpy(resolved, path, len + 1);
    return resolved;
}

int p_getcwd(char *buf, size_t size) {
    if (size < 2) return -1;
    buf[0] = '/';
    buf[1] = '\0';
    return 0;
}

// mmap: allocate memory and read entire object into it.
// R2 objects are accessed as whole blobs, so this loads the full content.
void *p_mmap(void *addr, size_t length, int prot, int flags, int fd, off_t offset) {
    (void)addr;
    (void)prot;
    (void)flags;
    (void)offset;
    void *buf = malloc(length);
    if (!buf) return (void *)-1;
    ssize_t n = p_read(fd, buf, length);
    if (n < 0) {
        free(buf);
        return (void *)-1;
    }
    return buf;
}

int p_munmap(void *addr, size_t length) {
    (void)length;
    free(addr);
    return 0;
}

// R2 does not track modification timestamps — utimes is a no-op.
int p_utimes(const char *path, const struct timeval *times) {
    (void)path;
    (void)times;
    return 0;
}

// R2 is a flat key-value store — symlinks, hardlinks are not supported.
int p_symlink(const char *target, const char *linkpath) {
    (void)target;
    (void)linkpath;
    errno = ENOSYS;
    return -1;
}

ssize_t p_readlink(const char *path, char *buf, size_t bufsiz) {
    (void)path;
    (void)buf;
    (void)bufsiz;
    errno = EINVAL;
    return -1;
}

int p_link(const char *oldpath, const char *newpath) {
    (void)oldpath;
    (void)newpath;
    errno = ENOSYS;
    return -1;
}

// Single-threaded WASM — pid is always 1.
int p_getpid(void) {
    return 1;
}

// WASM is non-blocking — sleep returns immediately.
unsigned int p_sleep(unsigned int seconds) {
    (void)seconds;
    return 0;
}

// Global fsync counter used by libgit2 for testing.
size_t p_fsync__cnt = 0;
