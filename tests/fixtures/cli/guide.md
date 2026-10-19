---
title: Getting Started Guide
tags: [docs, tutorial]
---

# Getting Started

[![Build](https://img.shields.io/badge/build-passing-green.svg)](https://ci.example.com) [![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

This guide shows you how to **install the tool**, run your *first* translation,
and keep everything on your own machine. See the [FAQ](docs/faq.md "Frequently asked") for details.

Setext Heading Example
======================

## Installation ##

1. Download the model with `scripts/download-model.sh`.
2. Start the service:
   it listens on `127.0.0.1` only.
3. Open the [settings page][settings] and paste the key.

- [ ] Write the first draft
- [x] Review the ~~old~~ new wording
  - Nested items keep their indent.
  - Use _italic_ or __bold__ freely, but not in snake_case_names.

```bash
# Comments inside code stay in English.
npm install
npm run build
```

~~~
Tilde fences are code too.
~~~

    Indented code is left alone.
    So is this line.

> **Note:** Quotes are translated line by line.
> They can span several lines.
>
> - Lists inside quotes work as well.

<p align="center">
  <img src="docs/logo.png" alt="Logo">
</p>

<!-- This comment
spans two lines. -->

Press <kbd>Ctrl</kbd> + <kbd>C</kbd> to stop the server.

| Option | Default | Meaning |
|:-------|:-------:|--------:|
| `--to` | zh | Target language |
| `--force` | off | Overwrite the output \| even if it exists |
| 42 | 100 | 3.14 |

***

Footnotes are kept as they are.[^1]

Term
: Definition lists are rare, so they stay in English.

- [Home](index.md) | [Docs](docs/index.md)

Contact <support@example.com> or visit <https://example.com>.

[settings]: https://example.com/settings "Settings"
[^1]: The footnote text is not translated.
