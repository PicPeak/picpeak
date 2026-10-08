#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/file.h>
#include <sys/ioctl.h>
#include <sys/syscall.h>
#include <unistd.h>
static void *held_thread(void *unused) { (void)unused; for (;;) pause(); return NULL; }
int main(int argc, char **argv) {
    if (argc < 2) return 1;
    if (!strcmp(argv[1], "ordinary-error")) return 234;
    if (!strcmp(argv[1], "untraced")) {
        void *stack = malloc(65536); if (!stack) return 1;
        const unsigned flags[] = { CLONE_UNTRACED, CLONE_VFORK };
        for (unsigned n = 0; n < sizeof(flags) / sizeof(flags[0]); n++) {
            long result = syscall(SYS_clone, CLONE_VM | CLONE_THREAD | CLONE_SIGHAND | flags[n],
                (char *)stack + 65536, NULL, NULL, 0);
            if (result != -1 || errno != EPERM) return 1;
        }
        puts("untraced clone denied"); free(stack); return 0;
    }
    if (!strcmp(argv[1], "threads")) {
        pthread_attr_t attributes; pthread_attr_init(&attributes);
        int stack_error = pthread_attr_setstacksize(&attributes, 262144);
        if (stack_error) { fprintf(stderr, "owned stack size: %s\n", strerror(stack_error)); return 1; }
        for (int n = 0; n < 256; n++) {
            pthread_t thread;
            int error = pthread_create(&thread, &attributes, held_thread, NULL);
            if (error) { fprintf(stderr, "owned thread %d: %s\n", n, strerror(error)); return 1; }
        }
        return 1;
    }
    if (!strcmp(argv[1], "limits")) {
        struct rlimit memory, cpu, file;
        getrlimit(RLIMIT_AS, &memory); getrlimit(RLIMIT_CPU, &cpu); getrlimit(RLIMIT_FSIZE, &file);
        printf("%llu %llu %llu\n", (unsigned long long)memory.rlim_cur,
            (unsigned long long)cpu.rlim_cur, (unsigned long long)file.rlim_cur); return 0;
    }
    if (!strcmp(argv[1], "memory")) {
        void *value = malloc(600 * 1024 * 1024);
        if (!value) { fputs("cannot allocate memory\n", stderr); return 1; }
        memset(value, 42, 600 * 1024 * 1024); printf("%d\n", ((char *)value)[599 * 1024 * 1024]); free(value); return 0;
    }
    if (!strcmp(argv[1], "fork")) {
        pid_t child = fork();
        if (child < 0 && errno == EPERM) { puts("process fork denied"); return 0; }
        if (child == 0) _exit(1);
        return 1;
    }
    if (!strcmp(argv[1], "unlock") && argc == 3) {
        int original = flock(9, LOCK_UN), original_errno = errno;
        int duplicate = dup(9);
        int copied = duplicate < 0 ? 0 : flock(duplicate, LOCK_UN), copied_errno = errno;
        int cloexec = ioctl(9, FIOCLEX), cloexec_errno = errno;
        if (duplicate >= 0) close(duplicate);
        if (original != -1 || original_errno != EPERM || copied != -1 || copied_errno != EPERM ||
            cloexec != -1 || cloexec_errno != EPERM) return 1;
        FILE *ready = fopen(argv[2], "w"); if (!ready) return 1;
        fputs("original and duplicate unlock denied", ready); fclose(ready);
        sleep(30); return 0;
    }
    if (!strcmp(argv[1], "spin")) { volatile unsigned long n = 0; for (;;) n++; }
    if (!strcmp(argv[1], "sleep")) { sleep(30); return 0; }
    if (!strcmp(argv[1], "output")) { for (;;) puts("bounded-output-must-stop"); }
    if (!strcmp(argv[1], "file") && argc == 3) {
        FILE *file = fopen(argv[2], "w"); if (!file) return 1;
        for (;;) fputs("bounded-file-must-stop\n", file);
    }
    return 1;
}
