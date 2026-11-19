# Secure file attachment reads

## Status

Accepted

## Context

Workspace URI membership and symbolic-link checks can race with a later file read. VS Code's public filesystem API exposes separate `stat` and `readFile` calls, but no atomic open or file-handle operation. Node's portable filesystem API also does not expose descriptor-relative traversal. Platform-specific native helpers could close this gap on macOS and Windows, but this extension has no native build or packaging infrastructure.

## Decision

Read local file attachments only on Linux, where the extension can open the file, resolve the opened descriptor through `/proc/self/fd`, verify the canonical target is within the canonical workspace folder, then read from that same descriptor. Reject attachments on macOS, Windows, virtual filesystems, and whenever descriptor verification fails.

## Consequences

- A path replacement that redirects an attachment outside the workspace is rejected before file contents are read.
- Attachments are unavailable on macOS, Windows, remote workspaces, and virtual filesystems until a maintainable safe file-handle strategy is available for those environments.
- Linux environments without usable `/proc/self/fd` also fail closed.
