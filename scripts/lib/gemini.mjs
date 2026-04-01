/**
 * Core module: spawns the Gemini CLI and captures output.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Model aliases — short names for common Gemini models.
 */
const MODEL_ALIASES = new Map([
  ["pro", "gemini-3.1-pro-preview"],
  ["flash", "gemini-3-flash-preview"],
  ["25pro", "gemini-2.5-pro"],
  ["25flash", "gemini-2.5-flash"],
  ["lite", "gemini-2.5-flash-lite"],
]);

/**
 * Resolve model aliases to full model names.
 */
export function normalizeRequestedModel(model) {
  if (!model) return model;
  return MODEL_ALIASES.get(model.toLowerCase()) ?? model;
}

/**
 * Check if the `gemini` CLI is available and logged in.
 */
export async function getGeminiAvailability() {
  try {
    const result = await runGeminiRaw(["--version"], { timeout: 10_000 });
    return {
      available: true,
      version: result.stdout.trim(),
      error: null,
    };
  } catch (err) {
    return {
      available: false,
      version: null,
      error: err.message,
    };
  }
}

/**
 * Run a prompt through Gemini CLI and return the text response.
 *
 * @param {string} prompt - The prompt to send
 * @param {object} options
 * @param {string} [options.model] - Model override
 * @param {string} [options.stdin] - Content to pipe via stdin
 * @param {number} [options.timeout] - Timeout in ms
 * @param {boolean} [options.yolo] - Auto-approve tool use
 * @returns {Promise<{text: string, model: string|null}>}
 */
export async function runGeminiPrompt(prompt, options = {}) {
  const { model, stdin, timeout = DEFAULT_TIMEOUT_MS, yolo = false, resume } = options;

  const resolvedModel = normalizeRequestedModel(model);
  const args = [];
  if (resolvedModel) args.push("-m", resolvedModel);
  if (yolo) args.push("-y");
  if (resume) args.push("--resume", resume);
  args.push("-o", "text");
  args.push(prompt);

  const result = await runGeminiRaw(args, { stdin, timeout });

  return {
    text: result.stdout,
    exitCode: result.exitCode,
  };
}

/**
 * Run a prompt and get JSON output from Gemini CLI.
 */
export async function runGeminiJSON(prompt, options = {}) {
  const { model, stdin, timeout = DEFAULT_TIMEOUT_MS, yolo = false, resume } = options;

  const resolvedModel = normalizeRequestedModel(model);
  const args = [];
  if (resolvedModel) args.push("-m", resolvedModel);
  if (yolo) args.push("-y");
  if (resume) args.push("--resume", resume);
  args.push("-o", "json");
  args.push(prompt);

  const result = await runGeminiRaw(args, { stdin, timeout });

  try {
    return {
      data: JSON.parse(result.stdout),
      exitCode: result.exitCode,
    };
  } catch {
    // Gemini sometimes outputs non-JSON even with -o json; return raw
    return {
      data: null,
      text: result.stdout,
      exitCode: result.exitCode,
    };
  }
}

/**
 * Low-level: spawn the gemini binary and collect output.
 */
function runGeminiRaw(args, options = {}) {
  const { stdin, timeout = DEFAULT_TIMEOUT_MS } = options;

  return new Promise((resolve, reject) => {
    const proc = spawn("gemini", args, {
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
      env: { ...process.env },
      timeout,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });

    if (stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Gemini CLI timed out after ${timeout}ms`));
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Load a prompt template from the prompts/ directory.
 */
export async function loadPromptTemplate(name) {
  const dir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../prompts"
  );
  const filePath = path.join(dir, `${name}.md`);
  return readFile(filePath, "utf-8");
}

/**
 * Simple template interpolation: replaces {{key}} with values.
 */
export function interpolateTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value ?? "");
  }
  return result;
}
