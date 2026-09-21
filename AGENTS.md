# AI Coding Assistant

## Goal

Build a practical AI coding assistant that evolves from:

Chat Assistant
→ Context-Aware Assistant
→ Tool-Using Assistant
→ Memory-Aware Assistant
→ RAG Assistant
→ Agentic Coding Assistant

Focus on usefulness, maintainability, and learning.

---

## Required Reading

Before significant changes read:

- docs/roadmap.md
- docs/architecture.md
- memory/conventions.md
- memory/decisions.md

---

## Engineering Principles

Follow:

- KISS
- YAGNI
- DRY
- SRP
- Composition over inheritance
- Dependency injection

Prefer small focused modules.

Avoid speculative abstractions.

---

## Workflow

For non-trivial work:

1. Use planner skill
2. Implement
3. Use cleanup skill
4. Use docs-updater skill

---

## Testing

Test business logic.

Prioritize testing:

- tools
- memory
- routing
- prompt construction

Avoid testing LLM outputs directly.
