import assert from "node:assert/strict";
import test from "node:test";
import {
  applyUvPolicy,
  getBlockedCommandMessage,
  getUvPathPrefix,
  prependUvPath,
  shellQuote,
} from "../extensions/lib/uv-policy.js";

function assertBlocked(command, expectedText) {
  const message = getBlockedCommandMessage(command);
  assert.ok(message, `${command} should be blocked`);
  assert.match(message, expectedText);
}

function assertAllowed(command) {
  assert.equal(getBlockedCommandMessage(command), null, `${command} should be allowed`);
}

test("shell quoting and PATH prefixing are safe and idempotent", () => {
  const shimDir = "/tmp/uv shims/it's fine";
  assert.equal(shellQuote(shimDir), `'/tmp/uv shims/it'"'"'s fine'`);

  const prefix = getUvPathPrefix(shimDir);
  assert.equal(prefix, `export PATH='/tmp/uv shims/it'"'"'s fine'\${PATH:+:$PATH}`);

  const command = "python script.py";
  const prefixed = prependUvPath(command, shimDir);
  assert.equal(prefixed, `${prefix}\n${command}`);
  assert.equal(prependUvPath(prefixed, shimDir), prefixed);
});

test("applyUvPolicy blocks disallowed commands and prepends PATH for allowed commands", () => {
  const blocked = applyUvPolicy("python -m pip install flask", { interceptedCommandsPath: "/tmp/shims" });
  assert.equal(blocked.action, "block");
  assert.match(blocked.reason, /python -m pip/);

  const allowed = applyUvPolicy("python script.py", { interceptedCommandsPath: "/tmp/shims" });
  assert.equal(allowed.action, "allow");
  assert.equal(allowed.command, "export PATH='/tmp/shims'\${PATH:+:$PATH}\npython script.py");

  const allowedWithoutPrepend = applyUvPolicy("python script.py", { interceptedCommandsPath: "/tmp/shims", prependPath: false });
  assert.equal(allowedWithoutPrepend.action, "allow");
  assert.equal(allowedWithoutPrepend.command, "python script.py");
});

test("blocks direct Python package-management commands", () => {
  assertBlocked("pip install flask", /pip is disabled/);
  assertBlocked("pip3 install flask", /pip3 is disabled/);
  assertBlocked("pip3.12 install flask", /pip3 is disabled/);
  assertBlocked("/tmp/venv/bin/pip install flask", /pip is disabled/);
  assertBlocked("poetry install", /poetry is disabled/);
});

test("blocks interpreter-level disallowed Python modules", () => {
  assertBlocked("python -m pip install flask", /python -m pip/);
  assertBlocked("python -mpip install flask", /python -m pip/);
  assertBlocked("python3 -I -m venv .venv", /python -m venv/);
  assertBlocked("python3.12 -X dev -m py_compile foo.py", /python -m py_compile/);
  assertBlocked(".venv/bin/python -m pip install flask", /python -m pip/);
  assertBlocked("/usr/bin/python3 -m py_compile foo.py", /python -m py_compile/);
});

test("understands common command wrappers and nested shell execution", () => {
  assertBlocked("sudo -E pip install flask", /pip is disabled/);
  assertBlocked("env FOO=1 python -m pip install flask", /python -m pip/);
  assertBlocked("env -S 'python -m pip install flask'", /python -m pip/);
  assertBlocked("command pip install flask", /pip is disabled/);
  assertBlocked("exec python -m venv .venv", /python -m venv/);
  assertBlocked("bash -lc 'pip install flask'", /pip is disabled/);
  assertBlocked('sh -c "python -m pip install flask"', /python -m pip/);
});

test("detects command substitutions", () => {
  assertBlocked("echo $(python -m pip --version)", /python -m pip/);
  assertBlocked("echo `pip --version`", /pip is disabled/);
  assertBlocked('echo "$(pip --version)"', /pip is disabled/);
});

test("allows references that do not execute disallowed package-management commands", () => {
  assertAllowed('echo "pip install flask"');
  assertAllowed("python script.py pip");
  assertAllowed("python script.py -m pip");
  assertAllowed("python -c 'import pip; print(pip.__name__)'");
  assertAllowed("python -m pytest tests");
  assertAllowed("command -v pip");
  assertAllowed("which pip");
  assertAllowed("uv add flask");
});

test("handles heredoc bodies according to the command that consumes them", () => {
  assertAllowed("cat <<'PY'\npip install flask\nPY");
  assertAllowed("cat <<-PY\n\tpython -m pip install flask\n\tPY");
  assertBlocked("bash <<'SH'\npip install flask\nSH", /pip is disabled/);
  assertBlocked("sh <<'SH'\npython -m pip install flask\nSH", /python -m pip/);
});
