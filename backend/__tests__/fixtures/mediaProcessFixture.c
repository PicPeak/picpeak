#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/file.h>
#include <sys/ioctl.h>
#include <unistd.h>
int main(int argc, char **argv) {
    if (argc < 2) return 1;
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
