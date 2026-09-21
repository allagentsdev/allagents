#!/usr/bin/env bun
/**
 * Publish allagents to npm with retry-safe behavior.
 *
 * The GitHub Actions Publish workflow calls this script after checking out a
 * release tag. A new publish assigns the requested dist-tag atomically. If the
 * package version is already on npm, the script verifies that tag without
 * attempting a second mutation that npm trusted publishing cannot authorize.
 *
 * Usage:
 *   bun scripts/publish.ts next
 *   bun scripts/publish.ts latest
 */

import { readFileSync } from "node:fs";
import { $ } from "bun";
import { createCheckedPackageTarball } from "./check-package-size";

type NpmTag = "next" | "latest";
type DistTags = Record<string, string | undefined>;

const VALID_TAGS = ["next", "latest"] as const;

function parseTag(tag: string | undefined): NpmTag {
  if (!tag || !VALID_TAGS.includes(tag as NpmTag)) {
    throw new Error(`Invalid npm dist-tag: ${tag ?? "(missing)"}. Expected next or latest.`);
  }

  return tag as NpmTag;
}

function readPackageJson() {
  return JSON.parse(readFileSync("package.json", "utf8")) as {
    name: string;
    version: string;
  };
}

async function npmJson(args: string[], options: { allowNotFound?: boolean } = {}) {
  const result = await $`npm ${args}`.quiet().nothrow();
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();

  if (result.exitCode === 0) {
    return stdout ? JSON.parse(stdout) : undefined;
  }

  if (options.allowNotFound && (stdout.includes("E404") || stderr.includes("E404"))) {
    return undefined;
  }

  throw new Error(`npm ${args.join(" ")} failed:\n${stderr || stdout}`);
}

async function getPublishedVersion(name: string, version: string): Promise<string | undefined> {
  const result = await npmJson(["view", `${name}@${version}`, "version", "--json"], {
    allowNotFound: true,
  });
  const publishedVersion = Array.isArray(result) ? result[0] : result;
  return typeof publishedVersion === "string" ? publishedVersion : undefined;
}

async function getDistTags(name: string): Promise<DistTags> {
  const result = await npmJson(["view", name, "dist-tags", "--json"], { allowNotFound: true });
  const tags = Array.isArray(result) ? result[0] : result;
  return tags && typeof tags === "object" ? (tags as DistTags) : {};
}

function assertVersionMatchesTag(name: string, version: string, npmTag: NpmTag) {
  const isPrerelease = version.includes("-next.");

  if (isPrerelease && npmTag !== "next") {
    throw new Error(`Refusing to publish prerelease ${name}@${version} to ${npmTag}`);
  }

  if (!isPrerelease && npmTag === "next") {
    throw new Error(`Refusing to publish stable ${name}@${version} to next`);
  }
}

function assertNoDowngrade(name: string, currentVersion: string | undefined, nextVersion: string, npmTag: NpmTag) {
  if (!currentVersion || currentVersion === nextVersion) {
    return;
  }

  if (Bun.semver.order(nextVersion, currentVersion) < 0) {
    throw new Error(`Refusing to move ${name}@${npmTag} backward from ${currentVersion} to ${nextVersion}`);
  }
}

async function assertDistTagMatches(name: string, version: string, npmTag: NpmTag) {
  const tags = await getDistTags(name);
  assertNoDowngrade(name, tags[npmTag], version, npmTag);

  if (tags[npmTag] !== version) {
    throw new Error(
      `${name}@${version} is already published, but ${npmTag} points to ${tags[npmTag] ?? 'nothing'}. Update the npm dist-tag manually.`,
    );
  }

  console.log(`   ✓ ${name}@${npmTag} already points to ${version}`);
}

async function main() {
  const npmTag = parseTag(process.argv[2]);
  const { name, version } = readPackageJson();

  assertVersionMatchesTag(name, version, npmTag);

  console.log(`\n📦 Publishing ${name}@${version} (--tag ${npmTag})...`);
  const publishedVersion = await getPublishedVersion(name, version);
  if (publishedVersion === version) {
    console.log(`   ✓ ${name}@${version} is already published`);
    await assertDistTagMatches(name, version, npmTag);
  } else {
    const packedPackage = await createCheckedPackageTarball(process.cwd());
    try {
      await $`npm publish ${packedPackage.tarballPath} --tag ${npmTag}`.env({
        ...process.env,
        ALLOW_PUBLISH: "1",
      });
    } finally {
      await packedPackage.cleanup();
    }
  }
  console.log("\n✅ Package published.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`❌ ${message}`);
  process.exit(1);
});
