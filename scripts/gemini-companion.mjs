#!/usr/bin/env node

/**
 * gemini-companion.mjs — Main entry point for the Gemini plugin.
 *
 * Subcommands:
 *   setup          Check Gemini CLI availability and login status
 *   ask            Ask Gemini a question (with optional piped context)
 *   review         Run a code review via Gemini
 *   ui-review      Run a UI/UX-focused review via Gemini
 *   task           Delegate a general task to Gemini
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  getGeminiAvailability,
  runGeminiPrompt,
  loadPromptTemplate,
  interpolateTemplate,
} from "./lib/gemini.mjs";
import { getGitDiff, getGitLog, readFileContext, readStdinIfPiped } from "./lib/context.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/gemini-companion.mjs setup [--json]",
      "  node scripts/gemini-companion.mjs ask [--model <model>] <question>",
      "  node scripts/gemini-companion.mjs review [--base <ref>] [--scope <auto|working-tree|branch>] [focus]",
      "  node scripts/gemini-companion.mjs ui-review [--file <path>] [focus]",
      "  node scripts/gemini-companion.mjs task [--model <model>] <prompt>",
    ].join("\n")
  );
}

// ─── setup ──────────────────────────────────────────────────────────

async function cmdSetup(flags) {
  const status = await getGeminiAvailability();

  const report = {
    geminiAvailable: status.available,
    version: status.version,
    error: status.error,
  };

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const lines = [];
    if (status.available) {
      lines.push(`Gemini CLI v${status.version} — ready.`);
      lines.push("");
      lines.push("Available commands:");
      lines.push("  /gemini:ask <question>        — Ask Gemini anything");
      lines.push("  /gemini:review [focus]         — Code review (uses git diff)");
      lines.push("  /gemini:ui-review [focus]      — UI/UX review");
      lines.push("  /gemini:task <prompt>          — Delegate a task to Gemini");
    } else {
      lines.push("Gemini CLI is not available.");
      lines.push(`Error: ${status.error}`);
      lines.push("");
      lines.push("Install: npm install -g @anthropic-ai/gemini-cli  (or check https://github.com/anthropics/gemini-cli)");
      lines.push("Then run: gemini (to authenticate with Google)");
    }
    console.log(lines.join("\n"));
  }
}

// ─── ask ────────────────────────────────────────────────────────────

async function cmdAsk(flags, positional) {
  const question = positional.join(" ");
  if (!question) {
    console.error("Error: No question provided.\nUsage: /gemini:ask <question>");
    process.exit(1);
  }

  const stdinContent = await readStdinIfPiped();
  let prompt = question;
  if (stdinContent) {
    prompt = `Context:\n\`\`\`\n${stdinContent}\n\`\`\`\n\nQuestion: ${question}`;
  }

  console.error(`Asking Gemini: ${question.slice(0, 80)}${question.length > 80 ? "..." : ""}`);

  const result = await runGeminiPrompt(prompt, { model: flags.model });

  if (result.exitCode !== 0) {
    console.error(`Gemini exited with code ${result.exitCode}`);
  }

  console.log(result.text);
}

// ─── review ─────────────────────────────────────────────────────────

async function cmdReview(flags, positional) {
  const focus = positional.join(" ") || "general code review";
  const base = flags.base || "HEAD";
  const scope = flags.scope || "auto";

  console.error("Gathering git diff...");
  const diff = await getGitDiff(base, scope);

  if (!diff) {
    console.log("No changes found to review.");
    return;
  }

  console.error(`Diff size: ${diff.length} chars. Sending to Gemini for review...`);

  let prompt;
  try {
    const template = await loadPromptTemplate("code-review");
    prompt = interpolateTemplate(template, { diff, focus });
  } catch {
    // Fallback if template missing
    prompt = `You are an expert code reviewer. Review the following git diff.

Focus: ${focus}

Provide:
1. **Critical issues** — bugs, security problems, data loss risks
2. **Important suggestions** — performance, maintainability, best practices
3. **Minor notes** — style, naming, documentation

Be specific: reference file names and line numbers from the diff.

\`\`\`diff
${diff}
\`\`\``;
  }

  const result = await runGeminiPrompt(prompt, { model: flags.model });
  console.log(result.text);
}

// ─── ui-review ──────────────────────────────────────────────────────

async function cmdUiReview(flags, positional) {
  const focus = positional.join(" ") || "general UI/UX review";
  let context = "";

  if (flags.file) {
    const content = await readFileContext(flags.file);
    if (content) {
      context = `\nFile: ${flags.file}\n\`\`\`\n${content}\n\`\`\`\n`;
    } else {
      console.error(`Warning: Could not read file ${flags.file}`);
    }
  }

  const stdinContent = await readStdinIfPiped();
  if (stdinContent) {
    context += `\nProvided content:\n\`\`\`\n${stdinContent}\n\`\`\`\n`;
  }

  if (!context) {
    // Fall back to git diff for UI files
    console.error("No file specified. Gathering changes from git diff...");
    const diff = await getGitDiff();
    if (diff) {
      context = `\nGit diff:\n\`\`\`diff\n${diff}\n\`\`\`\n`;
    }
  }

  let prompt;
  try {
    const template = await loadPromptTemplate("ui-review");
    prompt = interpolateTemplate(template, { context, focus });
  } catch {
    prompt = `You are an expert UI/UX reviewer. Review the following for usability, accessibility, clarity, and user experience.

Focus: ${focus}
${context}

Provide feedback on:
1. **UX flow** — Is the user journey clear and intuitive?
2. **Accessibility** — WCAG compliance, screen readers, keyboard nav
3. **Copy & messaging** — Error messages, labels, help text clarity
4. **Visual hierarchy** — Layout, spacing, affordances
5. **Edge cases** — Empty states, loading states, error states

Be specific and actionable.`;
  }

  console.error(`Sending to Gemini for UI/UX review...`);
  const result = await runGeminiPrompt(prompt, { model: flags.model });
  console.log(result.text);
}

// ─── task ───────────────────────────────────────────────────────────

async function cmdTask(flags, positional) {
  const taskPrompt = positional.join(" ");
  if (!taskPrompt) {
    console.error("Error: No task prompt provided.\nUsage: /gemini:task <prompt>");
    process.exit(1);
  }

  const stdinContent = await readStdinIfPiped();
  let fullPrompt = taskPrompt;
  if (stdinContent) {
    fullPrompt = `Context:\n\`\`\`\n${stdinContent}\n\`\`\`\n\nTask: ${taskPrompt}`;
  }

  console.error(`Delegating to Gemini: ${taskPrompt.slice(0, 80)}${taskPrompt.length > 80 ? "..." : ""}`);

  const result = await runGeminiPrompt(fullPrompt, {
    model: flags.model,
    yolo: flags.yolo || false,
  });

  if (result.exitCode !== 0) {
    console.error(`Gemini exited with code ${result.exitCode}`);
  }

  console.log(result.text);
}

// ─── main ───────────────────────────────────────────────────────────

async function main() {
  // Claude Code passes the raw argument string as a single env var or argv
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0) {
    printUsage();
    process.exit(0);
  }

  const subcommand = rawArgs[0];
  const { flags, positional } = parseArgs(rawArgs.slice(1));

  switch (subcommand) {
    case "setup":
      await cmdSetup(flags);
      break;
    case "ask":
      await cmdAsk(flags, positional);
      break;
    case "review":
      await cmdReview(flags, positional);
      break;
    case "ui-review":
      await cmdUiReview(flags, positional);
      break;
    case "task":
      await cmdTask(flags, positional);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
