// WASM platform layer — provides POSIX/OS/network symbols for libgit2
// WASM is single-threaded with no filesystem, network, SSH, or TLS.
// These implementations return safe defaults appropriate for the environment.

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

// === WASI main entry point (required by libc) ===
// The Zig WASM module uses wasm.entry = .disabled, but WASI libc
// links __main_void.o which references main().
int main(void) { return 0; }

// === POSIX user/process IDs ===
// Single-threaded WASM — fixed values, no OS user database

typedef unsigned int uid_t;
typedef unsigned int gid_t;
typedef int pid_t;

uid_t getuid(void)  { return 0; }
uid_t geteuid(void) { return 0; }
gid_t getgid(void)  { return 0; }
gid_t getegid(void) { return 0; }
pid_t getppid(void) { return 1; }
pid_t getpgid(pid_t pid) { (void)pid; return 1; }
pid_t getsid(pid_t pid)  { (void)pid; return 1; }

// getpwuid_r — no user database in WASM
struct passwd;
int getpwuid_r(uid_t uid, struct passwd *pwd, char *buf, size_t buflen, struct passwd **result) {
    (void)uid; (void)pwd; (void)buf; (void)buflen;
    *result = NULL;
    return -1;
}

// === Smart transport ===
// Not used — all object access goes through the custom ODB backend.
// These are referenced by libgit2's transport registration table.

int git_transport_smart(void **out, void *owner, void *param) {
    (void)out; (void)owner; (void)param;
    return -1;
}

int git_smart_subtransport_git(void **out, void *owner, void *param) {
    (void)out; (void)owner; (void)param;
    return -1;
}

int git_smart_subtransport_http(void **out, void *owner, void *param) {
    (void)out; (void)owner; (void)param;
    return -1;
}

// Smart transport globals referenced by settings.c
bool git_smart__ofs_delta_enabled = true;

// === HTTP transport ===
// Not used — no network in WASM.
bool git_http__expect_continue = false;

// === Socket/stream ===
// Not used — no sockets in WASM.
int git_socket_stream__connect_timeout = 0;
int git_socket_stream__timeout = 0;

int git_socket_stream_global_init(void) { return 0; }

// === TLS/SSH initialization ===
// Not used — no TLS or SSH in WASM.
int git_openssl_stream_global_init(void)  { return 0; }
int git_mbedtls_stream_global_init(void)  { return 0; }
int git_transport_ssh_libssh2_global_init(void) { return 0; }
