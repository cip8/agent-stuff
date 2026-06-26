import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const shims = ["python", "python3"];

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "uv-shim-test-"));
  const binDir = join(dir, "bin");
  const logPath = join(dir, "uv.log");
  const realPython = join(dir, "real-python");

  mkdirSync(binDir);
  writeFileSync(realPython, "#!/bin/bash\nexit 0\n", "utf8");
  chmodSync(realPython, 0o755);

  writeFileSync(
    join(binDir, "uv"),
    `#!/bin/bash
set -e
if [ "$1" = "python" ] && [ "$2" = "find" ]; then
  echo "$FAKE_REAL_PYTHON"
  exit 0
fi
if [ "$1" = "run" ]; then
  printf '%s\\n' "$*" >> "$UV_TEST_LOG"
  exit 0
fi
echo "unexpected uv invocation: $*" >&2
exit 42
`,
    "utf8",
  );
  chmodSync(join(binDir, "uv"), 0o755);

  return { dir, binDir, logPath, realPython };
}

function runShim(shimName, args, fixture) {
  const shimPath = join(repoRoot, "intercepted-commands", shimName);
  return spawnSync(shimPath, args, {
    env: {
      ...process.env,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
      FAKE_REAL_PYTHON: fixture.realPython,
      UV_TEST_LOG: fixture.logPath,
    },
    encoding: "utf8",
  });
}

for (const shimName of shims) {
  test(`${shimName} blocks only interpreter-level disallowed modules`, () => {
    const fixture = makeFixture();
    try {
      for (const args of [
        ["-m", "pip", "install", "flask"],
        ["-mpip", "install", "flask"],
        ["-I", "-m", "venv", ".venv"],
        ["-X", "dev", "-m", "py_compile", "foo.py"],
      ]) {
        const result = runShim(shimName, args, fixture);
        assert.equal(result.status, 1, `${shimName} ${args.join(" ")} should fail`);
        assert.match(result.stderr, /disabled/);
      }
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test(`${shimName} allows script arguments that mention pip or -m pip`, () => {
    const fixture = makeFixture();
    try {
      for (const args of [
        ["script.py", "pip"],
        ["script.py", "-m", "pip"],
        ["-c", "import pip; print(pip.__name__)"],
        ["-m", "pytest", "tests"],
      ]) {
        const result = runShim(shimName, args, fixture);
        assert.equal(result.status, 0, `${shimName} ${args.join(" ")} should be allowed: ${result.stderr}`);
      }

      const log = readFileSync(fixture.logPath, "utf8");
      assert.match(log, /run --python .* python script\.py pip/);
      assert.match(log, /run --python .* python script\.py -m pip/);
      assert.match(log, /run --python .* python -c import pip; print\(pip\.__name__\)/);
      assert.match(log, /run --python .* python -m pytest tests/);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
}
