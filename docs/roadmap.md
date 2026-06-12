# AI Coding Assistant Roadmap

## Vision

Build a practical AI coding assistant for daily software development.

The assistant should eventually provide capabilities similar to Cursor and Claude Code while remaining:

- Fully self-hostable
- Free to operate where possible
- Educational to build
- Modular and maintainable
- Useful for real-world coding

The project serves two goals:

1. Daily-use coding assistant
2. AI engineering learning platform

---

# Project Goals

## Functional Goals

The assistant should eventually support:

- Chat with codebase
- Context-aware conversations
- Repository exploration
- File reading
- File writing
- Project memory
- RAG knowledge retrieval
- Multi-step task execution
- Local and cloud model routing

---

## Learning Goals

Gain hands-on experience with:

- VS Code Extensions
- TypeScript
- FastAPI
- LLM APIs
- OpenRouter
- Ollama
- Tool Calling
- Agent Design
- RAG
- Vector Databases
- Memory Systems
- Prompt Engineering
- Docker

---

# Non Goals

The following are intentionally out of scope before v1.0:

- Autocomplete
- Fine-tuning models
- Training custom models
- Multi-agent systems
- Autonomous code execution
- Browser automation
- Microservices
- Kubernetes

---

# Engineering Principles

## KISS

Keep solutions simple.

Avoid unnecessary abstractions.

---

## YAGNI

Do not build infrastructure before it is needed.

---

## DRY

Avoid duplication when it becomes painful.

Do not over-abstract prematurely.

---

## SRP

Each class or module should have a single responsibility.

---

## Dependency Injection

Services should receive dependencies.

Avoid creating dependencies internally.

---

## Testability

Design for testing from the beginning.

---

# Development Workflow

```text
main
│
├── feature/chat-ui
├── feature/openrouter-client
├── feature/context-injection
├── feature/tool-system
├── feature/memory-system
└── feature/rag-system
```

Every feature:

1. Create task
2. Create feature branch
3. Implement
4. Write tests
5. Self review
6. Merge

---

# Kanban Workflow

```text
Backlog
   ↓
Ready
   ↓
In Progress
   ↓
Review
   ↓
Done
```

Task template:

- Goal
- Acceptance Criteria
- Technical Notes
- Test Strategy

---

# Phase 0 — Engineering Foundation

Goal:

Establish professional development practices.

Deliverables:

- Repository cleanup
- Husky
- Pre-commit hooks
- ESLint
- Formatting
- CI pipeline
- Testing framework
- ADR process
- Documentation structure

Acceptance Criteria:

- CI passes
- Lint passes
- Tests run automatically

Version:
v0.0

---

# Phase 1 — Chat Assistant

Goal:

Create the first usable assistant.

Features:

- VS Code sidebar
- Chat interface
- OpenRouter integration
- Streaming responses

Acceptance Criteria:

- User can chat with an LLM from VS Code

Version:
v0.1

---

# Phase 2 — Context Injection

Goal:

Enable code-aware conversations.

Features:

- Current file
- Selected text
- Manual file attachments
- Multi-file context

Acceptance Criteria:

- Assistant understands provided code

Version:
v0.2

---

# Phase 3 — Repository Exploration

Goal:

Allow autonomous code discovery.

Tools:

- read_file
- list_directory
- search_files
- search_text

Acceptance Criteria:

- Assistant can navigate repository

Version:
v0.3

---

# Phase 4 — Safe File Modification

Goal:

Allow code generation and modification.

Tools:

- create_file
- write_file
- apply_patch

Requirements:

- Diff preview
- User approval

Acceptance Criteria:

- Assistant can modify files safely

Version:
v0.4

---

# Phase 5 — Memory Foundation

Goal:

Persist important project knowledge.

Stored Information:

- Architecture decisions
- Coding conventions
- Project goals
- Development notes

Acceptance Criteria:

- Assistant remembers project context

Version:
v0.5

---

# Phase 6 — Architecture Evaluation + Local Models

Goal:

Evaluate whether the current extension-only architecture remains maintainable.

If complexity from memory, tools, and model orchestration becomes significant, begin backend extraction.

Features:

- Ollama integration
- Model routing
- Architecture review
- Optional backend extraction

Acceptance Criteria:

- Local model support works
- Architectural direction is documented

Version:
v0.6

---

# Phase 7 — RAG

Goal:

Scale understanding of larger codebases.

Features:

- Embeddings
- Vector storage
- Semantic retrieval

Acceptance Criteria:

- Assistant retrieves relevant documents automatically

Version:
v0.7

---

# Phase 8 — Agent Workflows

Goal:

Support multi-step coding tasks.

Capabilities:

- Planning
- Tool usage
- Iterative execution
- Patch generation

Acceptance Criteria:

- Agent completes multi-step repository tasks

Version:
v0.8

---

# Phase 9 — Production Readiness

Features:

- Session persistence
- Cost tracking
- Prompt templates
- Undo support
- Conversation search

Acceptance Criteria:

- Daily-driver usability

Version:
v1.0

---

# Success Metrics

The project is successful if:

## Phase 1

- Can answer coding questions from VS Code

## Phase 2

- Understands current file and selections

## Phase 3

- Can navigate repositories autonomously

## Phase 4

- Can safely modify code with approval

## Phase 5

- Retains project-specific knowledge

## Phase 6

- Supports both cloud and local models

## Phase 7

- Retrieves relevant information from large codebases

## Phase 8

- Completes multi-step coding tasks

---

# Success Definition

The project is successful when:

- It is used for personal coding projects.
- It reduces manual coding effort.
- It can understand and modify repositories.
- It serves as a portfolio-quality AI engineering project.
