#define _DARWIN_C_SOURCE
#include <node_api.h>

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define MAX_SAFE_READ_BYTES (16U * 1024U * 1024U)

static napi_value throw_error(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message);
  return NULL;
}

static napi_value throw_file_error(napi_env env, int error_code, const char *message) {
  const char *code = NULL;
  switch (error_code) {
    case ENOENT: code = "ENOENT"; break;
    case ENOTDIR: code = "ENOTDIR"; break;
    case EISDIR: code = "EISDIR"; break;
    case ELOOP: code = "ELOOP"; break;
  }
  napi_throw_error(env, code, message);
  return NULL;
}

static char *read_string(napi_env env, napi_value value, size_t *out_length) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) {
    return NULL;
  }
  char *result = (char *)malloc(length + 1);
  if (result == NULL) {
    return NULL;
  }
  if (napi_get_value_string_utf8(env, value, result, length + 1, &length) != napi_ok) {
    free(result);
    return NULL;
  }
  *out_length = length;
  return result;
}

static void close_if_open(int fd) {
  if (fd >= 0) {
    (void)close(fd);
  }
}

static int path_is_within(const char *root_path, const char *file_path) {
  size_t root_length = strlen(root_path);
  while (root_length > 1 && root_path[root_length - 1] == '/') {
    root_length--;
  }
  if (root_length == 1 && root_path[0] == '/') {
    return file_path[0] == '/';
  }
  return strncmp(root_path, file_path, root_length) == 0 &&
         (file_path[root_length] == '\0' || file_path[root_length] == '/');
}

static int open_workspace_directory(const char *workspace_path) {
  if (workspace_path[0] != '/') {
    return -1;
  }

  int directory_fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (directory_fd < 0) {
    return -1;
  }

  char *components = strdup(workspace_path + 1);
  if (components == NULL) {
    close_if_open(directory_fd);
    return -1;
  }

  if (components[0] == '\0') {
    free(components);
    return directory_fd;
  }

  char *cursor = components;
  for (;;) {
    char *separator = strchr(cursor, '/');
    if (separator != NULL) {
      *separator = '\0';
    }
    if (cursor[0] == '\0' || strcmp(cursor, ".") == 0 || strcmp(cursor, "..") == 0) {
      close_if_open(directory_fd);
      free(components);
      return -1;
    }

    int next_fd = openat(directory_fd, cursor,
                         O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (next_fd < 0) {
      close_if_open(directory_fd);
      free(components);
      return -1;
    }
    close_if_open(directory_fd);
    directory_fd = next_fd;
    if (separator == NULL) {
      break;
    }
    cursor = separator + 1;
  }

  free(components);
  return directory_fd;
}

static napi_value read_workspace_file(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 3) {
    return throw_error(env, "Expected workspace path, relative file path, and byte limit.");
  }

  bool allow_prefix = false;
  if (argc == 4 && napi_get_value_bool(env, argv[3], &allow_prefix) != napi_ok) {
    return throw_error(env, "Invalid secure file reader arguments.");
  }

  size_t workspace_path_length = 0;
  size_t relative_path_length = 0;
  char *workspace_path = read_string(env, argv[0], &workspace_path_length);
  char *relative_path = read_string(env, argv[1], &relative_path_length);
  double max_bytes_value = 0;
  if (workspace_path == NULL || relative_path == NULL ||
      napi_get_value_double(env, argv[2], &max_bytes_value) != napi_ok ||
      !isfinite(max_bytes_value) || max_bytes_value < 0 ||
      max_bytes_value > MAX_SAFE_READ_BYTES || max_bytes_value > UINT32_MAX - 1 ||
      (double)(uint32_t)max_bytes_value != max_bytes_value) {
    free(workspace_path);
    free(relative_path);
    return throw_error(env, "Invalid secure file reader arguments.");
  }
  uint32_t max_bytes = (uint32_t)max_bytes_value;

  if (memchr(workspace_path, '\0', workspace_path_length) != NULL ||
      memchr(relative_path, '\0', relative_path_length) != NULL) {
    free(workspace_path);
    free(relative_path);
    return throw_error(env, "File paths cannot contain null bytes.");
  }

  if (relative_path[0] == '/' || relative_path[0] == '\0') {
    free(workspace_path);
    free(relative_path);
    return throw_error(env, "The selected file path is not relative to the workspace.");
  }

  int root_fd = open_workspace_directory(workspace_path);
  if (root_fd < 0) {
    free(workspace_path);
    free(relative_path);
    return throw_error(env, "Unable to open the workspace folder safely.");
  }
  int directory_fd = dup(root_fd);
  if (directory_fd < 0) {
    close_if_open(root_fd);
    free(workspace_path);
    free(relative_path);
    return throw_error(env, "Unable to duplicate the workspace folder handle.");
  }

  int file_fd = -1;
  int file_open_error = 0;
  char *cursor = relative_path;
  for (;;) {
    char *separator = strchr(cursor, '/');
    if (separator != NULL) {
      *separator = '\0';
    }
    if (cursor[0] == '\0' || strcmp(cursor, ".") == 0 || strcmp(cursor, "..") == 0) {
      close_if_open(directory_fd);
      close_if_open(root_fd);
      free(workspace_path);
      free(relative_path);
      return throw_error(env, "The selected file path contains an unsafe component.");
    }

    if (separator == NULL) {
      file_fd = openat(directory_fd, cursor,
                       O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
      if (file_fd < 0) {
        file_open_error = errno;
      }
      break;
    }

    int next_fd = openat(directory_fd, cursor,
                         O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (next_fd < 0) {
      int open_error = errno;
      close_if_open(directory_fd);
      close_if_open(root_fd);
      free(workspace_path);
      free(relative_path);
      return throw_file_error(env, open_error, "The selected file path cannot be traversed safely.");
    }
    close_if_open(directory_fd);
    directory_fd = next_fd;
    cursor = separator + 1;
  }

  close_if_open(directory_fd);
  free(workspace_path);
  free(relative_path);
  if (file_fd < 0) {
    close_if_open(root_fd);
    return throw_file_error(env, file_open_error, "The selected file cannot be opened safely.");
  }

  struct stat file_stat;
  if (fstat(file_fd, &file_stat) != 0) {
    close_if_open(file_fd);
    close_if_open(root_fd);
    return throw_error(env, "Unable to inspect the selected file safely.");
  }
  if (!S_ISREG(file_stat.st_mode)) {
    close_if_open(file_fd);
    close_if_open(root_fd);
    return throw_file_error(env, EISDIR, "Only regular files can be read.");
  }
  if (!allow_prefix && file_stat.st_size > (off_t)max_bytes) {
    close_if_open(file_fd);
    close_if_open(root_fd);
    return throw_error(env, "The selected file exceeds the configured byte limit.");
  }

  size_t capacity = (size_t)max_bytes + 1;
  uint8_t *buffer = (uint8_t *)malloc(capacity == 0 ? 1 : capacity);
  if (buffer == NULL) {
    close_if_open(file_fd);
    close_if_open(root_fd);
    return throw_error(env, "Unable to allocate the secure file read buffer.");
  }

  char root_actual_path[PATH_MAX];
  char file_actual_path[PATH_MAX];
  if (fcntl(root_fd, F_GETPATH, root_actual_path) < 0 ||
      fcntl(file_fd, F_GETPATH, file_actual_path) < 0) {
    free(buffer);
    close_if_open(file_fd);
    close_if_open(root_fd);
    return throw_error(env, "Unable to verify the opened workspace file.");
  }
  if (!path_is_within(root_actual_path, file_actual_path)) {
    free(buffer);
    close_if_open(file_fd);
    close_if_open(root_fd);
    napi_throw_error(env, "OUTSIDE_WORKSPACE", "The opened file is no longer within the workspace path.");
    return NULL;
  }

  size_t total = 0;
  while (total < capacity) {
    ssize_t bytes_read = read(file_fd, buffer + total, capacity - total);
    if (bytes_read < 0 && errno == EINTR) {
      continue;
    }
    if (bytes_read < 0) {
      free(buffer);
      close_if_open(file_fd);
      close_if_open(root_fd);
      return throw_error(env, "Unable to read the selected file safely.");
    }
    if (bytes_read == 0) {
      break;
    }
    total += (size_t)bytes_read;
  }
  close_if_open(file_fd);
  close_if_open(root_fd);

  if (!allow_prefix && total > max_bytes) {
    free(buffer);
    return throw_error(env, "The selected file exceeds the configured byte limit.");
  }

  napi_value result;
  napi_status status = napi_create_buffer_copy(env, total, buffer, NULL, &result);
  free(buffer);
  if (status != napi_ok) {
    return throw_error(env, "Unable to return the selected file contents.");
  }
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "readWorkspaceFile", NAPI_AUTO_LENGTH,
                           read_workspace_file, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "readWorkspaceFile", function) != napi_ok) {
    return throw_error(env, "Unable to initialize the secure macOS file reader.");
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
