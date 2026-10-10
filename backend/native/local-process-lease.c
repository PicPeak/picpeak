#define _GNU_SOURCE
/* Trusted kernel lock only; no guest media parser is loaded in the server. */
#include <node_api.h>
#include <string.h>
#include <stdio.h>
#include "local-process-lease.h"
static struct { int file; int used; } leases[256];
static napi_value error(napi_env env, int busy) {
    napi_throw_error(env, busy ? "MEDIA_LEASE_BUSY" : "MEDIA_LEASE_UNAVAILABLE", "A persistent local Linux execution lease is unavailable");
    return NULL;
}
static int name(napi_env env, napi_callback_info info, char *target, napi_value *args, size_t count) {
    size_t argc = count, size;
    if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != count ||
        napi_get_value_string_utf8(env, args[0], target, 4096, &size) != napi_ok || size == 0 ||
        size >= 4095 || strlen(target) != size || target[0] != '/') return -1;
    return 0;
}
static napi_value acquire(napi_env env, napi_callback_info info) {
    char filename[4096]; napi_value args[1];
    if (name(env, info, filename, args, 1)) return error(env, 0);
    int slot; for (slot = 0; slot < 256 && leases[slot].used; slot++);
    if (slot == 256) return error(env, 0);
    int file = open_process_lease(filename, 1);
    if (file < 0) return error(env, file == -2);
    leases[slot].file = file; leases[slot].used = 1;
    struct stat stat; struct statfs filesystem;
    if (fstat(file, &stat) || fstatfs(file, &filesystem)) { close(file); leases[slot].used = 0; return error(env, 0); }
    napi_value result, value; char text[64]; napi_create_object(env, &result);
    napi_create_int32(env, file, &value); napi_set_named_property(env, result, "descriptor", value);
    snprintf(text, sizeof(text), "%llu", (unsigned long long)stat.st_dev);
    napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, result, "device", value);
    snprintf(text, sizeof(text), "%llu", (unsigned long long)stat.st_ino);
    napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, result, "inode", value);
    snprintf(text, sizeof(text), "%lu", (unsigned long)filesystem.f_type);
    napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, result, "filesystem", value);
    return result;
}
static napi_value release(napi_env env, napi_callback_info info) {
    napi_value args[1]; size_t argc = 1; int file;
    if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1 ||
        napi_get_value_int32(env, args[0], &file) != napi_ok) return error(env, 0);
    for (int slot = 0; slot < 256; slot++) {
        if (leases[slot].used && leases[slot].file == file) {
            if (close(file)) return error(env, 0);
            leases[slot].used = 0; napi_value result; napi_get_undefined(env, &result); return result;
        }
    }
    return error(env, 0);
}
static napi_value probe(napi_env env, napi_callback_info info) {
    char filename[4096], device[64], inode[64], filesystem[64]; napi_value args[4]; size_t size;
    if (name(env, info, filename, args, 4) ||
        napi_get_value_string_utf8(env, args[1], device, sizeof(device), &size) != napi_ok || size >= 63 ||
        napi_get_value_string_utf8(env, args[2], inode, sizeof(inode), &size) != napi_ok || size >= 63 ||
        napi_get_value_string_utf8(env, args[3], filesystem, sizeof(filesystem), &size) != napi_ok || size >= 63) return error(env, 0);
    int file = open_process_lease_file(filename, 0);
    const char *state = file >= 0 ? "matching" : "unknown";
    if (file >= 0) {
        if (*device || *inode || *filesystem) {
            struct stat stat; struct statfs fs; char actual_device[64], actual_inode[64], actual_filesystem[64];
            if (fstat(file, &stat) || fstatfs(file, &fs)) state = "unknown";
            else {
                snprintf(actual_device, sizeof(actual_device), "%llu", (unsigned long long)stat.st_dev);
                snprintf(actual_inode, sizeof(actual_inode), "%llu", (unsigned long long)stat.st_ino);
                snprintf(actual_filesystem, sizeof(actual_filesystem), "%lu", (unsigned long)fs.f_type);
                if (strcmp(device, actual_device) || strcmp(inode, actual_inode) || strcmp(filesystem, actual_filesystem)) state = "unknown";
            }
        }
        if (!strcmp(state, "matching")) {
            state = !flock(file, LOCK_EX | LOCK_NB) ? "free" : errno == EWOULDBLOCK ? "busy" : "unknown";
        }
        close(file);
    }
    napi_value result; napi_create_string_utf8(env, state, NAPI_AUTO_LENGTH, &result); return result;
}
static napi_value init(napi_env env, napi_value exports) {
    napi_property_descriptor descriptors[] = {
        { "acquire", NULL, acquire, NULL, NULL, NULL, napi_default, NULL },
        { "release", NULL, release, NULL, NULL, NULL, napi_default, NULL },
        { "probe", NULL, probe, NULL, NULL, NULL, napi_default, NULL },
    };
    napi_define_properties(env, exports, 3, descriptors); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
