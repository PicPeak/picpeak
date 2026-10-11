#ifndef PICPEAK_LOCAL_PROCESS_LEASE_H
#define PICPEAK_LOCAL_PROCESS_LEASE_H
#include <errno.h>
#include <fcntl.h>
#include <linux/magic.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/vfs.h>
#include <unistd.h>
static int open_process_lease_file(const char *name, int create) {
    if (name[0] != '/') return -1;
    int file = open(name, O_RDWR | O_NOFOLLOW | O_CLOEXEC | (create ? O_CREAT : 0), 0600);
    if (file < 0) return -1;
    struct stat stat; struct statfs filesystem;
    if (fstat(file, &stat) || fstatfs(file, &filesystem) || !S_ISREG(stat.st_mode) ||
        stat.st_nlink != 1 || stat.st_uid != geteuid()) { close(file); return -1; }
    if (filesystem.f_type != EXT4_SUPER_MAGIC && filesystem.f_type != XFS_SUPER_MAGIC &&
        filesystem.f_type != BTRFS_SUPER_MAGIC && filesystem.f_type != TMPFS_MAGIC &&
        filesystem.f_type != OVERLAYFS_SUPER_MAGIC && (unsigned long)filesystem.f_type != 0x2fc12fc1UL &&
        (unsigned long)filesystem.f_type != 0xf2f52010UL) {
        close(file); return -1;
    }
    return file;
}
static int open_process_lease(const char *name, int create) {
    int file = open_process_lease_file(name, create);
    if (file < 0) return -1;
    if (flock(file, LOCK_EX | LOCK_NB)) { int busy = errno == EWOULDBLOCK; close(file); return busy ? -2 : -1; }
    return file;
}
#endif
