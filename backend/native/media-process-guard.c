#define _GNU_SOURCE
/* Linux-only supervisor. A successful terminal record means every child was
 * reaped, not merely that a signal was sent. Native jobs may create threads,
 * but cannot fork another process and multiply their address-space budget. */
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/magic.h>
#include <linux/sched.h>
#include <linux/seccomp.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/file.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/vfs.h>
#include <time.h>
#include <unistd.h>
#include "local-process-lease.h"

static volatile sig_atomic_t cancelled = 0;
static void cancel_handler(int signal_number) { (void)signal_number; cancelled = 1; }
static uint64_t number(const char *value) {
    char *end; errno = 0;
    unsigned long long result = strtoull(value, &end, 10);
    if (errno || !*value || *end || value[0] == '-' || result == 0) _exit(125);
    return result;
}
static void limit(int resource, uint64_t amount) {
    struct rlimit value = { (rlim_t)amount, (rlim_t)amount };
    if (setrlimit(resource, &value) != 0) _exit(125);
}
static uint64_t milliseconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) _exit(125);
    return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
}
#define lease_file open_process_lease
static int parent_signals(pid_t parent) {
    struct sigaction action; memset(&action, 0, sizeof(action));
    action.sa_handler = cancel_handler; sigemptyset(&action.sa_mask);
    signal(SIGPIPE, SIG_IGN);
    if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL) ||
        prctl(PR_SET_PDEATHSIG, SIGTERM)) return -1;
    return getppid() == parent && !cancelled ? 0 : -1;
}
static int thread_only(int protect_lease) {
#if defined(__x86_64__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported Linux architecture
#endif
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NATIVE_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
        /* The x32 ABI has the same audit arch but distinct syscall numbers. */
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000U, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
#endif
        /* flock locks share an open-file description across fork/dup. Even
         * LOCK_UN through a duplicate would release the guardian's lease. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_flock, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, protect_lease ? SECCOMP_RET_ERRNO | EPERM : SECCOMP_RET_ALLOW),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_ioctl, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, protect_lease ? 9U : UINT32_MAX, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_close, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, protect_lease ? 9U : UINT32_MAX, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#ifdef SYS_dup2
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_dup2, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, protect_lease ? 9U : UINT32_MAX, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#endif
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_dup3, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, protect_lease ? 9U : UINT32_MAX, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_fcntl, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, protect_lease ? 9U : UINT32_MAX, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#ifdef SYS_close_range
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_close_range, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
#endif
#ifdef SYS_fork
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_fork, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
#endif
#ifdef SYS_vfork
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_vfork, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
#endif
#ifdef SYS_clone3
        /* glibc/musl pthreads fall back to clone when clone3 is unavailable. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone3, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
#endif
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone, 0, 4),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_STMT(BPF_ALU | BPF_AND | BPF_K, CLONE_THREAD | CLONE_VM),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, CLONE_THREAD | CLONE_VM, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = { sizeof(filter) / sizeof(filter[0]), filter };
    return prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
        prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}
int main(int argc, char **argv) {
    if (argc == 3 && !strcmp(argv[1], "--lease-check")) {
        int lease = lease_file(argv[2], 0);
        if (lease >= 0) { close(lease); return 0; }
        return lease == -2 ? 123 : 125;
    }
    if (argc < 9) return 125;
    pid_t parent = (pid_t)number(argv[1]);
    uint64_t bytes = number(argv[2]), cpu = number(argv[3]);
    uint64_t file_bytes = number(argv[4]), wall = number(argv[5]), threads = number(argv[6]);
    if (bytes > UINT64_C(4294967296) || cpu > 7200 || wall > 7200000 ||
        file_bytes > UINT64_C(10737418240) || threads > 256) return 125;
    if (parent_signals(parent) || prctl(PR_SET_CHILD_SUBREAPER, 1)) return 125;
    if (strcmp(argv[7], "-")) {
        int lease = lease_file(argv[7], 1);
        if (lease < 0) return lease == -2 ? 123 : 125;
        int inherited = fcntl(lease, F_DUPFD, 9);
        if (inherited != 9) { close(lease); return 125; }
        close(lease);
    }
    pid_t supervisor = getpid();
    uint64_t deadline = milliseconds() + wall;
    int gate[2];
    if (pipe2(gate, O_CLOEXEC) || fcntl(4, F_SETFL, O_NONBLOCK)) return 125;
    pid_t child = fork();
    if (child < 0) return 125;
    if (child == 0) {
        close(gate[1]);
        if (setpgid(0, 0) || prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != supervisor) _exit(125);
        signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGPIPE, SIG_DFL);
        limit(RLIMIT_AS, bytes); limit(RLIMIT_CPU, cpu); limit(RLIMIT_FSIZE, file_bytes);
        limit(RLIMIT_NPROC, threads); limit(RLIMIT_CORE, 0); limit(RLIMIT_STACK, 16 * 1024 * 1024);
        if (thread_only(strcmp(argv[7], "-") != 0)) _exit(125);
        close(3); close(4);
        char permission;
        if (read(gate[0], &permission, 1) != 1 || permission != '1') _exit(125);
        close(gate[0]);
        execvp(argv[8], &argv[8]);
        _exit(errno == ENOENT ? 127 : 126);
    }
    close(gate[0]);
    /* Both sides set the group: cancellation cannot race the child's setup. */
    (void)setpgid(child, child);
    struct stat lease_stat; memset(&lease_stat, 0, sizeof(lease_stat));
    struct statfs lease_fs; memset(&lease_fs, 0, sizeof(lease_fs));
    if (strcmp(argv[7], "-") && (fstat(9, &lease_stat) || fstatfs(9, &lease_fs))) {
        (void)kill(-child, SIGKILL); (void)kill(child, SIGKILL);
        while (waitpid(-1, NULL, 0) >= 0 || errno == EINTR) {}
        dprintf(3, "{\"terminal\":true}\n");
        return 125;
    }
    dprintf(3, "{\"version\":1,\"pid\":%d,\"group\":%d,\"leaseDevice\":\"%llu\",\"leaseInode\":\"%llu\",\"leaseFilesystem\":\"%lu\"}\n",
        child, child, (unsigned long long)lease_stat.st_dev, (unsigned long long)lease_stat.st_ino, (unsigned long)lease_fs.f_type);
    int status = 0, final_status = 0, stopped = 0, timed_out = 0, released = 0;
    for (;;) {
        if (!released && !stopped) {
            char permission;
            ssize_t count = read(4, &permission, 1);
            if (count == 1 && permission == '1') {
                if (write(gate[1], &permission, 1) != 1) cancelled = 1;
                close(gate[1]); close(4); released = 1;
            } else if (count == 0 || (count < 0 && errno != EAGAIN && errno != EINTR)) cancelled = 1;
        }
        if (!stopped && (cancelled || milliseconds() >= deadline)) {
            timed_out = !cancelled; stopped = 1;
            (void)kill(-child, SIGKILL); (void)kill(child, SIGKILL);
        }
        pid_t result = waitpid(-1, &status, WNOHANG);
        if (result > 0) {
            if (result == child) { final_status = status; stopped = 1; (void)kill(-child, SIGKILL); }
            continue;
        }
        if (result < 0 && errno == ECHILD) break;
        if (result < 0 && errno != EINTR) return 125;
        struct timespec delay = { 0, 10000000 }; (void)nanosleep(&delay, NULL);
    }
    dprintf(3, "{\"terminal\":true,\"timedOut\":%s,\"cancelled\":%s,\"childSignal\":%d}\n",
        timed_out ? "true" : "false", cancelled ? "true" : "false",
        WIFSIGNALED(final_status) ? WTERMSIG(final_status) : 0);
    close(3);
    if (timed_out) return 124;
    if (cancelled) return 130;
    return WIFEXITED(final_status) ? WEXITSTATUS(final_status) : 128 + WTERMSIG(final_status);
}
