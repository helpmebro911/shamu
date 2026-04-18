// Scratch-repo bootstrapper. Each canonical task gets its own fresh git-initialized
// repo under scratch/<vendor>-<task-id>/ seeded with vendor-ambivalent source files
// that the agent can modify. We wipe and re-seed on every run so captures are repeatable.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

export type TaskId = "bugfix" | "refactor" | "new-feature";
export type Vendor = "claude" | "codex";

const SPIKE_ROOT = new URL("..", import.meta.url).pathname;

export function scratchDir(vendor: Vendor, task: TaskId): string {
  return path.join(SPIKE_ROOT, "scratch", `${vendor}-${task}`);
}

export function taskPrompt(task: TaskId): string {
  switch (task) {
    case "bugfix":
      return [
        "The `add` function in src/math.ts is off by one. Fix it so add(a, b) returns a + b.",
        "Also add a small test in src/math.test.ts that exercises add(2, 3) === 5.",
        "Keep the change minimal. Do not modify any other files.",
      ].join("\n");
    case "refactor":
      return [
        "In src/classify.ts there is an inline if/else ladder inside the `describe` function.",
        "Extract the ladder into a named helper function called `classify(n: number): string` alongside `describe`, and update the call-site in `describe` to use it.",
        "Do not change any observable behavior. Do not rename `describe` or touch any other file.",
      ].join("\n");
    case "new-feature":
      return [
        "In src/greet.ts there is an exported `greet(name)` function.",
        "Add a new exported `farewell(name: string): string` function next to it that returns `Goodbye, <name>!`.",
        "Match the surrounding style. Do not modify greet() or any other file.",
      ].join("\n");
  }
}

async function writeSeed(dir: string, relPath: string, contents: string) {
  const full = path.join(dir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents);
}

/**
 * Reset the scratch repo for `task` under `vendor`. Creates a fresh directory,
 * seeds the canonical files for that task, and `git init`s it.
 *
 * Returns the absolute path to the scratch repo.
 */
export async function resetScratchRepo(vendor: Vendor, task: TaskId): Promise<string> {
  const dir = scratchDir(vendor, task);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  // Per-task seed
  switch (task) {
    case "bugfix": {
      await writeSeed(
        dir,
        "src/math.ts",
        `// Intentionally buggy: add() is off-by-one.\nexport function add(a: number, b: number): number {\n  return a + b + 1;\n}\n`,
      );
      await writeSeed(
        dir,
        "README.md",
        `# bugfix scratch\n\nSmall TS module. The test for \`add()\` currently fails because of an off-by-one.\n`,
      );
      break;
    }
    case "refactor": {
      await writeSeed(
        dir,
        "src/classify.ts",
        [
          `// Inline if/else ladder inside describe() — refactor target.`,
          `export function describe(n: number): string {`,
          `  let label: string;`,
          `  if (n < 0) {`,
          `    label = "negative";`,
          `  } else if (n === 0) {`,
          `    label = "zero";`,
          `  } else if (n < 10) {`,
          `    label = "small";`,
          `  } else if (n < 100) {`,
          `    label = "medium";`,
          `  } else {`,
          `    label = "large";`,
          `  }`,
          `  return \`\${n} is \${label}\`;`,
          `}`,
          ``,
        ].join("\n"),
      );
      await writeSeed(
        dir,
        "README.md",
        `# refactor scratch\n\n\`describe\` contains an inline if/else ladder that needs extracting.\n`,
      );
      break;
    }
    case "new-feature": {
      await writeSeed(
        dir,
        "src/greet.ts",
        `// Greeting module. Needs a companion farewell() export.\nexport function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`,
      );
      await writeSeed(
        dir,
        "README.md",
        `# new-feature scratch\n\nExisting \`greet()\` function. Add a matching \`farewell(name)\`.\n`,
      );
      break;
    }
  }

  // Shared tsconfig so the "codebase" looks real.
  await writeSeed(
    dir,
    "tsconfig.json",
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ) + "\n",
  );

  // git init + initial commit so agents have a clean base to diff against.
  const runGit = (args: string[]) =>
    spawnSync("git", args, { cwd: dir, stdio: "ignore" });
  runGit(["init", "-q", "-b", "main"]);
  runGit(["config", "user.email", "spike@shamu.local"]);
  runGit(["config", "user.name", "Shamu Spike"]);
  runGit(["add", "."]);
  runGit(["commit", "-q", "-m", "seed"]);

  return dir;
}
