#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/Xutil.h>
#include <X11/keysym.h>
#include <X11/extensions/XTest.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define MAX_LINE 8192
#define MAX_ID 96
#define MAX_TYPE 48
#define MAX_TEXT 4096
#define MAX_HELD 256

static volatile sig_atomic_t running = 1;
static Display *display;
static int screen_width;
static int screen_height;
static KeyCode held_keys[MAX_HELD];
static int held_key_count;
static int held_buttons[8];
static volatile int last_x_error;

typedef struct {
  int64_t deadline_at;
  int64_t monotonic_deadline_at;
} CommandTiming;
static CommandTiming active_timing;
static bool last_guard_deadline;

static void on_signal(int signo) {
  (void)signo;
  running = 0;
}

static int on_x_error(Display *dpy, XErrorEvent *event) {
  (void)dpy;
  last_x_error = event->error_code;
  return 0;
}

static void json_escape(FILE *out, const char *value) {
  for (const char *p = value; *p; p++) {
    if (*p == '"' || *p == '\\') {
      fputc('\\', out);
      fputc(*p, out);
    } else if ((unsigned char)*p < 32) {
      fprintf(out, "\\u%04x", (unsigned char)*p);
    } else {
      fputc(*p, out);
    }
  }
}

static void respond(FILE *out, const char *id, bool ok, const char *error, int held_keys_count, int held_buttons_count) {
  fprintf(out, "{\"id\":\"");
  json_escape(out, id ? id : "");
  fprintf(out, "\",\"ok\":%s", ok ? "true" : "false");
  if (!ok) {
    fprintf(out, ",\"error\":\"");
    json_escape(out, error ? error : "error");
    fprintf(out, "\"");
  }
  fprintf(out, ",\"protocol\":2,\"heldKeys\":%d,\"heldButtons\":%d,\"state\":{\"heldKeys\":%d,\"heldButtons\":%d}}\n",
          held_keys_count, held_buttons_count, held_keys_count, held_buttons_count);
  fflush(out);
}

static const char *find_json_member_value(const char *line, const char *key) {
  char pattern[64];
  int pattern_len = snprintf(pattern, sizeof(pattern), "\"%s\"", key);
  if (pattern_len < 0 || (size_t)pattern_len >= sizeof(pattern)) return NULL;

  const char *member = line;
  while ((member = strstr(member, pattern)) != NULL) {
    const char *value = member + pattern_len;
    while (isspace((unsigned char)*value)) value++;
    if (*value == ':') return value + 1;
    member = value;
  }
  return NULL;
}

static bool get_json_string(const char *line, const char *key, char *out, size_t out_len) {
  const char *p = find_json_member_value(line, key);
  if (!p) return false;
  while (isspace((unsigned char)*p)) p++;
  if (*p != '"') return false;
  p++;
  size_t i = 0;
  while (*p && *p != '"' && i + 1 < out_len) {
    if (*p == '\\' && p[1]) p++;
    out[i++] = *p++;
  }
  out[i] = '\0';
  return *p == '"';
}

static bool get_json_int(const char *line, const char *key, int *out) {
  const char *p = find_json_member_value(line, key);
  if (!p) return false;
  while (isspace((unsigned char)*p)) p++;
  if (!isdigit((unsigned char)*p) && *p != '-') return false;
  char *end = NULL;
  long value = strtol(p, &end, 10);
  if (end == p || value < -100000 || value > 100000) return false;
  *out = (int)value;
  return true;
}

static int button_number(const char *button) {
  if (strcmp(button, "left") == 0) return 1;
  if (strcmp(button, "middle") == 0) return 2;
  if (strcmp(button, "right") == 0) return 3;
  return 0;
}

static KeySym key_symbol(const char *key) {
  if (strcmp(key, "CTRL") == 0 || strcmp(key, "CONTROL") == 0 || strcmp(key, "Control") == 0 || strcmp(key, "Control_L") == 0) return XK_Control_L;
  if (strcmp(key, "SHIFT") == 0 || strcmp(key, "Shift") == 0 || strcmp(key, "Shift_L") == 0) return XK_Shift_L;
  if (strcmp(key, "ALT") == 0 || strcmp(key, "Alt") == 0 || strcmp(key, "Alt_L") == 0) return XK_Alt_L;
  if (strcmp(key, "META") == 0 || strcmp(key, "Meta") == 0 || strcmp(key, "Meta_L") == 0) return XK_Super_L;
  if (strcmp(key, "Enter") == 0 || strcmp(key, "Return") == 0) return XK_Return;
  if (strcmp(key, "Escape") == 0) return XK_Escape;
  if (strcmp(key, "Tab") == 0) return XK_Tab;
  if (strcmp(key, "Backspace") == 0) return XK_BackSpace;
  if (strcmp(key, "Delete") == 0) return XK_Delete;
  if (strcmp(key, "Space") == 0) return XK_space;
  if (strcmp(key, "ArrowLeft") == 0 || strcmp(key, "LEFT") == 0 || strcmp(key, "Left") == 0) return XK_Left;
  if (strcmp(key, "ArrowRight") == 0 || strcmp(key, "RIGHT") == 0 || strcmp(key, "Right") == 0) return XK_Right;
  if (strcmp(key, "ArrowUp") == 0 || strcmp(key, "UP") == 0 || strcmp(key, "Up") == 0) return XK_Up;
  if (strcmp(key, "ArrowDown") == 0 || strcmp(key, "DOWN") == 0 || strcmp(key, "Down") == 0) return XK_Down;
  if (strcmp(key, "ESCAPE") == 0) return XK_Escape;
  if (strcmp(key, "F5") == 0) return XK_F5;
  if (strlen(key) == 1) {
    char normalized[2] = { (char)tolower((unsigned char)key[0]), '\0' };
    return XStringToKeysym(normalized);
  }
  return NoSymbol;
}

static bool valid_point(int x, int y) {
  return x >= 0 && y >= 0 && x <= screen_width && y <= screen_height;
}

static void track_key(KeyCode code, bool down) {
  if (down) {
    for (int i = 0; i < held_key_count; i++) if (held_keys[i] == code) return;
    if (held_key_count < MAX_HELD) held_keys[held_key_count++] = code;
  } else {
    for (int i = 0; i < held_key_count; i++) {
      if (held_keys[i] == code) {
        held_keys[i] = held_keys[--held_key_count];
        return;
      }
    }
  }
}

static int held_button_count(void) {
  int count = 0;
  for (int i = 1; i < 8; i++) if (held_buttons[i]) count++;
  return count;
}

static bool fake_key(const char *key, bool down) {
  KeySym sym = key_symbol(key);
  if (sym == NoSymbol) return false;
  KeyCode code = XKeysymToKeycode(display, sym);
  if (!code) return false;
  if (!XTestFakeKeyEvent(display, code, down ? True : False, CurrentTime)) return false;
  XFlush(display);
  track_key(code, down);
  return true;
}

static bool fake_button(int button, bool down) {
  if (button < 1 || button > 7) return false;
  if (!XTestFakeButtonEvent(display, button, down ? True : False, CurrentTime)) return false;
  XFlush(display);
  return true;
}

static bool fake_motion(int x, int y) {
  if (!XTestFakeMotionEvent(display, DefaultScreen(display), x, y, CurrentTime)) return false;
  XFlush(display);
  return true;
}

static bool fake_text_char(char c) {
  char key[2] = { c, '\0' };
  KeySym sym = XStringToKeysym(key);
  bool shift = false;
  if (c == '\n') sym = XK_Return;
  if (c == ' ') sym = XK_space;
  if (c == ':') { sym = XK_semicolon; shift = true; }
  if (c == '/') sym = XK_slash;
  if (c == '.') sym = XK_period;
  if (c == ',') sym = XK_comma;
  if (c == ';') sym = XK_semicolon;
  if (c == '?') { sym = XK_slash; shift = true; }
  if (c == '!') { sym = XK_1; shift = true; }
  if (c == '@') { sym = XK_2; shift = true; }
  if (c == '#') { sym = XK_3; shift = true; }
  if (c == '$') { sym = XK_4; shift = true; }
  if (c == '%') { sym = XK_5; shift = true; }
  if (c == '^') { sym = XK_6; shift = true; }
  if (c == '&') { sym = XK_7; shift = true; }
  if (c == '*') { sym = XK_8; shift = true; }
  if (c == '(') { sym = XK_9; shift = true; }
  if (c == ')') { sym = XK_0; shift = true; }
  if (c == '-') sym = XK_minus;
  if (c == '=') sym = XK_equal;
  if (c == '+') { sym = XK_equal; shift = true; }
  if (c == '_') { sym = XK_minus; shift = true; }
  if (c == '\\') sym = XK_backslash;
  if (c == '\'') sym = XK_apostrophe;
  if (c == '"') { sym = XK_apostrophe; shift = true; }
  if (c == '[') sym = XK_bracketleft;
  if (c == ']') sym = XK_bracketright;
  if (c == '{') { sym = XK_bracketleft; shift = true; }
  if (c == '}') { sym = XK_bracketright; shift = true; }
  if (c == '<') { sym = XK_comma; shift = true; }
  if (c == '>') { sym = XK_period; shift = true; }
  if (c >= 'A' && c <= 'Z') { key[0] = (char)tolower((unsigned char)c); sym = XStringToKeysym(key); shift = true; }
  if (sym == NoSymbol) return false;
  KeyCode code = XKeysymToKeycode(display, sym);
  if (!code) return false;
  KeyCode shift_code = XKeysymToKeycode(display, XK_Shift_L);
  if (shift && !XTestFakeKeyEvent(display, shift_code, True, CurrentTime)) return false;
  if (!XTestFakeKeyEvent(display, code, True, CurrentTime)) {
    if (shift) XTestFakeKeyEvent(display, shift_code, False, CurrentTime);
    return false;
  }
  if (!XTestFakeKeyEvent(display, code, False, CurrentTime)) {
    if (shift) XTestFakeKeyEvent(display, shift_code, False, CurrentTime);
    return false;
  }
  if (shift && !XTestFakeKeyEvent(display, shift_code, False, CurrentTime)) return false;
  XFlush(display);
  return true;
}

static void release_all(void) {
  for (int i = 0; i < held_key_count; i++) XTestFakeKeyEvent(display, held_keys[i], False, CurrentTime);
  held_key_count = 0;
  for (int i = 1; i < 8; i++) {
    if (held_buttons[i]) XTestFakeButtonEvent(display, i, False, CurrentTime);
    held_buttons[i] = 0;
  }
  XFlush(display);
}

static bool get_json_int64(const char *line, const char *key, int64_t *out) {
  const char *p = find_json_member_value(line, key);
  if (!p) return false;
  while (isspace((unsigned char)*p)) p++;
  if (!isdigit((unsigned char)*p)) return false;
  errno = 0;
  char *end = NULL;
  unsigned long long value = strtoull(p, &end, 10);
  if (errno == ERANGE || end == p || value > INT64_MAX) return false;
  if (*end && !isspace((unsigned char)*end) && *end != ',' && *end != '}') return false;
  *out = (int64_t)value;
  return true;
}

static int64_t clock_milliseconds(clockid_t clock_id) {
  struct timespec value;
  if (clock_gettime(clock_id, &value) != 0) return -1;
  return ((int64_t)value.tv_sec * 1000) + (value.tv_nsec / 1000000);
}

static bool deadline_expired(const CommandTiming *timing) {
  if (!timing) return true;
  int64_t now_real = clock_milliseconds(CLOCK_REALTIME);
  int64_t now_mono = clock_milliseconds(CLOCK_MONOTONIC);
  return now_real < 0 || now_mono < 0 || timing->deadline_at <= now_real || timing->monotonic_deadline_at <= now_mono;
}

static bool parse_war2_line(const char *line, const char **json, CommandTiming *timing) {
  if (strncmp(line, "WAR2 ", 5) != 0) return false;
  const char *cursor = line + 5;
  if (!isdigit((unsigned char)*cursor)) return false;
  errno = 0;
  char *end = NULL;
  unsigned long long value = strtoull(cursor, &end, 10);
  if (errno == ERANGE || end == cursor || value > INT64_MAX || *end != ' ') return false;
  const char *payload = end + 1;
  if (*payload != '{') return false;
  int64_t now_real = clock_milliseconds(CLOCK_REALTIME);
  int64_t now_mono = clock_milliseconds(CLOCK_MONOTONIC);
  if (now_real < 0 || now_mono < 0) return false;
  timing->deadline_at = (int64_t)value;
  int64_t remaining = timing->deadline_at > now_real ? timing->deadline_at - now_real : 0;
  if (remaining > INT64_MAX - now_mono) return false;
  timing->monotonic_deadline_at = now_mono + remaining;
  *json = payload;
  return true;
}

static bool contains_case_insensitive(const char *value, const char *needle) {
  size_t needle_len = strlen(needle);
  if (!needle_len) return true;
  for (const char *candidate = value; *candidate; candidate++) {
    size_t i = 0;
    while (i < needle_len && candidate[i] && tolower((unsigned char)candidate[i]) == tolower((unsigned char)needle[i])) i++;
    if (i == needle_len) return true;
  }
  return false;
}

static bool window_has_browser_class(Window window) {
  XWindowAttributes attrs;
  if (!XGetWindowAttributes(display, window, &attrs) || attrs.map_state != IsViewable) return false;
  XClassHint hint;
  if (!XGetClassHint(display, window, &hint)) return false;
  bool match = false;
  if (hint.res_class && (contains_case_insensitive(hint.res_class, "chromium") || contains_case_insensitive(hint.res_class, "cloakbrowser"))) match = true;
  if (hint.res_name && (contains_case_insensitive(hint.res_name, "chromium") || contains_case_insensitive(hint.res_name, "cloakbrowser"))) match = true;
  if (hint.res_name) XFree(hint.res_name);
  if (hint.res_class) XFree(hint.res_class);
  return match;
}

static unsigned int find_direct_browser_windows(Window root, Window *matched_window) {
  Window parent, *children = NULL, root_return;
  unsigned int nchildren = 0;
  if (!XQueryTree(display, root, &root_return, &parent, &children, &nchildren)) return 0;
  Window found = 0;
  unsigned int matches = 0;
  for (unsigned int i = 0; i < nchildren; i++) {
    if (!window_has_browser_class(children[i])) continue;
    found = children[i];
    matches++;
  }
  if (children) XFree(children);
  *matched_window = found;
  return matches;
}

static bool window_is_descendant_of(Window window, Window ancestor) {
  Window current = window;
  for (int depth = 0; current && current != PointerRoot && depth < 64; depth++) {
    if (current == ancestor) return true;
    Window root_return = 0, parent = 0, *children = NULL;
    unsigned int nchildren = 0;
    if (!XQueryTree(display, current, &root_return, &parent, &children, &nchildren)) return false;
    if (children) XFree(children);
    current = parent;
  }
  return false;
}

static bool browser_window_owns_focus(Window browser_window) {
  Window focused = 0;
  int revert_to = 0;
  XGetInputFocus(display, &focused, &revert_to);
  return focused && focused != PointerRoot && window_is_descendant_of(focused, browser_window);
}

static bool begin_browser_input_guard(int64_t deadline_at) {
  last_guard_deadline = false;
  XGrabServer(display);
  XSync(display, False);
  if (active_timing.deadline_at != deadline_at || deadline_expired(&active_timing)) {
    last_guard_deadline = true;
    XUngrabServer(display);
    XFlush(display);
    return false;
  }
  Window root = RootWindow(display, DefaultScreen(display));
  Window browser_window = 0;
  if (find_direct_browser_windows(root, &browser_window) != 1 || !browser_window_owns_focus(browser_window)) {
    XUngrabServer(display);
    XFlush(display);
    return false;
  }
  if (deadline_expired(&active_timing)) {
    last_guard_deadline = true;
    XUngrabServer(display);
    XFlush(display);
    return false;
  }
  last_x_error = 0;
  return true;
}

static const char *guard_failure_error(void) {
  return last_guard_deadline ? "deadline_exceeded" : "focus_failed";
}

static bool end_browser_input_guard(void) {
  XSync(display, False);
  bool ok = last_x_error == 0;
  XUngrabServer(display);
  XFlush(display);
  return ok;
}

static bool focus_window(int64_t deadline_at) {
  last_guard_deadline = false;
  Window root = RootWindow(display, DefaultScreen(display));
  Window win = 0;
  unsigned int direct_matches = find_direct_browser_windows(root, &win);
  if (direct_matches != 1) return false;
  XGrabServer(display);
  XSync(display, False);
  if (active_timing.deadline_at != deadline_at || deadline_expired(&active_timing)) {
    last_guard_deadline = true;
    XUngrabServer(display);
    XFlush(display);
    return false;
  }
  direct_matches = find_direct_browser_windows(root, &win);
  if (direct_matches != 1) {
    XUngrabServer(display);
    XFlush(display);
    return false;
  }
  if (deadline_expired(&active_timing)) {
    last_guard_deadline = true;
    XUngrabServer(display);
    XFlush(display);
    return false;
  }
  last_x_error = 0;
  XRaiseWindow(display, win);
  XSetInputFocus(display, win, RevertToParent, CurrentTime);
  XSync(display, False);
  bool ok = last_x_error == 0 && browser_window_owns_focus(win);
  XUngrabServer(display);
  XFlush(display);
  return ok;
}

static void handle_line(const char *wire, FILE *out, bool *protocol_ready) {
  char id[MAX_ID] = "";
  char type[MAX_TYPE] = "";
  const char *line = NULL;
  CommandTiming timing;
  if (!parse_war2_line(wire, &line, &timing)) {
    respond(out, id, false, "invalid_protocol", held_key_count, held_button_count());
    return;
  }
  if (!get_json_string(line, "id", id, sizeof(id)) || !get_json_string(line, "type", type, sizeof(type))) {
    respond(out, id, false, "invalid_packet", held_key_count, held_button_count());
    return;
  }
  int64_t json_deadline = 0;
  if (!get_json_int64(line, "deadlineAt", &json_deadline) || json_deadline != timing.deadline_at) {
    respond(out, id, false, "invalid_deadline", held_key_count, held_button_count());
    return;
  }
  active_timing = timing;
  if (strcmp(type, "ping") == 0 || strcmp(type, "getState") == 0) {
    int protocol_version = 0;
    if (strcmp(type, "ping") == 0 && get_json_int(line, "protocol", &protocol_version) && protocol_version == 2) *protocol_ready = true;
    respond(out, id, true, NULL, held_key_count, held_button_count());
    return;
  }
  if (strcmp(type, "releaseAll") == 0) {
    release_all();
    respond(out, id, true, NULL, held_key_count, held_button_count());
    return;
  }
  if (!*protocol_ready) {
    respond(out, id, false, "invalid_protocol", held_key_count, held_button_count());
    return;
  }
  if (deadline_expired(&timing)) {
    respond(out, id, false, "deadline_exceeded", held_key_count, held_button_count());
    return;
  }
  if (strcmp(type, "focusWindow") == 0) {
    bool focused = focus_window(timing.deadline_at);
    const char *focus_error = last_guard_deadline ? "deadline_exceeded" : "focus_failed";
    respond(out, id, focused, focused ? NULL : focus_error, held_key_count, held_button_count());
    return;
  }
  if (strcmp(type, "mouseMove") == 0 || strcmp(type, "click") == 0) {
    int x, y;
    if (!get_json_int(line, "x", &x) || !get_json_int(line, "y", &y) || !valid_point(x, y)) {
      respond(out, id, false, "point_out_of_bounds", held_key_count, held_button_count());
      return;
    }
    if (!begin_browser_input_guard(timing.deadline_at)) {
      respond(out, id, false, guard_failure_error(), held_key_count, held_button_count());
      return;
    }
    if (!fake_motion(x, y)) {
      end_browser_input_guard();
      respond(out, id, false, "input_failed", held_key_count, held_button_count());
      return;
    }
    if (strcmp(type, "mouseMove") == 0) {
      respond(out, id, end_browser_input_guard(), "input_failed", held_key_count, held_button_count());
      return;
    }
  }
  if (strcmp(type, "click") == 0 || strcmp(type, "mouseDown") == 0 || strcmp(type, "mouseUp") == 0) {
    char button_name[16] = "";
    int count = 1;
    get_json_string(line, "button", button_name, sizeof(button_name));
    get_json_int(line, "count", &count);
    int button = button_number(button_name[0] ? button_name : "left");
    if (!button || count < 1 || count > 3) {
      if (strcmp(type, "click") == 0) end_browser_input_guard();
      respond(out, id, false, "invalid_button", held_key_count, held_button_count());
      return;
    }
    if (strcmp(type, "click") != 0 && !begin_browser_input_guard(timing.deadline_at)) {
      respond(out, id, false, guard_failure_error(), held_key_count, held_button_count());
      return;
    }
    if (strcmp(type, "click") == 0) {
      for (int i = 0; i < count; i++) {
        if (!fake_button(button, true) || !fake_button(button, false)) {
          end_browser_input_guard();
          respond(out, id, false, "input_failed", held_key_count, held_button_count());
          return;
        }
      }
    } else {
      bool down = strcmp(type, "mouseDown") == 0;
      if (!fake_button(button, down)) {
        end_browser_input_guard();
        respond(out, id, false, "input_failed", held_key_count, held_button_count());
        return;
      }
      held_buttons[button] = down ? 1 : 0;
    }
    respond(out, id, end_browser_input_guard(), "input_failed", held_key_count, held_button_count());
    return;
  }
  if (strcmp(type, "wheel") == 0) {
    int delta = 0;
    if (!get_json_int(line, "deltaY", &delta)) {
      respond(out, id, false, "invalid_delta", held_key_count, held_button_count());
      return;
    }
    if (!begin_browser_input_guard(timing.deadline_at)) {
      respond(out, id, false, guard_failure_error(), held_key_count, held_button_count());
      return;
    }
    int button = delta > 0 ? 5 : 4;
    int clicks = abs(delta) / 120;
    if (clicks < 1) clicks = 1;
    if (clicks > 20) clicks = 20;
    for (int i = 0; i < clicks; i++) {
      if (!fake_button(button, true) || !fake_button(button, false)) {
        end_browser_input_guard();
        respond(out, id, false, "input_failed", held_key_count, held_button_count());
        return;
      }
    }
    respond(out, id, end_browser_input_guard(), "input_failed", held_key_count, held_button_count());
    return;
  }
  if (strcmp(type, "keyDown") == 0 || strcmp(type, "keyUp") == 0) {
    char key[64] = "";
    if (!get_json_string(line, "key", key, sizeof(key))) {
      respond(out, id, false, "invalid_key", held_key_count, held_button_count());
      return;
    }
    if (!begin_browser_input_guard(timing.deadline_at)) {
      respond(out, id, false, guard_failure_error(), held_key_count, held_button_count());
      return;
    }
    if (!fake_key(key, strcmp(type, "keyDown") == 0)) {
      end_browser_input_guard();
      respond(out, id, false, "invalid_key", held_key_count, held_button_count());
      return;
    }
    respond(out, id, end_browser_input_guard(), "input_failed", held_key_count, held_button_count());
    return;
  }
  if (strcmp(type, "insertText") == 0) {
    char text[MAX_TEXT + 1] = "";
    if (!get_json_string(line, "text", text, sizeof(text))) {
      respond(out, id, false, "invalid_text", held_key_count, held_button_count());
      return;
    }
    if (!begin_browser_input_guard(timing.deadline_at)) {
      respond(out, id, false, guard_failure_error(), held_key_count, held_button_count());
      return;
    }
    for (size_t i = 0; text[i]; i++) {
      if (!fake_text_char(text[i])) {
        end_browser_input_guard();
        respond(out, id, false, "unsupported_text", held_key_count, held_button_count());
        return;
      }
    }
    respond(out, id, end_browser_input_guard(), "input_failed", held_key_count, held_button_count());
    return;
  }
  if (strcmp(type, "shortcut") == 0) {
    char shortcut[96] = "";
    if (!get_json_string(line, "shortcut", shortcut, sizeof(shortcut))) {
      respond(out, id, false, "invalid_shortcut", held_key_count, held_button_count());
      return;
    }
    char copy[96];
    strncpy(copy, shortcut, sizeof(copy));
    copy[sizeof(copy) - 1] = '\0';
    char *parts[5];
    int count = 0;
    for (char *token = strtok(copy, "+"); token && count < 5; token = strtok(NULL, "+")) parts[count++] = token;
    if (count < 1 || count > 4) {
      respond(out, id, false, "invalid_shortcut", held_key_count, held_button_count());
      return;
    }
    if (!begin_browser_input_guard(timing.deadline_at)) {
      respond(out, id, false, guard_failure_error(), held_key_count, held_button_count());
      return;
    }
    for (int i = 0; i < count - 1; i++) {
      if (!fake_key(parts[i], true)) { release_all(); end_browser_input_guard(); respond(out, id, false, "input_failed", held_key_count, held_button_count()); return; }
    }
    if (!fake_key(parts[count - 1], true)) { release_all(); end_browser_input_guard(); respond(out, id, false, "input_failed", held_key_count, held_button_count()); return; }
    if (!fake_key(parts[count - 1], false)) { release_all(); end_browser_input_guard(); respond(out, id, false, "input_failed", held_key_count, held_button_count()); return; }
    for (int i = count - 2; i >= 0; i--) {
      if (!fake_key(parts[i], false)) { release_all(); end_browser_input_guard(); respond(out, id, false, "input_failed", held_key_count, held_button_count()); return; }
    }
    respond(out, id, end_browser_input_guard(), "input_failed", held_key_count, held_button_count());
    return;
  }
  respond(out, id, false, "unknown_type", held_key_count, held_button_count());
}

int main(int argc, char **argv) {
  const char *socket_path = argc > 1 ? argv[1] : "/run/war/x11-input.sock";
  signal(SIGTERM, on_signal);
  signal(SIGINT, on_signal);
  XSetErrorHandler(on_x_error);

  display = XOpenDisplay(NULL);
  if (!display) {
    fprintf(stderr, "war-x11-inputd: failed to open display\n");
    return 2;
  }
  int event_base, error_base, major, minor;
  if (!XTestQueryExtension(display, &event_base, &error_base, &major, &minor)) {
    fprintf(stderr, "war-x11-inputd: XTest extension unavailable\n");
    return 2;
  }
  screen_width = DisplayWidth(display, DefaultScreen(display));
  screen_height = DisplayHeight(display, DefaultScreen(display));

  char dir[256];
  strncpy(dir, socket_path, sizeof(dir));
  dir[sizeof(dir) - 1] = '\0';
  char *slash = strrchr(dir, '/');
  if (slash) {
    *slash = '\0';
    if (mkdir(dir, 0700) < 0 && errno != EEXIST) {
      perror("mkdir");
      return 2;
    }
    struct stat dir_stat;
    if (lstat(dir, &dir_stat) < 0 || !S_ISDIR(dir_stat.st_mode) || (dir_stat.st_mode & 0777) != 0700) {
      fprintf(stderr, "war-x11-inputd: unsafe socket directory\n");
      return 2;
    }
  }
  struct stat socket_stat;
  if (lstat(socket_path, &socket_stat) == 0) {
    if (!S_ISSOCK(socket_stat.st_mode)) {
      fprintf(stderr, "war-x11-inputd: refusing to unlink non-socket path\n");
      return 2;
    }
    unlink(socket_path);
  } else if (errno != ENOENT) {
    perror("lstat");
    return 2;
  }
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) {
    perror("socket");
    return 2;
  }
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, socket_path, sizeof(addr.sun_path) - 1);
  if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
    perror("bind");
    return 2;
  }
  chmod(socket_path, 0600);
  if (listen(fd, 4) < 0) {
    perror("listen");
    return 2;
  }
  fprintf(stderr, "war-x11-inputd: listening on %s\n", socket_path);

  while (running) {
    int client = accept(fd, NULL, NULL);
    if (client < 0) {
      if (errno == EINTR) continue;
      break;
    }
    FILE *in = fdopen(client, "r+");
    if (!in) {
      close(client);
      continue;
    }
    bool protocol_ready = false;
    char line[MAX_LINE + 2];
    while (running && fgets(line, sizeof(line), in)) {
      size_t len = strlen(line);
      if (len > MAX_LINE || (len && line[len - 1] != '\n')) {
        respond(in, "", false, "packet_too_large", held_key_count, held_button_count());
        int c;
        while ((c = fgetc(in)) != EOF && c != '\n') {}
        continue;
      }
      handle_line(line, in, &protocol_ready);
    }
    fclose(in);
  }
  release_all();
  close(fd);
  unlink(socket_path);
  XCloseDisplay(display);
  return 0;
}
