#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define NODE_PATH "/usr/local/bin/node"
#define HOST_SCRIPT "/app/native-host/host.js"

int main(void) {
  const char *data_dir = getenv("WAR_DATA_DIR");
  const char *socket_path = getenv("WAR_AGENT_SOCKET_PATH");
  if (!data_dir || !*data_dir) data_dir = "/data";
  if (!socket_path || !*socket_path) socket_path = "/data/run/native-bridge.sock";
  if (setenv("WAR_DATA_DIR", data_dir, 1) != 0 || setenv("WAR_AGENT_SOCKET_PATH", socket_path, 1) != 0) {
    fprintf(stderr, "war-native-host: setenv failed: %s\n", strerror(errno));
    return 126;
  }

  char *const argv[] = { (char *)NODE_PATH, (char *)HOST_SCRIPT, NULL };
  execv(NODE_PATH, argv);
  fprintf(stderr, "war-native-host: execv failed: %s\n", strerror(errno));
  return 127;
}
