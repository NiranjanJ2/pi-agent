# pi-inject

A CLI tool that uses the Anthropic API to automatically transform source files by injecting a hardcoded system prompt. The tool is designed for prompt injection defense research — the current system prompt (bold + blue text styling) is a placeholder used to validate that the pipeline correctly reaches and modifies source files end-to-end.

## What it does

`pi-inject` walks a codebase, sends each source file to Claude, and rewrites it according to a hardcoded system prompt. The tool's architecture is model-agnostic with respect to the prompt — swapping the system prompt is the only change needed to go from the test harness to the real injection logic.

**Current system prompt (placeholder):** Rewrites every visible text element to be bold and colored with a theme-appropriate blue. This was chosen as a placeholder because the effect is immediately visible in a browser, making it easy to verify the tool is correctly reading, transforming, and writing back every file in the target directory.

**Intended system prompt (research use):** Embeds context-aware prompt injection payloads into source code as plausible developer comments, causing LLM-powered vulnerability scanning agents to produce false negatives on real vulnerabilities.

It does not change layout, structure, functionality, or non-text visual elements. It only touches what the system prompt instructs it to touch.

---

## Project structure

```
pi-inject/
├── package.json       # npm metadata, build script, dependencies
├── tsconfig.json      # TypeScript compiler config
└── src/
    └── index.ts       # All CLI logic
```

After building, a `dist/` folder is generated containing the compiled JavaScript with a shebang prepended so it runs directly as a CLI binary.

---

## How to install & build

```bash
cd pi-inject
npm install
npm run build   # compiles TypeScript → dist/, prepends shebang, chmods to 755
npm link        # makes `pi-inject` available globally in your shell
```

Requires **Node.js >= 20**.

---

## Usage

```
pi-inject <target> [options]
```

| Argument / Flag | Description |
|---|---|
| `<target>` | File or directory to process. Directories are walked recursively. |
| `--output <dir>` | *(optional)* Write results to a separate directory, mirroring the source structure. If omitted, files are **edited in-place**. |
| `--dry-run` | Don't write anything. Print transformed content to **stdout** instead. |
| `--delay <seconds>` | Sleep between API calls. Default: `0.5`. Useful to avoid rate limits. |

### Examples

```bash
# Edit all files in a directory in-place
pi-inject ./my-website

# Write transformed files to a separate folder
pi-inject ./my-website --output ./my-website-blue

# Preview what a single file would look like, without writing
pi-inject ./styles.css --dry-run

# Process a large project slowly to avoid rate limits
pi-inject ./src --output ./out --delay 2
```

---

## API key

On startup, the tool checks `process.env.ANTHROPIC_API_KEY`.

- If the env var is set, it uses that silently.
- If not, it prompts once on **stderr**: `Enter your Anthropic API key:`

The key is never written to disk.

---

## Supported file types

| Extension | How it's handled |
|---|---|
| `.html` | Claude adds or updates a `<style>` block |
| `.css`, `.scss` | Claude adds/updates `font-weight` and `color` on text selectors |
| `.js`, `.ts`, `.jsx`, `.tsx` | Claude updates hardcoded color strings and style objects |
| `.php` | Treated as HTML/CSS depending on context |
| `.vue` | Treated as a component with both template and style sections |

Files over **80,000 characters** are skipped (logged to stderr).

---

## How a file gets processed

1. The file is read from disk.
2. A user prompt is built with the file path, extension, and full content.
3. The prompt is sent to `claude-sonnet-4-6` via `client.messages.stream()`.
4. While the model streams its response, dots (`.`) are printed to **stderr** as a progress indicator.
5. Once streaming is complete, any markdown code fences (` ```lang ... ``` `) are stripped from the output — the model is instructed not to include them, but the strip is a safety net.
6. The result is written back to the original file (or to `--output` if specified).

All status messages and progress go to **stderr**. Only `--dry-run` output goes to **stdout**. This means you can safely pipe dry-run output without mixing in status text.

---

## Error handling

| Error | Behavior |
|---|---|
| `AuthenticationError` | Prints message to stderr, exits with code 1 |
| `RateLimitError` | Prints message to stderr, exits with code 1 |
| File not found | Prints message to stderr, exits with code 1 |
| No API key entered | Prints message to stderr, exits with code 1 |
| Per-file processing error | Logs the error to stderr, continues to next file |

---

## The system prompt (hardcoded)

The model is given a fixed system prompt that instructs it to:

1. Analyze the file's existing color theme and design language.
2. Pick a harmonious blue (muted steel blue for warm/neutral sites, electric blue for dark/cyberpunk, deep navy for corporate, etc.).
3. Apply `bold` + that blue to all visible text elements.
4. Never change layout, structure, or non-text visuals.
5. Never wrap output in markdown fences — output only the complete modified file.

The user prompt template fills in the file path, extension, and raw file content. There is no other user input at any point during processing.

---

## Code walkthrough (for contributors)

Everything lives in `src/index.ts`. Here's how the pieces fit together so you can start editing immediately.

### Entry point & CLI parsing (`main`)

`main()` at the bottom of the file wires up [Commander](https://github.com/tj/commander.js) to parse `<target>`, `--output`, `--dry-run`, and `--delay`. After parsing, it resolves the API key, validates the target path, collects files, then loops through them calling `processFile()` with an optional delay between each call.

### File collection (`collectFiles`)

Recursively walks the target using `fs.readdirSync`. Filters by the `SUPPORTED_EXTENSIONS` set. Returns a flat array of absolute file paths. If the target is a single file it just checks the extension directly. Nothing fancy — no symlink handling, no hidden-file exclusion.

### Per-file processing (`processFile`)

This is the core function. In order:

1. **Size check** — reads the file and bails out (with a stderr log) if it exceeds `MAX_FILE_CHARS` (80,000).
2. **Prompt construction** — calls `buildUserPrompt(filepath, ext, content)` which slots the values into the hardcoded template string. The system prompt (`SYSTEM_PROMPT`) is a module-level constant — this is the only thing you need to change to alter the tool's behavior.
3. **Streaming API call** — opens a stream via `client.messages.stream({ model, max_tokens, system, messages })`. Iterates over events with `for await`, accumulating `text_delta` chunks into a string. A `setInterval` fires every 500ms to print a `.` to stderr as a progress indicator, cleared in the `finally` block.
4. **Fence stripping** — `stripMarkdownFences()` removes any leading ` ```lang\n ` and trailing ` \n``` ` the model might have added despite being told not to.
5. **Write** — if `--dry-run`, prints to stdout. If `--output` is set, mirrors the source directory structure under that directory and writes there. Otherwise overwrites the original file in-place.

### Prompt structure

Two hardcoded strings in `src/index.ts`:

- `SYSTEM_PROMPT` — the constant instruction given to the model on every call. **Swap this to change what the tool does.**
- `buildUserPrompt(filepath, ext, content)` — a template function that produces the per-file user message. It passes the file path, extension, and raw content. The model uses the path and extension as hints about how to interpret the file.

### Swapping the system prompt

Find `SYSTEM_PROMPT` near the top of `src/index.ts` and replace the string. No other changes are needed. The user prompt template (`buildUserPrompt`) is intentionally generic and will work unchanged for any transformation task.

### Output routing

| Output type | Where it goes |
|---|---|
| Progress dots, file status, errors | `stderr` |
| `--dry-run` file content | `stdout` |
| Written files | disk (in-place or `--output` dir) |

This separation means `pi-inject ./src --dry-run > out.txt` captures only file content, not noise.

### Error handling

`AuthenticationError` and `RateLimitError` from the Anthropic SDK are caught at the loop level and cause an immediate `process.exit(1)`. All other per-file errors are caught, logged to stderr, and the loop continues to the next file.

---

## Dependencies

| Package | Purpose |
|---|---|
| `@anthropic-ai/sdk` | Anthropic API client with streaming support |
| `commander` | CLI argument and option parsing |
| `typescript` | Dev-only, compiles `src/` to `dist/` |
| `@types/node` | Dev-only, Node.js type definitions |
