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

Secure workspace file attachments are supported on Linux and macOS for local `file:` URIs. The macOS extension package includes a universal arm64/x64 native reader. On Windows, remote workspaces, and virtual filesystems, attachment fails closed because the available APIs cannot verify the opened file's workspace boundary safely. Build both macOS VSIX targets on a Mac with Xcode Command Line Tools by running `npm run package:macos`.

Before committing any code, please run the formatter and linter via

```shell
npm run format-and-lint
```

This ensures that you're code always follows the coding standards. This repository will also run it for you in case you forget it when committing, and on PR there will be a CI that ensures that merged code will always be in the correct form.
