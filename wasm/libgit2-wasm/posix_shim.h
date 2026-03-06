// POSIX shim for wasm32-freestanding
// Maps filesystem operations to host imports (R2/KV via TypeScript)

#ifndef GITMODE_POSIX_SHIM_H
#define GITMODE_POSIX_SHIM_H

#include <stddef.h>
#include <stdint.h>

// File descriptor table — maps fd numbers to R2 keys
#define GITMODE_MAX_FDS 256

// Host imports (provided by TypeScript Worker)
extern int32_t __gitmode_fs_open(const char *path, int flags, int mode);
extern int32_t __gitmode_fs_read(int fd, void *buf, size_t count);
extern int32_t __gitmode_fs_write(int fd, const void *buf, size_t count);
extern int32_t __gitmode_fs_close(int fd);
extern int32_t __gitmode_fs_stat(const char *path, uint32_t *size_out);
extern int32_t __gitmode_fs_mkdir(const char *path, int mode);
extern int32_t __gitmode_fs_unlink(const char *path);
extern int32_t __gitmode_fs_rename(const char *old, const char *new_);
extern int32_t __gitmode_fs_readdir_start(const char *path);
extern int32_t __gitmode_fs_readdir_next(int handle, char *name_buf, size_t buf_len);
extern void    __gitmode_fs_readdir_end(int handle);
extern void    __gitmode_log(const char *msg, size_t len);

#endif
