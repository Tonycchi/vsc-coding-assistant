# Secure file attachment reads

## Status

Accepted

## Context

Workspace URI membership and symbolic-link checks can race with a later file read. VS Code's public filesystem API exposes separate `stat` and `readFile` calls, but no atomic open or file-handle operation. Node's portable filesystem API also does not expose descriptor-relative traversal. The extension can use Linux `/proc/self/fd` for opened-handle validation, and a small Node-API helper can use macOS `openat` traversal. Windows support would require native handle and reparse-point operations that are not implemented.

## Decision

Read local file attachments on Linux by opening the file, resolving the opened descriptor through `/proc/self/fd`, verifying its canonical path remains within the workspace, and reading a bounded number of bytes from that same descriptor. On macOS, bundle a universal arm64/x64 Node-API reader that opens the workspace directory and traverses each relative path component with `openat` and `O_NOFOLLOW`. Immediately before reading, it checks the current paths of the held workspace and file descriptors with `F_GETPATH`, verifies logical containment, and reads a bounded number of bytes from that same final descriptor. Reject attachments on Windows, virtual or remote filesystems, and whenever verification or native loading fails.

## Consequences

- A path replacement that redirects an attachment outside the workspace is rejected before file contents are read.
- Descriptor-relative traversal pins the opened object so later symlink replacement cannot redirect the read. The current-path check records logical containment immediately before reading; a rename after that check does not retarget the descriptor, but this is not a filesystem snapshot guarantee.
- The macOS VSIX targets must be built on macOS with Xcode Command Line Tools so their native reader is included. The `vscode:prepublish` hook performs the build and fails closed when the native build is unavailable; `npm run package:macos` creates arm64 and x64 target packages.
- Attachments remain unavailable on Windows, remote workspaces, and virtual filesystems until a safe file-handle strategy is available for those environments.
- Linux environments without usable `/proc/self/fd` also fail closed.
