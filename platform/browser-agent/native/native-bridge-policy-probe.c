#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#define BRIDGE_SOCKET "/data/run/native-bridge.sock"
#define SIBLING_SOCKET "/data/run/native-bridge-policy-probe.sock"
#define UNLINK_SENTINEL "/data/run/native-bridge-policy-unlink"

static void print_json_string(const char *value) {
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor; cursor++) {
    if (*cursor == '"' || *cursor == '\\') putchar('\\');
    if (*cursor >= 0x20) putchar(*cursor);
  }
}

static int connect_bridge(void) {
  const int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return errno;
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  strncpy(address.sun_path, BRIDGE_SOCKET, sizeof(address.sun_path) - 1);
  const int result = connect(fd, (const struct sockaddr *)&address, sizeof(address));
  const int saved_errno = result == 0 ? 0 : errno;
  close(fd);
  return saved_errno;
}

static int poll_bridge(void) {
  const int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return errno;
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  strncpy(address.sun_path, BRIDGE_SOCKET, sizeof(address.sun_path) - 1);
  if (connect(fd, (const struct sockaddr *)&address, sizeof(address)) != 0) {
    const int saved_errno = errno;
    close(fd);
    return saved_errno;
  }
  struct pollfd descriptor = { .fd = fd, .events = POLLIN };
  const int result = poll(&descriptor, 1, 0);
  const int saved_errno = result < 0 ? errno : 0;
  close(fd);
  return saved_errno;
}

static int unlink_sentinel(void) {
  return unlink(UNLINK_SENTINEL) == 0 ? 0 : errno;
}

static int bind_and_listen_sibling(void) {
  const int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return errno;
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  strncpy(address.sun_path, SIBLING_SOCKET, sizeof(address.sun_path) - 1);
  if (bind(fd, (const struct sockaddr *)&address, sizeof(address)) != 0) {
    const int saved_errno = errno;
    close(fd);
    return saved_errno;
  }
  const int result = listen(fd, 1);
  const int saved_errno = result == 0 ? 0 : errno;
  close(fd);
  return saved_errno;
}

static void read_profile(char *profile, size_t size) {
  FILE *file = fopen("/proc/self/attr/current", "r");
  if (!file) {
    strncpy(profile, "unavailable", size - 1);
    profile[size - 1] = '\0';
    return;
  }
  if (!fgets(profile, (int)size, file)) strncpy(profile, "unavailable", size - 1);
  fclose(file);
  profile[strcspn(profile, "\r\n")] = '\0';
}

int main(void) {
  char profile[256] = {0};
  read_profile(profile, sizeof(profile));
  const int connect_errno = connect_bridge();
  const int poll_errno = poll_bridge();
  const int unlink_errno = unlink_sentinel();
  const int bind_listen_errno = bind_and_listen_sibling();

  printf("{\"profile\":\"");
  print_json_string(profile);
  printf("\",\"connect\":%d,\"poll\":%d,\"unlink\":%d,\"bindListen\":%d}\n",
    connect_errno, poll_errno, unlink_errno, bind_listen_errno);
  return 0;
}
