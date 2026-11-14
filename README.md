# Note Classifier

Quickly tag one or all of your notes with a predefined list of possible tags. Fast and efficient decisions models make it possible to run this classification locally on consumer hardware using ollama. For large-scale classification, consider using [https://typesafe.ai](Jev). Tags are written to frontmatter (`tags`) leaving other tags untouched.

## Setup

1. Install and enable the plugin in **Settings → Community plugins**.
2. Open **Settings → Note Classifier**. Enter one or more tags. A leading `#` is optional. Each saved tag has an optional description field: describe when the tag should or should not apply.
3. Choose a **Tag combination** policy:
   - **Exactly one**: write exactly one tag per file.
   - **Zero or more**: write zero or any number of tags per file.
   - **One or more**: write any number of tags per file.
4. Select which parts of each note the model receives: **File title**, **File frontmatter**, and/or **File content**. At least one must be enabled. Model context limits may cause a large file request to fail.
5. Choose a backend:
   - **Ollama (local)**: install [Ollama](https://ollama.com), run `ollama pull tev1`, and ensure the server is running at `http://localhost:11434`. The model name and base URL can be changed. Only decision models compatible with Ollama's `/v1/systemone` endpoint work; ordinary chat models do not.
   - **TypeSafe (Jev)**: get an API key at [TypeSafe](https://console.typesafe.ai/keys) and enter it in the settings. Uses `jev-latest` via `https://api.typesafe.ai/v1/systemone`.

## Commands

- `Classify current file`: classify the currently opened note. This can overwrite existing auto generated tags
- `Classify all files` classify all Markdown files that do not yet have any of the configured tags in their frontmatter. Consider making a backup of your files beforehand.

## Privacy and costs

Only the selected note parts, tag names, and tag descriptions are sent to TypeSafe when you run a classification command. The TypeSafe API key is stored **unencrypted** in Obsidian plugin data (`data.json`); keep your vault configuration private. Only Markdown notes are modified. No note data is sent until you execute a command.

## Similar Projects

- https://github.com/goberomsu/obsidian-metadata-auto-classifier
- https://github.com/HyeonseoNam/auto-classifier uses classical 
