#!/usr/bin/env bun
/**
 * Local agent-ci driver.
 *
 * Per PLAN Phase 0.D findings, `@redwoodjs/agent-ci` requires `GITHUB_REPO` at
 * boot (it crashes otherwise with "Could not detect GitHub repository from git
 * remotes."). Shamu's own packages/ci wrapper will own this in Phase 5; until
 * then, this script sets the env var from the git origin (if present) or from
 * a repo-local default, then shells out to agent-ci with the same `--all
 * --quiet` invocation the supervisor will use.
 *
 * Usage:
 *   bun scripts/agent-ci.ts              # run --all --quiet
 *   bun scripts/agent-ci.ts --workflow <path>
 */

import { spawnSync } from "node:child_process";
import { env, exit, stderr } from "node:process";

function resolveGithubRepo(): string {
  if (env.GITHUB_REPO) return env.GITHUB_REPO;
  const result = spawnSync("git", ["config", "--get", "remote.origin.url"], {
    encoding: "utf8",
  });
  if (result.status === 0) {
    const url = result.stdout.trim();
    // Accept https://github.com/<owner>/<repo>(.git)? and git@github.com:<owner>/<repo>(.git)?
    const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url) ?? null;
    if (match?.[1] && match[2]) return `${match[1]}/${match[2]}`;
  }
  // Repo-local default so agent-ci boots; the emulated API never phones home,
  // per agent-ci docs, so the value is used only for display / slug.
  return "watzon/shamu";
}

const forwardedArgs = process.argv.slice(2);
const args = forwardedArgs.length > 0 ? forwardedArgs : ["run", "--all", "--quiet"];

const child = spawnSync("npx", ["@redwoodjs/agent-ci", ...args], {
  stdio: "inherit",
  env: { ...env, GITHUB_REPO: resolveGithubRepo(), AI_AGENT: "1" },
});

if (child.error) {
  stderr.write(`${child.error.message}\n`);
  exit(1);
}
exit(child.status ?? 1);
