#!/usr/bin/env bun
import { $ } from "bun";

type Bump = "patch" | "minor" | "major";

const bump = process.argv[2] as Bump | undefined;
if (!bump || !["patch", "minor", "major"].includes(bump)) {
  console.error("Usage: bun run release <patch|minor|major>");
  process.exit(1);
}

const pkgPath = `${import.meta.dir}/../package.json`;
const pkgFile = Bun.file(pkgPath);
const pkg = await pkgFile.json();
const current: string = pkg.version;

const parts = current.split(".").map(Number);
if (parts.length !== 3 || parts.some(Number.isNaN)) {
  console.error(`Cannot parse current version: ${current}`);
  process.exit(1);
}
let [major, minor, patch] = parts;
if (bump === "major") {
  major += 1;
  minor = 0;
  patch = 0;
} else if (bump === "minor") {
  minor += 1;
  patch = 0;
} else {
  patch += 1;
}
const next = `${major}.${minor}.${patch}`;
const tag = `v${next}`;

const status = (await $`git status --porcelain`.text()).trim();
if (status) {
  console.error("Working tree is not clean. Commit or stash changes first.");
  console.error(status);
  process.exit(1);
}

const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
if (branch !== "main") {
  console.error(`Refusing to release from branch '${branch}'. Switch to main.`);
  process.exit(1);
}

await $`git fetch origin main --tags`;
const local = (await $`git rev-parse @`.text()).trim();
const remote = (await $`git rev-parse @{u}`.text()).trim();
if (local !== remote) {
  console.error("Local main is not in sync with origin/main. Pull or push first.");
  process.exit(1);
}

const existingTag = (await $`git tag --list ${tag}`.text()).trim();
if (existingTag) {
  console.error(`Tag ${tag} already exists.`);
  process.exit(1);
}

console.log(`Releasing ${current} -> ${next}`);

console.log("Running type check...");
await $`bun run check`;

pkg.version = next;
await Bun.write(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

await $`git add package.json`;
await $`git commit -m ${`chore(release): ${next}`}`;
await $`git tag -a ${tag} -m ${`Release ${next}`}`;
await $`git push origin main`;
await $`git push origin ${tag}`;

console.log(`\nReleased ${tag}. CI will build binaries and publish to npm.`);
