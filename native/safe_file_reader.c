#define _DARWIN_C_SOURCE
#include <node_api.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <sys/xattr.h>
#include <unistd.h>

#define MAX_SAFE_READ_BYTES (16U * 1024U * 1024U)
#define MAX_SAFE_DIRECTORY_ENTRIES 20000U
#define MAX_SAFE_EDIT_BYTES 100000U

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

/* Takes ownership of directory_fd and consumes the mutable path components. */
static int open_directory_components(int directory_fd, char *components) {
  if (components[0] == '\0') {
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
      return -1;
    }

    int next_fd = openat(directory_fd, cursor,
                         O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    close_if_open(directory_fd);
    if (next_fd < 0 || separator == NULL) {
      return next_fd;
    }
    directory_fd = next_fd;
    cursor = separator + 1;
  }
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
  int workspace_fd = open_directory_components(directory_fd, components);
  free(components);
  return workspace_fd;
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

static napi_value read_workspace_directory(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 3) {
    return throw_error(env, "Expected workspace path, relative directory, and entry limit.");
  }

  size_t root_length = 0;
  size_t relative_length = 0;
  char *workspace_path = read_string(env, argv[0], &root_length);
  char *relative_path = read_string(env, argv[1], &relative_length);
  double limit = 0;
  if (workspace_path == NULL || relative_path == NULL ||
      memchr(workspace_path, '\0', root_length) != NULL ||
      memchr(relative_path, '\0', relative_length) != NULL ||
      napi_get_value_double(env, argv[2], &limit) != napi_ok ||
      !isfinite(limit) || limit < 0 || limit > MAX_SAFE_DIRECTORY_ENTRIES ||
      (double)(uint32_t)limit != limit) {
    free(workspace_path);
    free(relative_path);
    return throw_error(env, "Invalid secure directory reader arguments.");
  }

  int root_fd = open_workspace_directory(workspace_path);
  free(workspace_path);
  int directory_fd = root_fd >= 0 ? dup(root_fd) : -1;
  if (directory_fd >= 0) {
    directory_fd = open_directory_components(directory_fd, relative_path);
  }
  free(relative_path);
  if (directory_fd < 0) {
    close_if_open(root_fd);
    return throw_error(env, "Unable to open the workspace directory safely.");
  }

  char root_actual_path[PATH_MAX];
  char directory_actual_path[PATH_MAX];
  if (fcntl(root_fd, F_GETPATH, root_actual_path) < 0 ||
      fcntl(directory_fd, F_GETPATH, directory_actual_path) < 0 ||
      !path_is_within(root_actual_path, directory_actual_path)) {
    close_if_open(directory_fd);
    close_if_open(root_fd);
    return throw_error(env, "Unable to verify the opened workspace directory.");
  }

  DIR *directory = fdopendir(directory_fd);
  if (directory == NULL) {
    close_if_open(directory_fd);
    close_if_open(root_fd);
    return throw_error(env, "Unable to enumerate the opened workspace directory.");
  }

  napi_value result;
  if (napi_create_array(env, &result) != napi_ok) {
    (void)closedir(directory);
    close_if_open(root_fd);
    return throw_error(env, "Unable to initialize the directory listing.");
  }

  bool failed = false;
  uint32_t count = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (entry == NULL) {
      failed = errno != 0;
      break;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
      continue;
    }
    if (count == (uint32_t)limit) {
      // Discard oversized listings so provider iteration order cannot change results.
      failed = napi_get_undefined(env, &result) != napi_ok;
      break;
    }

    const char *kind = entry->d_type == DT_REG ? "file" :
                       entry->d_type == DT_DIR ? "directory" : "unsupported";
    napi_value item, name, type;
    if (napi_create_object(env, &item) != napi_ok ||
        napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &name) != napi_ok ||
        napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &type) != napi_ok ||
        napi_set_named_property(env, item, "name", name) != napi_ok ||
        napi_set_named_property(env, item, "kind", type) != napi_ok ||
        napi_set_element(env, result, count, item) != napi_ok) {
      failed = true;
      break;
    }
    count++;
  }
  (void)closedir(directory);
  close_if_open(root_fd);

  return failed ? throw_error(env, "Unable to enumerate the workspace directory safely.") : result;
}

static bool same_entry(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

static bool contains_git_component(const char *path) {
  const char *component = path;
  while (*component != '\0') {
    const char *end = strchr(component, '/');
    size_t length = end == NULL ? strlen(component) : (size_t)(end - component);
    if (length == 4 && strncasecmp(component, ".git", length) == 0) {
      return true;
    }
    if (end == NULL) {
      return false;
    }
    component = end + 1;
  }
  return false;
}

static bool same_file_state(const struct stat *left, const struct stat *right) {
  return same_entry(left, right) && left->st_size == right->st_size &&
         left->st_mtimespec.tv_sec == right->st_mtimespec.tv_sec &&
         left->st_mtimespec.tv_nsec == right->st_mtimespec.tv_nsec &&
         left->st_ctimespec.tv_sec == right->st_ctimespec.tv_sec &&
         left->st_ctimespec.tv_nsec == right->st_ctimespec.tv_nsec;
}

struct edit_metadata {
  char provenance[128];
  size_t provenance_length;
};

static bool read_edit_metadata(int fd, const struct stat *file, struct edit_metadata *metadata) {
  if (file->st_flags != 0) {
    return false;
  }

  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (acl != NULL) {
    (void)acl_free(acl);
    return false;
  }
  // Darwin reports ENOENT when the open descriptor has no extended ACL.
  if (errno != ENOENT) {
    return false;
  }

  static const char provenance_name[] = "com.apple.provenance";
  char attributes[sizeof(provenance_name)];
  ssize_t length = flistxattr(fd, attributes, sizeof(attributes), 0);
  if (length == 0) {
    metadata->provenance_length = 0;
    return true;
  }
  // macOS may attach provenance to new files automatically. All other attributes
  // are rejected, and provenance on an existing file must match the staged file.
  if (length != sizeof(provenance_name) || memcmp(attributes, provenance_name, sizeof(attributes)) != 0) {
    return false;
  }
  ssize_t size = fgetxattr(fd, provenance_name, metadata->provenance, sizeof(metadata->provenance), 0, 0);
  if (size <= 0 || (size_t)size > sizeof(metadata->provenance)) {
    return false;
  }
  metadata->provenance_length = (size_t)size;
  return true;
}

static bool verify_edit_directories(int root_fd, int parent_fd, const char *root,
                                    const char *parent, uint64_t device, uint64_t inode) {
  struct stat root_stat;
  char root_path[PATH_MAX], parent_path[PATH_MAX];
  return fstat(root_fd, &root_stat) == 0 && (uint64_t)root_stat.st_dev == device &&
         (uint64_t)root_stat.st_ino == inode && fcntl(root_fd, F_GETPATH, root_path) == 0 &&
         fcntl(parent_fd, F_GETPATH, parent_path) == 0 && strcmp(root_path, root) == 0 &&
         strcmp(parent_path, parent) == 0;
}

/* 1 means the exact approved bytes still exist, 0 means stale, -1 means unreadable. */
static int match_approved_bytes(int parent_fd, const char *name, const char *expected_file,
                                const uint8_t *before, size_t length, struct stat *matched,
                                struct edit_metadata *metadata) {
  int fd = openat(parent_fd, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (fd < 0) {
    return errno == ENOENT || errno == ELOOP ? 0 : -1;
  }

  int result = -1;
  struct stat initial;
  if (fstat(fd, &initial) != 0) {
    goto close_file;
  }
  if (!S_ISREG(initial.st_mode) || initial.st_size != (off_t)length) {
    result = 0;
    goto close_file;
  }
  if ((initial.st_mode & S_IWUSR) == 0 || (initial.st_mode & 07000) != 0 || initial.st_nlink != 1 ||
      !read_edit_metadata(fd, &initial, metadata)) {
    goto close_file;
  }
  char actual_file[PATH_MAX];
  if (fcntl(fd, F_GETPATH, actual_file) != 0 || strcmp(actual_file, expected_file) != 0) {
    goto close_file;
  }

  size_t offset = 0;
  uint8_t buffer[4096];
  while (offset < length) {
    size_t remaining = length - offset;
    ssize_t count = read(fd, buffer, remaining < sizeof(buffer) ? remaining : sizeof(buffer));
    if (count < 0 && errno == EINTR) {
      continue;
    }
    if (count < 0) {
      goto close_file;
    }
    if (count == 0 || memcmp(buffer, before + offset, (size_t)count) != 0) {
      result = 0;
      goto close_file;
    }
    offset += (size_t)count;
  }
  if (fstat(fd, matched) == 0) {
    result = same_file_state(&initial, matched) ? 1 : 0;
  }

close_file:
  close_if_open(fd);
  return result;
}

static bool write_edit_bytes(int fd, const uint8_t *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(fd, bytes + offset, length - offset);
    if (count < 0 && errno == EINTR) {
      continue;
    }
    if (count <= 0) {
      return false;
    }
    offset += (size_t)count;
  }
  return true;
}

static napi_value apply_workspace_file(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value argv[6];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 6) {
    return throw_error(env, "Expected workspace identity, relative path, and approved bytes.");
  }

  size_t root_length = 0, relative_length = 0, before_length = 0, after_length = 0;
  char *root_path = read_string(env, argv[0], &root_length);
  char *relative = read_string(env, argv[3], &relative_length);
  void *before = NULL, *after = NULL;
  napi_valuetype before_type;
  uint64_t root_device = 0, root_inode = 0;
  bool lossless = false;
  if (root_path == NULL || relative == NULL || relative[0] == '/' || relative[0] == '\0' ||
      memchr(root_path, '\0', root_length) != NULL || memchr(relative, '\0', relative_length) != NULL ||
      contains_git_component(root_path) || contains_git_component(relative) ||
      napi_get_value_bigint_uint64(env, argv[1], &root_device, &lossless) != napi_ok || !lossless ||
      napi_get_value_bigint_uint64(env, argv[2], &root_inode, &lossless) != napi_ok || !lossless ||
      napi_typeof(env, argv[4], &before_type) != napi_ok ||
      (before_type != napi_null && napi_get_buffer_info(env, argv[4], &before, &before_length) != napi_ok) ||
      napi_get_buffer_info(env, argv[5], &after, &after_length) != napi_ok ||
      before_length > MAX_SAFE_EDIT_BYTES || after_length > MAX_SAFE_EDIT_BYTES) {
    free(root_path);
    free(relative);
    return throw_error(env, "Invalid approved workspace edit arguments.");
  }

  int root_fd = -1, parent_fd = -1, staged_fd = -1;
  char staged_name[80];
  const char *result = NULL;
  const char *parent_components = "";
  char *name = strrchr(relative, '/');
  if (name != NULL) {
    *name++ = '\0';
    if (relative[0] == '\0') {
      goto cleanup;
    }
    parent_components = relative;
  } else {
    name = relative;
  }
  if (name[0] == '\0' || strcmp(name, ".") == 0 || strcmp(name, "..") == 0) {
    goto cleanup;
  }

  char expected_parent[PATH_MAX];
  int parent_length = parent_components[0] == '\0'
      ? snprintf(expected_parent, sizeof(expected_parent), "%s", root_path)
      : snprintf(expected_parent, sizeof(expected_parent), "%s%s%s", root_path,
                 strcmp(root_path, "/") == 0 ? "" : "/", parent_components);
  if (parent_length < 0 || (size_t)parent_length >= sizeof(expected_parent)) {
    goto cleanup;
  }
  char expected_file[PATH_MAX];
  int file_length = snprintf(expected_file, sizeof(expected_file), "%s%s%s", expected_parent,
                             strcmp(expected_parent, "/") == 0 ? "" : "/", name);
  if (file_length < 0 || (size_t)file_length >= sizeof(expected_file)) {
    goto cleanup;
  }

  root_fd = open_workspace_directory(root_path);
  parent_fd = root_fd >= 0 ? dup(root_fd) : -1;
  if (parent_fd >= 0 && parent_components[0] != '\0') {
    parent_fd = open_directory_components(parent_fd, relative);
  }
  if (parent_fd < 0 || !verify_edit_directories(root_fd, parent_fd, root_path, expected_parent,
                                                root_device, root_inode)) {
    goto cleanup;
  }

  uint64_t random_parts[2];
  arc4random_buf(random_parts, sizeof(random_parts));
  (void)snprintf(staged_name, sizeof(staged_name), ".coding-assistant-edit-%016llx%016llx",
                 (unsigned long long)random_parts[0], (unsigned long long)random_parts[1]);
  staged_fd = openat(parent_fd, staged_name,
                     O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  struct stat staged;
  struct edit_metadata staged_metadata;
  if (staged_fd < 0 || fstat(staged_fd, &staged) != 0 ||
      !read_edit_metadata(staged_fd, &staged, &staged_metadata) ||
      !write_edit_bytes(staged_fd, after, after_length) ||
      !verify_edit_directories(root_fd, parent_fd, root_path, expected_parent, root_device, root_inode)) {
    goto cleanup;
  }

  bool create = before_type == napi_null;
  struct stat matched;
  struct edit_metadata matched_metadata = {0};
  if (!create) {
    int match = match_approved_bytes(parent_fd, name, expected_file, before, before_length,
                                     &matched, &matched_metadata);
    if (match == 0) {
      result = "stale";
      goto cleanup;
    }
    struct stat staged_owner;
    if (match < 0 || fstat(staged_fd, &staged_owner) != 0 ||
        staged_owner.st_uid != matched.st_uid || staged_owner.st_gid != matched.st_gid ||
        fchmod(staged_fd, matched.st_mode & 0777) != 0) {
      goto cleanup;
    }
  }

  struct stat current_staged;
  if (fsync(staged_fd) != 0 || fstat(staged_fd, &staged) != 0 ||
      !read_edit_metadata(staged_fd, &staged, &staged_metadata) ||
      (matched_metadata.provenance_length != 0 &&
       (matched_metadata.provenance_length != staged_metadata.provenance_length ||
        memcmp(matched_metadata.provenance, staged_metadata.provenance,
               matched_metadata.provenance_length) != 0)) ||
      !verify_edit_directories(root_fd, parent_fd, root_path, expected_parent, root_device, root_inode) ||
      fstatat(parent_fd, staged_name, &current_staged, AT_SYMLINK_NOFOLLOW) != 0 ||
      !same_file_state(&staged, &current_staged)) {
    goto cleanup;
  }

  if (create) {
    if (renameatx_np(parent_fd, staged_name, parent_fd, name, RENAME_EXCL) == 0) {
      result = "applied";
    } else if (errno == EEXIST) {
      result = "stale";
    }
  } else {
    struct stat current;
    int inspected = fstatat(parent_fd, name, &current, AT_SYMLINK_NOFOLLOW);
    if ((inspected < 0 && errno == ENOENT) || (inspected == 0 && !same_file_state(&matched, &current))) {
      result = "stale";
    } else if (inspected == 0 && renameat(parent_fd, staged_name, parent_fd, name) == 0) {
      result = "applied";
    }
  }

cleanup:
  if (staged_fd >= 0) {
    struct stat staged, current;
    if (fstat(staged_fd, &staged) == 0 &&
        fstatat(parent_fd, staged_name, &current, AT_SYMLINK_NOFOLLOW) == 0 &&
        same_entry(&staged, &current)) {
      (void)unlinkat(parent_fd, staged_name, 0);
    }
  }
  close_if_open(staged_fd);
  close_if_open(parent_fd);
  close_if_open(root_fd);
  free(root_path);
  free(relative);
  if (result == NULL) {
    return throw_error(env, "Unable to apply the approved workspace edit safely.");
  }

  napi_value status;
  return napi_create_string_utf8(env, result, NAPI_AUTO_LENGTH, &status) == napi_ok
      ? status : NULL;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "readWorkspaceFile", NAPI_AUTO_LENGTH,
                           read_workspace_file, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "readWorkspaceFile", function) != napi_ok ||
      napi_create_function(env, "readWorkspaceDirectory", NAPI_AUTO_LENGTH,
                           read_workspace_directory, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "readWorkspaceDirectory", function) != napi_ok ||
      napi_create_function(env, "applyWorkspaceFile", NAPI_AUTO_LENGTH,
                           apply_workspace_file, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "applyWorkspaceFile", function) != napi_ok) {
    return throw_error(env, "Unable to initialize the secure macOS file reader.");
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
