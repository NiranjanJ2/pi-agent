# pi-inject

A private CLI tool that uses the Anthropic API to transform source files so all visible text elements become **bold** and styled with a **theme-appropriate blue**.

---

## What it does

`pi-inject` reads your frontend source files, sends each one to Claude (claude-sonnet-4-6), and rewrites them so that every visible text element — headings, paragraphs, labels, buttons, links, inputs, placeholders, table cells, etc. — is bold and colored with a blue shade that fits the existing design language of the site.

It does **not** change layout, structure, functionality, or non-text visual elements. It only touches text styling.

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

## Dependencies

| Package | Purpose |
|---|---|
| `@anthropic-ai/sdk` | Anthropic API client with streaming support |
| `commander` | CLI argument and option parsing |
| `typescript` | Dev-only, compiles `src/` to `dist/` |
| `@types/node` | Dev-only, Node.js type definitions |
