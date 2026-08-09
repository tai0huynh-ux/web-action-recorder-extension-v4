#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define LAUNCHER_PATH "/usr/local/bin/war-cloakbrowser-sandbox-launcher"
#define CLOAKBROWSER_PATH "/opt/war/cloakbrowser/chromium-146.0.7680.177.5/chrome"
#define MAX_BROWSER_ARGS 4096

static int is_expected_launcher(void) {
  char executable[PATH_MAX];
  const ssize_t length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);

  if (length < 0 || (size_t)length >= sizeof(executable)) return 0;
  executable[length] = '\0';
  return strcmp(executable, LAUNCHER_PATH) == 0;
}

int main(int argc, char *argv[]) {
  char *browser_argv[MAX_BROWSER_ARGS + 1];

  if (argc < 1 || argc > MAX_BROWSER_ARGS || !argv || !is_expected_launcher()) {
    fputs("war-cloakbrowser-sandbox-launcher: unexpected invocation\n", stderr);
    return 126;
  }

  browser_argv[0] = (char *)CLOAKBROWSER_PATH;
  for (int index = 1; index < argc; index++) {
    if (!argv[index]) {
      fputs("war-cloakbrowser-sandbox-launcher: invalid argument vector\n", stderr);
      return 126;
    }
    browser_argv[index] = argv[index];
  }
  browser_argv[argc] = NULL;

  execv(CLOAKBROWSER_PATH, browser_argv);
  fprintf(stderr, "war-cloakbrowser-sandbox-launcher: execv failed: %s\n", strerror(errno));
  return 127;
}
