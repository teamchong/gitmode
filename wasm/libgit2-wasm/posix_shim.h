// POSIX shim for wasm32-wasi
// Maps filesystem operations to host imports (R2/KV via TypeScript)

#ifndef GITMODE_POSIX_SHIM_H
#define GITMODE_POSIX_SHIM_H

#include <stddef.h>
#include <stdint.h>

// File descriptor table — maps fd numbers to R2 keys
#define GITMODE_MAX_FDS 256

// Host imports (provided by TypeScript Worker)
// Marked with WASM import attributes so the linker treats them as imports
#define WASM_IMPORT(name) \
    __attribute__((import_module("env"), import_name(#name)))

WASM_IMPORT(__gitmode_fs_open)
extern int32_t __gitmode_fs_open(const char *path, int flags, int mode);

WASM_IMPORT(__gitmode_fs_read)
extern int32_t __gitmode_fs_read(int fd, void *buf, size_t count);

WASM_IMPORT(__gitmode_fs_write)
extern int32_t __gitmode_fs_write(int fd, const void *buf, size_t count);

WASM_IMPORT(__gitmode_fs_close)
extern int32_t __gitmode_fs_close(int fd);

WASM_IMPORT(__gitmode_fs_stat)
extern int32_t __gitmode_fs_stat(const char *path, uint32_t *size_out);

WASM_IMPORT(__gitmode_fs_mkdir)
extern int32_t __gitmode_fs_mkdir(const char *path, int mode);

WASM_IMPORT(__gitmode_fs_unlink)
extern int32_t __gitmode_fs_unlink(const char *path);

WASM_IMPORT(__gitmode_fs_rename)
extern int32_t __gitmode_fs_rename(const char *old, const char *new_);

WASM_IMPORT(__gitmode_fs_readdir_start)
extern int32_t __gitmode_fs_readdir_start(const char *path);

WASM_IMPORT(__gitmode_fs_readdir_next)
extern int32_t __gitmode_fs_readdir_next(int handle, char *name_buf, size_t buf_len);

WASM_IMPORT(__gitmode_fs_readdir_end)
extern void    __gitmode_fs_readdir_end(int handle);

WASM_IMPORT(__gitmode_log)
extern void    __gitmode_log(const char *msg, size_t len);

#endif
