---
title: Getting Started Guide
tags: [docs, tutorial]
---

# 【译】Getting Started

[![Build](https://img.shields.io/badge/build-passing-green.svg)](https://ci.example.com) [![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

【译】This guide shows you how to **install the tool**, run your *first* translation, and keep everything on your own machine. See the [FAQ](docs/faq.md "Frequently asked") for details.

【译】Setext Heading Example
======================

## 【译】Installation ##

1. 【译】Download the model with `scripts/download-model.sh`.
2. 【译】Start the service: it listens on `127.0.0.1` only.
3. 【译】Open the [settings page][settings] and paste the key.

- [ ] 【译】Write the first draft
- [x] 【译】Review the ~~old~~ new wording
  - 【译】Nested items keep their indent.
  - 【译】Use _italic_ or __bold__ freely, but not in snake_case_names.

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

> 【译】**Note:** Quotes are translated line by line. They can span several lines.
>
> - 【译】Lists inside quotes work as well.

<p align="center">
  <img src="docs/logo.png" alt="Logo">
</p>

<!-- This comment
spans two lines. -->

【译】Press <kbd>Ctrl</kbd> + <kbd>C</kbd> to stop the server.

| 【译】Option | 【译】Default | 【译】Meaning |
|:-------|:-------:|--------:|
| `--to` | 【译】zh | 【译】Target language |
| `--force` | 【译】off | 【译】Overwrite the output \| even if it exists |
| 42 | 100 | 3.14 |

***

【译】Footnotes are kept as they are.[^1]

Term
: Definition lists are rare, so they stay in English.

- [Home](index.md) | [Docs](docs/index.md)

【译】Contact <support@example.com> or visit <https://example.com>.

[settings]: https://example.com/settings "Settings"
[^1]: The footnote text is not translated.
