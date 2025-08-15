# vsc-coding-assistant

![CI](https://github.com/Tonycchi/vsc-coding-assistant/actions/workflows/ci.yml/badge.svg)

## Description

This is a custom VS Code AI coding assistant similar like Github Copilot and Cursor, but only using free tools and models. It's just a private fun project, but should have a relatively professional workflow as hands-on practice.

## Usage

Clone the repository

```shell
git clone https://github.com/Tonycchi/vsc-coding-assistant.git
```

Before committing any code, please run the formatter and linter via

```shell
npm run format-and-lint
```

This ensures that you're code always follows the coding standards. This repository will also run it for you in case you forget it when committing, and on PR there will be a CI that ensures that merged code will always be in the correct form.
