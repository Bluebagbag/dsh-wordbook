# Vocabulary Trainer · DSH Plugin

**English** | [中文](README.md)

A vocabulary trainer for the [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) web UI.

Most flashcard apps keep your words inside their own schedule. This plugin puts a small, scrollable **word rail** next to the chat: add words while you work, hide the definitions until you click, and let the built-in AI coach quiz you in context.

## Features

- **Sidebar word rail**: numbered words, IPA, review status, and a hidden Chinese definition that appears on click. It scrolls like a roll of paper and can collapse into a thin handle.
- **Add words quickly**: one word per line (`apple`, `look forward to`, or `apple 苹果`). Chinese meanings and IPA are filled in automatically; duplicates are merged.
- **Spaced repetition**: an Ebbinghaus-style ladder from 10 minutes to 90 days. Rate a word **Remembered** to move it up, or **Forgot** to reset it.
- **AI vocabulary coach**: active recall first, one or two words at a time, corrections that make you say it again. Quizzes are **English → Chinese fill-in**, never Chinese multiple choice.
- **Reading comprehension**: uses **all of today's Maimemo words** when available. Passage length scales with the word count, and the number of questions drops for long lists so every word fits.
- **Optional Maimemo sync (read-only)**: today's progress, daily words, study counts, and `STICKING` / `WELL_FAMILIAR` tags. The plugin never writes to your Maimemo account.


## Screenshots

| Word rail + AI coach | English → Chinese recall |
| --- | --- |
| ![Word rail and coach](docs/screenshots/word-rail.jpg) | ![English to Chinese recall](docs/screenshots/coach-chat.jpg) |

| Reading passage using today's words | Reading quiz with instant feedback |
| --- | --- |
| ![Reading passage](docs/screenshots/reading-passage.jpg) | ![Reading quiz](docs/screenshots/reading-quiz.jpg) |

## Plugins

| Directory | Purpose |
| --- | --- |
| `plugins/dsh-wordbook` | Main plugin: word rail, local word list, chat, reading quizzes (client + host) |
| `plugins/dsh-maimemo` | Read-only bridge to the Maimemo Open API |
| `plugins/dsh-reading` | Reading generator that scales the passage to the word count |

## Install

Requirements: a working DSH installation and a profile (default `~/.dsh/profiles/web`).

```bash
git clone https://github.com/Bluebagbag/dsh-wordbook.git
cd dsh-wordbook
bash install.sh
```

`install.sh` is idempotent. It:

1. links the three plugins into the profile's `node_modules/`;
2. adds `link:` dependencies to the profile's `package.json`;
3. appends the three loader rows to `cordis.patch.yml` (skips existing ones);
4. creates an empty `$DSH_HOME/maimemo/config.json` template (never overwrites an existing file).

Refresh the web UI once after installing. If the host half does not appear, restart `dsh` and refresh again.

## Maimemo setup (optional)

The plugin works without Maimemo, using the local word list and its own schedule.

1. Get a token from the MaiMemo app: **Me → More settings → Experimental features → Open API**, or log in at `https://open.maimemo.com/open/api/v1/tokens/openapi` (web tokens are valid for 7 days).
2. Write it to `$DSH_HOME/maimemo/config.json`:

```json
{
  "baseUrl": "https://open.maimemo.com/open/api/v1",
  "token": "YOUR_TOKEN"
}
```

3. Refresh the UI. A **Maimemo Today (墨墨今日)** tab appears in the word rail.

## Read-only guarantee

The Maimemo bridge only calls:

- `study/get_study_progress`
- `study/get_today_items`
- `study/query_study_records`
- `vocabulary/query`
- `interpretations` (read)
- `phrases` (read)

There are **no** calls to `add_words`, `advance_study`, or any endpoint that creates or edits notes, interpretations, phrases, or notepads. The chat model is called without tools, so it can only return text; it cannot change your learning data.

## Data locations

| Location | Contents |
| --- | --- |
| Browser `localStorage["dsh-wordbook:state:v1"]` | Local words, chat history, current reading quiz |
| `$DSH_HOME/wordbook/state.json` | Backup snapshot of the same state |
| `$DSH_HOME/maimemo/config.json` | Maimemo token (mode 600, never committed) |

## Development

```bash
node plugins/dsh-wordbook/test/smoke.mjs
node plugins/dsh-wordbook/test/render.mjs
```

- `smoke.mjs`: word parsing, state normalization, Ebbinghaus progression/reset, Maimemo stage rules.
- `render.mjs`: renders the panel with a minimal React stand-in and checks the word rail, today card, and hidden definitions.

## Known limitations

- Maimemo study endpoints are in public beta and occasionally return 503; the UI shows a retry button.
- Maimemo `interpretations` / `phrases` only return content **you created** in your own account, not the built-in dictionary. When they are empty, the plugin falls back to AI-generated meanings and examples.
- Reading passages are AI-generated and may occasionally be inaccurate.
- No accounts or cloud sync; data stays on your device.

## Issues

Please open an issue at <https://github.com/Bluebagbag/dsh-wordbook/issues>.

## License

MIT
