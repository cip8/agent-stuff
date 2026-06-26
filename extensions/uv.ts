/**
 * UV Extension - steers Python tooling toward uv without replacing Pi's bash tool.
 *
 * The extension intercepts assistant bash tool calls before execution. It blocks
 * disallowed Python package-management commands, prepends the local shim directory
 * to PATH for Pi's built-in bash tool, and otherwise lets Pi's native bash
 * implementation handle cwd, rendering, truncation, cancellation, shell config,
 * and session metadata.
 *
 * Intercepted commands:
 * - pip/pip3/pip3.x: blocked with suggestions to use `uv add` or `uv run --with`
 * - poetry: blocked with uv equivalents (`uv init`, `uv add`, `uv sync`, `uv run`)
 * - python/python3/python3.x: allowed through uv shims, except true `-m pip`,
 *   `-m venv`, and `-m py_compile` interpreter invocations are blocked
 *
 * The shim scripts live in ../intercepted-commands. PATH shims are naturally
 * bypassable through explicit interpreter paths such as `.venv/bin/python`, so
 * this extension also performs shell-aware preflight checks on bash commands.
 */

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyUvPolicy, getBlockedCommandMessage, REQUIRED_SHIM_COMMANDS } from "./lib/uv-policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const interceptedCommandsPath = join(__dirname, "..", "intercepted-commands");

function isBuiltInBashTool(pi: ExtensionAPI): boolean {
  try {
    const bashTool = pi.getAllTools().find((tool) => tool.name === "bash");
    return bashTool?.sourceInfo?.source === "builtin";
  } catch {
    // If the registry is temporarily unavailable, prefer preserving the intended
    // local behavior over silently failing to prepend the shim path.
    return true;
  }
}

async function collectValidationProblems(pi: ExtensionAPI): Promise<string[]> {
  const problems: string[] = [];

  for (const command of REQUIRED_SHIM_COMMANDS) {
    const shimPath = join(interceptedCommandsPath, command);
    try {
      await access(shimPath, constants.X_OK);
    } catch {
      problems.push(`missing or non-executable shim: ${shimPath}`);
    }
  }

  try {
    const result = await pi.exec("uv", ["--version"], { timeout: 5000 });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      problems.push(`uv --version failed${detail ? `: ${detail}` : ""}`);
    }
  } catch (error) {
    problems.push(`uv is not available: ${error instanceof Error ? error.message : String(error)}`);
  }

  return problems;
}

export default function (pi: ExtensionAPI) {
  let validationWarningShown = false;

  pi.on("session_start", async (_event, ctx) => {
    if (validationWarningShown) return undefined;

    const problems = await collectValidationProblems(pi);
    if (problems.length === 0) return undefined;

    validationWarningShown = true;
    ctx.ui.notify(`uv extension is not fully configured:\n${problems.map((problem) => `- ${problem}`).join("\n")}`, "warning");
    return undefined;
  });

  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return undefined;

    const decision = applyUvPolicy(event.input.command, {
      interceptedCommandsPath,
      prependPath: isBuiltInBashTool(pi),
    });

    if (decision.action === "block") {
      return { block: true, reason: decision.reason };
    }

    event.input.command = decision.command;
    return undefined;
  });

  pi.on("user_bash", (event) => {
    // user_bash handlers cannot safely chain command mutations. For compatibility
    // with SSH/sandbox/user-bash extensions, only block disallowed commands here;
    // allowed manual commands continue through Pi's normal user-bash path unchanged.
    const blockedMessage = getBlockedCommandMessage(event.command);
    if (!blockedMessage) return undefined;

    return {
      result: {
        output: blockedMessage,
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });
}
