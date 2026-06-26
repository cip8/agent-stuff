import { basename } from "node:path";

export const REQUIRED_SHIM_COMMANDS = Object.freeze(["python", "python3", "pip", "pip3", "poetry"]);

const MAX_RECURSION_DEPTH = 8;
const PYTHON_BLOCKED_MODULES = new Set(["pip", "venv", "py_compile"]);
const SYNTAX_PREFIX_WORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "time", "!"]);
const COMMAND_SEPARATOR_OPS = new Set(["\n", ";", ";;", "&&", "||", "|", "&", "(", ")"]);
const REDIRECTION_OPS = new Set(["<", ">", "<>", "<<", "<<-", "<<<", ">>", ">&", "<&", "&>", "&>>", ">|"]);
const COMMAND_LOOKUP_OPTIONS = new Set(["-v", "-V"]);
const COMMAND_WRAPPER_OPTIONS = new Set(["-p"]);
const ENV_OPTIONS_WITH_ARGUMENT = new Set(["-C", "--chdir", "-u", "--unset"]);
const SUDO_OPTIONS_WITH_ARGUMENT = new Set([
  "-A", "-a", "-b", "-C", "-c", "-D", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-U", "-u",
]);

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function getUvPathPrefix(interceptedCommandsPath) {
  return `export PATH=${shellQuote(interceptedCommandsPath)}\${PATH:+:$PATH}`;
}

export function prependUvPath(command, interceptedCommandsPath) {
  const pathPrefix = getUvPathPrefix(interceptedCommandsPath);
  return command.startsWith(`${pathPrefix}\n`) ? command : `${pathPrefix}\n${command}`;
}

function pipMessage(commandName) {
  return [
    `Error: ${commandName} is disabled. Use uv instead:`,
    "",
    "  To install a package for a script: uv run --with PACKAGE python script.py",
    "  To add a dependency to the project: uv add PACKAGE",
    "",
  ].join("\n");
}

function poetryMessage() {
  return [
    "Error: poetry is disabled. Use uv instead:",
    "",
    "  To initialize a project: uv init",
    "  To add a dependency: uv add PACKAGE",
    "  To sync dependencies: uv sync",
    "  To run commands: uv run COMMAND",
    "",
  ].join("\n");
}

function pythonModuleMessage(moduleName) {
  if (moduleName === "pip") {
    return [
      "Error: 'python -m pip' is disabled. Use uv instead:",
      "",
      "  To install a package for a script: uv run --with PACKAGE python script.py",
      "  To add a dependency to the project: uv add PACKAGE",
      "",
    ].join("\n");
  }
  if (moduleName === "venv") {
    return ["Error: 'python -m venv' is disabled. Use uv instead:", "", "  To create a virtual environment: uv venv", ""].join("\n");
  }
  if (moduleName === "py_compile") {
    return [
      "Error: 'python -m py_compile' is disabled because it writes .pyc files to __pycache__.",
      "",
      "  To verify syntax without bytecode output: uv run python -m ast path/to/file.py >/dev/null",
      "",
    ].join("\n");
  }
  return null;
}

function isAssignmentWord(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function commandBaseName(commandWord) {
  return basename(commandWord).replace(/\.exe$/i, "");
}

function isPipCommand(commandName) {
  return commandName === "pip" || /^pip3(?:\.\d+)?$/.test(commandName);
}

function pipDisplayName(commandName) {
  return commandName === "pip" ? "pip" : "pip3";
}

function isPythonCommand(commandName) {
  return /^python(?:3(?:\.\d+)*)?$/.test(commandName);
}

function isShellCommand(commandName) {
  return commandName === "sh" || commandName === "bash" || commandName === "zsh" || commandName === "ksh";
}

function isRedirectionOperator(value) {
  const normalized = value.replace(/^\d+/, "");
  return REDIRECTION_OPS.has(normalized);
}

function readRedirection(input, index) {
  let cursor = index;
  while (cursor < input.length && /\d/.test(input[cursor])) cursor++;
  const rest = input.slice(cursor);
  for (const op of ["&>>", "<<<", "<<-", ">>", "<<", "<>", ">&", "<&", "&>", ">|", "<", ">"] ) {
    if (rest.startsWith(op)) return { value: input.slice(index, cursor) + op, end: cursor + op.length };
  }
  return null;
}

export function tokenizeShell(input) {
  const tokens = [];
  let i = 0;
  let current = "";
  let currentHasQuote = false;

  function pushWord() {
    if (current.length > 0 || currentHasQuote) tokens.push({ type: "word", value: current });
    current = "";
    currentHasQuote = false;
  }

  function append(value) {
    current += value;
  }

  while (i < input.length) {
    const char = input[i];

    if (char === "\\") {
      if (input[i + 1] === "\n") i += 2;
      else if (i + 1 < input.length) {
        append(input[i + 1]);
        i += 2;
      } else {
        append(char);
        i += 1;
      }
      continue;
    }

    if (char === "'") {
      currentHasQuote = true;
      i += 1;
      while (i < input.length && input[i] !== "'") {
        append(input[i]);
        i += 1;
      }
      if (input[i] === "'") i += 1;
      continue;
    }

    if (char === '"') {
      currentHasQuote = true;
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < input.length) {
          const next = input[i + 1];
          if (next === "$" || next === "`" || next === '"' || next === "\\" || next === "\n") {
            if (next !== "\n") append(next);
            i += 2;
            continue;
          }
        }
        append(input[i]);
        i += 1;
      }
      if (input[i] === '"') i += 1;
      continue;
    }

    if (char === "#" && current.length === 0 && !currentHasQuote) {
      while (i < input.length && input[i] !== "\n") i += 1;
      continue;
    }

    if (char === "\n") {
      pushWord();
      tokens.push({ type: "op", value: "\n" });
      i += 1;
      continue;
    }

    if (/\s/.test(char)) {
      pushWord();
      i += 1;
      continue;
    }

    const redirection = current.length === 0 && !currentHasQuote ? readRedirection(input, i) : null;
    if (redirection) {
      pushWord();
      tokens.push({ type: "op", value: redirection.value });
      i = redirection.end;
      continue;
    }

    const two = input.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === ";;") {
      pushWord();
      tokens.push({ type: "op", value: two });
      i += 2;
      continue;
    }

    if (char === ";" || char === "|" || char === "&" || char === "(" || char === ")") {
      pushWord();
      tokens.push({ type: "op", value: char });
      i += 1;
      continue;
    }

    append(char);
    i += 1;
  }

  pushWord();
  return tokens;
}

function findHeredocsInTokens(tokens) {
  const heredocs = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== "op") continue;
    const normalized = token.value.replace(/^\d+/, "");
    if (normalized !== "<<" && normalized !== "<<-") continue;
    const next = tokens[i + 1];
    if (next?.type !== "word" || next.value.length === 0) continue;
    heredocs.push({ delimiter: next.value, stripTabs: normalized === "<<-" });
  }
  return heredocs;
}

function findHeredocsInLine(line) {
  return findHeredocsInTokens(tokenizeShell(line));
}

export function stripHeredocBodies(command) {
  const lines = command.split("\n");
  const output = [];
  const pending = [];
  for (const line of lines) {
    if (pending.length > 0) {
      const heredoc = pending[0];
      const comparable = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
      output.push("");
      if (comparable === heredoc.delimiter) pending.shift();
      continue;
    }
    output.push(line);
    pending.push(...findHeredocsInLine(line));
  }
  return output.join("\n");
}

function commandChunks(tokens) {
  const chunks = [];
  let current = [];
  for (const token of tokens) {
    if (token.type === "op" && COMMAND_SEPARATOR_OPS.has(token.value)) {
      if (current.length > 0) chunks.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function commandWords(tokens) {
  const words = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "op" && isRedirectionOperator(token.value)) {
      if (tokens[i + 1]?.type === "word") i += 1;
      continue;
    }
    if (token.type === "word") words.push(token.value);
  }
  return words;
}

function firstExecutableWord(words) {
  let index = 0;
  while (index < words.length && SYNTAX_PREFIX_WORDS.has(words[index])) index += 1;
  while (index < words.length && isAssignmentWord(words[index])) index += 1;
  return words[index];
}

function chunkRunsShell(tokens) {
  const executable = firstExecutableWord(commandWords(tokens));
  return executable ? isShellCommand(commandBaseName(executable)) : false;
}

function shellHeredocBodies(command) {
  const lines = command.split("\n");
  const bodies = [];
  const pending = [];

  for (const line of lines) {
    if (pending.length > 0) {
      const heredoc = pending[0];
      const comparable = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
      if (comparable === heredoc.delimiter) {
        if (heredoc.collect) bodies.push(heredoc.lines.join("\n"));
        pending.shift();
      } else if (heredoc.collect) {
        heredoc.lines.push(line);
      }
      continue;
    }

    for (const chunk of commandChunks(tokenizeShell(line))) {
      const heredocs = findHeredocsInTokens(chunk);
      if (heredocs.length === 0) continue;
      const collect = chunkRunsShell(chunk);
      pending.push(...heredocs.map((heredoc) => ({ ...heredoc, collect, lines: [] })));
    }
  }

  return bodies;
}

function skipEnvWrapper(words, index, depth) {
  let i = index + 1;
  while (i < words.length) {
    const word = words[i];
    if (word === "--") {
      i += 1;
      break;
    }
    if (word === "-") {
      i += 1;
      continue;
    }
    if (word === "-S" || word === "--split-string") {
      const nestedCommand = words[i + 1];
      return nestedCommand ? analyzeCommand(nestedCommand, depth + 1) : null;
    }
    if (word.startsWith("--split-string=")) return analyzeCommand(word.slice("--split-string=".length), depth + 1);
    if (ENV_OPTIONS_WITH_ARGUMENT.has(word)) {
      i += 2;
      continue;
    }
    if (["-C", "-u"].some((option) => word.startsWith(option) && word.length > option.length)) {
      i += 1;
      continue;
    }
    if (word.startsWith("--chdir=") || word.startsWith("--unset=")) {
      i += 1;
      continue;
    }
    if (word.startsWith("-")) {
      i += 1;
      continue;
    }
    if (isAssignmentWord(word)) {
      i += 1;
      continue;
    }
    return analyzeExecutable(words, i, depth + 1);
  }
  return null;
}

function skipCommandWrapper(words, index, depth) {
  let i = index + 1;
  while (i < words.length && words[i].startsWith("-")) {
    if (COMMAND_LOOKUP_OPTIONS.has(words[i])) return null;
    if (COMMAND_WRAPPER_OPTIONS.has(words[i])) {
      i += 1;
      continue;
    }
    break;
  }
  return i < words.length ? analyzeExecutable(words, i, depth + 1) : null;
}

function skipSudoWrapper(words, index, depth) {
  let i = index + 1;
  while (i < words.length) {
    const word = words[i];
    if (word === "--") {
      i += 1;
      break;
    }
    if (isAssignmentWord(word)) {
      i += 1;
      continue;
    }
    if (!word.startsWith("-")) break;
    const optionName = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
    if (SUDO_OPTIONS_WITH_ARGUMENT.has(optionName) && !word.includes("=") && word.length === optionName.length) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return i < words.length ? analyzeExecutable(words, i, depth + 1) : null;
}

function analyzeShellWrapper(words, index, depth) {
  for (let i = index + 1; i < words.length; i++) {
    const word = words[i];
    if (word === "--") continue;
    if (!word.startsWith("-") || word === "-") return null;
    if (word === "-c") return words[i + 1] ? analyzeCommand(words[i + 1], depth + 1) : null;
    if (!word.startsWith("--") && word.length > 2 && word.includes("c")) {
      return words[i + 1] ? analyzeCommand(words[i + 1], depth + 1) : null;
    }
  }
  return null;
}

function inspectPythonArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg === "-" || arg === "-c") return null;
    if (arg === "-m") {
      const moduleName = args[i + 1];
      return moduleName && PYTHON_BLOCKED_MODULES.has(moduleName) ? moduleName : null;
    }
    if (arg.startsWith("-m") && arg.length > 2) {
      const moduleName = arg.slice(2);
      return PYTHON_BLOCKED_MODULES.has(moduleName) ? moduleName : null;
    }
    if (arg === "-W" || arg === "-X" || arg === "-Q" || arg === "--check-hash-based-pycs") {
      i += 1;
      continue;
    }
    if (arg.startsWith("-W") || arg.startsWith("-X") || arg.startsWith("-Q") || arg.startsWith("--check-hash-based-pycs=")) continue;
    if (arg.startsWith("-")) continue;
    return null;
  }
  return null;
}

function analyzeExecutable(words, index, depth) {
  if (depth > MAX_RECURSION_DEPTH) return null;
  let i = index;
  while (i < words.length && isAssignmentWord(words[i])) i += 1;
  if (i >= words.length) return null;

  const commandName = commandBaseName(words[i]);
  if (isPipCommand(commandName)) return { kind: "blocked", commandName, reason: pipMessage(pipDisplayName(commandName)) };
  if (commandName === "poetry") return { kind: "blocked", commandName, reason: poetryMessage() };
  if (isPythonCommand(commandName)) {
    const blockedModule = inspectPythonArgs(words.slice(i + 1));
    const reason = blockedModule ? pythonModuleMessage(blockedModule) : null;
    return reason ? { kind: "blocked", commandName, moduleName: blockedModule, reason } : null;
  }
  if (commandName === "env") return skipEnvWrapper(words, i, depth + 1);
  if (commandName === "command" || commandName === "exec" || commandName === "builtin") return skipCommandWrapper(words, i, depth + 1);
  if (commandName === "sudo") return skipSudoWrapper(words, i, depth + 1);
  if (isShellCommand(commandName)) return analyzeShellWrapper(words, i, depth + 1);
  return null;
}

function analyzeCommandChunk(tokens, depth) {
  const words = commandWords(tokens);
  let index = 0;
  while (index < words.length) {
    while (index < words.length && SYNTAX_PREFIX_WORDS.has(words[index])) index += 1;
    while (index < words.length && isAssignmentWord(words[index])) index += 1;
    if (index >= words.length) return null;
    return analyzeExecutable(words, index, depth + 1);
  }
  return null;
}

function nestedCommandSubstitutions(command) {
  const nested = [];
  let i = 0;
  while (i < command.length) {
    const char = command[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === "'") {
      i += 1;
      while (i < command.length && command[i] !== "'") i += 1;
      if (command[i] === "'") i += 1;
      continue;
    }
    if (char === "`") {
      const start = i + 1;
      i += 1;
      while (i < command.length) {
        if (command[i] === "\\") {
          i += 2;
          continue;
        }
        if (command[i] === "`") break;
        i += 1;
      }
      if (i < command.length) {
        nested.push(command.slice(start, i));
        i += 1;
      }
      continue;
    }
    if (char === "$" && command[i + 1] === "(") {
      const start = i + 2;
      let cursor = start;
      let depth = 1;
      let quote = null;
      while (cursor < command.length && depth > 0) {
        const nestedChar = command[cursor];
        if (nestedChar === "\\") {
          cursor += 2;
          continue;
        }
        if (quote === "single") {
          if (nestedChar === "'") quote = null;
          cursor += 1;
          continue;
        }
        if (quote === "double") {
          if (nestedChar === '"') quote = null;
          cursor += 1;
          continue;
        }
        if (nestedChar === "'") {
          quote = "single";
          cursor += 1;
          continue;
        }
        if (nestedChar === '"') {
          quote = "double";
          cursor += 1;
          continue;
        }
        if (nestedChar === "(") depth += 1;
        if (nestedChar === ")") depth -= 1;
        cursor += 1;
      }
      if (depth === 0) {
        nested.push(command.slice(start, cursor - 1));
        i = cursor;
        continue;
      }
    }
    i += 1;
  }
  return nested;
}

function analyzeCommand(command, depth = 0) {
  return findBlockedInvocation(command, depth);
}

export function findBlockedInvocation(command, depth = 0) {
  if (depth > MAX_RECURSION_DEPTH) return null;

  for (const heredocBody of shellHeredocBodies(command)) {
    const heredocResult = findBlockedInvocation(heredocBody, depth + 1);
    if (heredocResult) return heredocResult;
  }

  const commandWithoutHeredocs = stripHeredocBodies(command);
  for (const nestedCommand of nestedCommandSubstitutions(commandWithoutHeredocs)) {
    const nestedResult = findBlockedInvocation(nestedCommand, depth + 1);
    if (nestedResult) return nestedResult;
  }
  for (const chunk of commandChunks(tokenizeShell(commandWithoutHeredocs))) {
    const result = analyzeCommandChunk(chunk, depth + 1);
    if (result) return result;
  }
  return null;
}

export function getBlockedCommandMessage(command) {
  return findBlockedInvocation(command)?.reason ?? null;
}

export function applyUvPolicy(command, { interceptedCommandsPath, prependPath = true } = {}) {
  const blockedMessage = getBlockedCommandMessage(command);
  if (blockedMessage) return { action: "block", reason: blockedMessage };
  const nextCommand = prependPath && interceptedCommandsPath ? prependUvPath(command, interceptedCommandsPath) : command;
  return { action: "allow", command: nextCommand };
}

export function isCommandBlocked(command) {
  return getBlockedCommandMessage(command) !== null;
}

export default {
  REQUIRED_SHIM_COMMANDS,
  applyUvPolicy,
  findBlockedInvocation,
  getBlockedCommandMessage,
  getUvPathPrefix,
  isCommandBlocked,
  prependUvPath,
  shellQuote,
  stripHeredocBodies,
  tokenizeShell,
};
