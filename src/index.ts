import { Command } from 'commander';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const SUPPORTED_EXTENSIONS = new Set([
  '.html', '.css', '.scss', '.js', '.ts', '.jsx', '.tsx', '.php', '.vue',
]);

const MAX_FILE_CHARS = 80_000;

const SYSTEM_PROMPT = `You are a frontend style transformer. Your sole job is to modify source files so that every visible text element is bold and colored with a blue that fits the existing website theme.

Rules:
1. Analyze the file to determine the existing color theme and design language.
2. Choose a blue that is harmonious with that theme (e.g. if the site uses warm neutrals, pick a muted steel blue; if it's dark/cyberpunk, pick a bright electric blue; if it's clean/corporate, pick a deep navy).
3. Apply bold + that blue to ALL visible text elements: headings, paragraphs, labels, buttons, links, list items, table cells, form fields, placeholders, etc.
4. For CSS/SCSS files: add or update font-weight and color rules for text selectors.
5. For HTML files: add inline styles or a <style> block. Prefer a <style> block.
6. For JS/TS files: update any hardcoded color strings or style objects that affect text.
7. For PHP files: treat as HTML/CSS depending on context.
8. Do NOT change layout, structure, functionality, or non-text visual elements.
9. Do NOT wrap your output in markdown fences or add any explanation.
10. Output ONLY the complete modified file content, nothing else.`;

function buildUserPrompt(filepath: string, ext: string, content: string): string {
  return `File path: ${filepath}
File type: ${ext}

Apply the bold + theme-appropriate blue transformation to all text elements.

File content:
${content}`;
}

async function promptForApiKey(): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write('Enter your Anthropic API key: ');
    const rl = readline.createInterface({
      input: process.stdin,
      terminal: false,
    });
    rl.once('line', (line) => {
      rl.close();
      resolve(line.trim());
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripMarkdownFences(content: string): string {
  // Remove leading code fence: ```lang\n or ```\n
  let result = content.replace(/^```[^\n]*\n/, '');
  // Remove trailing code fence: \n``` (with optional trailing whitespace)
  result = result.replace(/\n```\s*$/, '');
  return result;
}

function collectFiles(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    const ext = path.extname(target).toLowerCase();
    return SUPPORTED_EXTENSIONS.has(ext) ? [target] : [];
  }
  if (stat.isDirectory()) {
    const files: string[] = [];
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      const fullPath = path.join(target, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectFiles(fullPath));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          files.push(fullPath);
        }
      }
    }
    return files;
  }
  return [];
}

async function processFile(
  client: Anthropic,
  filePath: string,
  outputDir: string | undefined,
  dryRun: boolean,
  targetRoot: string,
): Promise<void> {
  const content = fs.readFileSync(filePath, 'utf8');

  if (content.length > MAX_FILE_CHARS) {
    process.stderr.write(`Skipping ${filePath}: exceeds ${MAX_FILE_CHARS} characters (${content.length})\n`);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  process.stderr.write(`Processing ${filePath} `);

  const userPrompt = buildUserPrompt(filePath, ext, content);
  let result = '';

  const progressTimer = setInterval(() => process.stderr.write('.'), 500);

  try {
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 16384,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        result += event.delta.text;
      }
    }
  } finally {
    clearInterval(progressTimer);
    process.stderr.write(' done\n');
  }

  result = stripMarkdownFences(result);

  if (dryRun) {
    process.stdout.write(`\n--- ${filePath} ---\n${result}\n`);
    return;
  }

  let outputPath: string;
  if (outputDir) {
    // Mirror source structure under outputDir
    const rootAbsolute = path.resolve(targetRoot);
    const fileAbsolute = path.resolve(filePath);
    const isDir = fs.statSync(rootAbsolute).isDirectory();
    const relativePath = isDir
      ? path.relative(rootAbsolute, fileAbsolute)
      : path.basename(filePath);
    outputPath = path.join(outputDir, relativePath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  } else {
    // In-place: overwrite the original file
    outputPath = filePath;
  }

  fs.writeFileSync(outputPath, result, 'utf8');
  process.stderr.write(`Written: ${outputPath}\n`);
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('pi-inject')
    .description('Transform source files so all visible text is bold + theme-appropriate blue')
    .argument('<target>', 'File or directory to process')
    .option('--output <dir>', 'Output directory (default: edit files in-place)')
    .option('--dry-run', 'Print transformed content to stdout instead of writing files', false)
    .option('--delay <seconds>', 'Delay between API calls in seconds', '0.5')
    .action(async (
      target: string,
      options: { output?: string; dryRun: boolean; delay: string },
    ) => {
      // Resolve API key
      let apiKey = process.env.ANTHROPIC_API_KEY ?? '';
      if (!apiKey) {
        apiKey = await promptForApiKey();
        if (!apiKey) {
          process.stderr.write('Error: No API key provided.\n');
          process.exit(1);
        }
      }

      const client = new Anthropic({ apiKey });

      // Validate target
      if (!fs.existsSync(target)) {
        process.stderr.write(`Error: Target not found: ${target}\n`);
        process.exit(1);
      }

      const files = collectFiles(target);
      if (files.length === 0) {
        process.stderr.write('No supported files found.\n');
        process.exit(0);
      }

      process.stderr.write(`Found ${files.length} file(s) to process.\n`);

      const delayMs = Math.max(0, parseFloat(options.delay) * 1000);

      for (let i = 0; i < files.length; i++) {
        try {
          await processFile(client, files[i], options.output, options.dryRun, target);
        } catch (err) {
          if (err instanceof Anthropic.AuthenticationError) {
            process.stderr.write('Authentication error: invalid or missing API key.\n');
            process.exit(1);
          } else if (err instanceof Anthropic.RateLimitError) {
            process.stderr.write('Rate limit error: too many requests. Please wait and try again.\n');
            process.exit(1);
          } else {
            process.stderr.write(`Error processing ${files[i]}: ${String(err)}\n`);
          }
        }

        if (i < files.length - 1 && delayMs > 0) {
          await sleep(delayMs);
        }
      }

      process.stderr.write('Done.\n');
    });

  program.parse();
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${String(err)}\n`);
  process.exit(1);
});
