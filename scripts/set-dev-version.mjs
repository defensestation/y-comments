// Rewrites all three package versions to a shared `X.Y.Z-dev.<sha>` prerelease
// and repoints their internal @defensestation/y-comments-* dependency ranges
// at that exact version, so a `@dev` install resolves a matching set instead
// of falling back to the last stable release.
//
//   node scripts/set-dev-version.mjs <short-sha>

import { readFileSync, writeFileSync } from "node:fs";

const sha = process.argv[2];
if (!sha) {
  console.error("usage: set-dev-version.mjs <short-sha>");
  process.exit(1);
}

const dirs = ["y-comments-core", "y-comments-prosemirror", "y-comments-blocknote"];
const internalNames = new Set(dirs.map((d) => `@defensestation/${d}`));
const depFields = ["dependencies", "peerDependencies", "optionalDependencies"];

// all three share one base version (they release in lockstep)
const base = JSON.parse(readFileSync("packages/y-comments-core/package.json", "utf8")).version;
const devVersion = `${base}-dev.${sha}`;

for (const dir of dirs) {
  const path = `packages/${dir}/package.json`;
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.version = devVersion;
  for (const field of depFields) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (internalNames.has(name)) deps[name] = devVersion;
    }
  }
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${pkg.name} -> ${devVersion}`);
}
