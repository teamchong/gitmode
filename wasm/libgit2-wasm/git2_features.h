// Generated for wasm32-freestanding — minimal libgit2 config
// No threads, no SSH, no HTTPS, no networking
// Builtin SHA1 (collision-detecting), builtin SHA256, builtin zlib, builtin regex

#ifndef INCLUDE_features_h__
#define INCLUDE_features_h__

// No threading on WASM
// #define GIT_THREADS 1

// SHA1: collision-detecting builtin
#define GIT_SHA1_BUILTIN 1

// SHA256: builtin (RFC 6234)
#define GIT_SHA256_BUILTIN 1

// Compression: builtin (bundled miniz/deflate)
#define GIT_COMPRESSION_BUILTIN 1

// Regex: builtin
#define GIT_REGEX_BUILTIN 1

// HTTP parser: builtin
#define GIT_HTTPPARSER_BUILTIN 1

// No SSH
// #define GIT_SSH 1

// No HTTPS
// #define GIT_HTTPS 1

// No NTLM
// #define GIT_AUTH_NTLM 1

// No nanosecond timestamps
// #define GIT_NSEC 1

// 32-bit architecture (wasm32)
#define GIT_ARCH_32 1

// No futimens
// #define GIT_FUTIMENS 1

// qsort
// #define GIT_QSORT_BSD 1

// I/O: none (no sockets)
// #define GIT_IO_POLL 1
// #define GIT_IO_SELECT 1

#endif
