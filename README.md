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
