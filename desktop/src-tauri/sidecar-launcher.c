#include <errno.h>
#include <libgen.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

static int runtime_path(char *destination, size_t size) {
    char executable[PATH_MAX];
    uint32_t executable_size = sizeof(executable);
    if (_NSGetExecutablePath(executable, &executable_size) != 0) {
        errno = ENAMETOOLONG;
        return -1;
    }

    char resolved[PATH_MAX];
    if (realpath(executable, resolved) == NULL) {
        return -1;
    }

    char directory_buffer[PATH_MAX];
    if (strlcpy(directory_buffer, resolved, sizeof(directory_buffer)) >= sizeof(directory_buffer)) {
        errno = ENAMETOOLONG;
        return -1;
    }
    const char *directory = dirname(directory_buffer);

    const char *candidates[] = {
        "%s/../Resources/tuantuan-runtime/tuantuan-runtime",
        "%s/../resources/tuantuan-runtime/tuantuan-runtime",
    };
    for (size_t index = 0; index < sizeof(candidates) / sizeof(candidates[0]); index++) {
        if (snprintf(destination, size, candidates[index], directory) >= (int)size) {
            continue;
        }
        if (access(destination, X_OK) == 0) {
            return 0;
        }
    }
    errno = ENOENT;
    return -1;
}

int main(int argc, char **argv) {
    char runtime[PATH_MAX];
    if (runtime_path(runtime, sizeof(runtime)) != 0) {
        perror("团团 desktop runtime was not found");
        return 127;
    }

    char **child_argv = calloc((size_t)argc + 1, sizeof(char *));
    if (child_argv == NULL) {
        perror("Unable to allocate sidecar arguments");
        return 126;
    }
    child_argv[0] = runtime;
    for (int index = 1; index < argc; index++) {
        child_argv[index] = argv[index];
    }
    child_argv[argc] = NULL;

    execv(runtime, child_argv);
    perror("Unable to start 团团 desktop runtime");
    free(child_argv);
    return 126;
}
