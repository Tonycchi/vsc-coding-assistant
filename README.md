# vsc-coding-assistant

![CI](https://github.com/Tonycchi/vsc-coding-assistant/actions/workflows/ci.yaml/badge.svg)

## Description

This is a custom VS Code AI coding assistant similar like Github Copilot and Cursor, but only using free tools and models. It's just a private fun project, but should have a relatively professional workflow as hands-on practice.

## Usage

Clone the repository

```shell
git clone https://github.com/Tonycchi/vsc-coding-assistant.git
```

### Configure the extension

- Run **Configure Coding Assistant API Key** from the VS Code Command Palette. The API key is stored in VS Code SecretStorage.
- Set `vscCodingAssistant.model` in VS Code settings to an OpenRouter model identifier in `provider/model` format.

The extension checks that the key and model setting are present and structurally valid. OpenRouter reports whether the saved key or selected model is accepted when a request is sent.

### File attachments

Use **Attach files** in the chat sidebar to include workspace files in your message. Select the remove button beside a file to leave it out before sending.

Secure workspace file attachments are supported on Linux and macOS for local `file:` URIs. The macOS extension package includes a universal arm64/x64 native reader. On Windows, remote workspaces, and virtual filesystems, attachment fails closed because the available APIs cannot verify the opened file's workspace boundary safely. Build both macOS VSIX targets on a Mac with Xcode Command Line Tools by running `npm run package:macos`.

### Enable repository tools

Set `vscCodingAssistant.enableRepositoryTools` in your user settings if your OpenRouter
model supports tool calling. The assistant can request read-only workspace context in trusted
workspaces, and tool results are sent to the configured model provider. When multiple folders
are open, open a file in the folder you want to use.

## Development and tests

Use Node.js 22.18.0 (the repository pins this version with Volta), then install the locked dependencies:

```shell
npm ci
```

Run the test suite and TypeScript checks with:

```shell
npm test -- --runInBand
npm run type-check
```

Before committing, run the formatter and linter:

```shell
npm run format-and-lint
```

The pre-commit hook runs `lint-staged` on staged files. Pull requests also run the repository CI checks.
