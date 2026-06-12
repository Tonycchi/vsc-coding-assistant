# Architecture Summary

The project starts as a VS Code extension-only application.

Keep business logic out of VS Code integration code. Prefer small modules under `src/chat`, `src/context`, `src/models`, `src/services`, `src/types`, and `src/utils`.

A backend should only be introduced after tool calling, persistent memory, RAG, or agent workflows make extension-only orchestration difficult to maintain.
