import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cliError } from "./policy.js";

const PACKAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_DIR = path.join(PACKAGE_DIR, "skills");
const MARKER = ".searxng-cli.json";

export async function listSkills() {
  const entries = await fs.readdir(SKILL_DIR, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(SKILL_DIR, entry.name, "SKILL.md");
    try {
      const text = await fs.readFile(file, "utf8");
      result.push({ name: entry.name, description: text.match(/^description:\s*["']?(.+?)["']?$/m)?.[1] || "" });
    } catch { /* ignore incomplete skill directories */ }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkill(name) {
  if (!/^[a-z0-9-]+$/.test(name || "")) throw cliError("A valid Skill name is required", "usage", 2);
  try {
    return await fs.readFile(path.join(SKILL_DIR, name, "SKILL.md"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw cliError(`Unknown bundled Skill: ${name}`, "usage", 2);
    throw error;
  }
}

export async function manageSkills(action, options = {}) {
  if (!["install", "update", "status", "uninstall"].includes(action)) {
    throw cliError(`Unknown skills action: ${action}`, "usage", 2);
  }
  const packageInfo = JSON.parse(await fs.readFile(path.join(PACKAGE_DIR, "package.json"), "utf8"));
  const skills = await listSkills();
  const targets = resolveTargets(options);
  const reports = [];
  for (const target of targets) {
    if (action !== "status") await fs.mkdir(target.path, { recursive: true });
    const states = await Promise.all(skills.map((skill) => inspectInstalled(target.path, skill.name, packageInfo.version)));
    if (action === "status") {
      reports.push({ ...target, skills: states });
      continue;
    }
    const conflicts = states.filter((state) => state.status === "unmanaged");
    if (conflicts.length) {
      throw cliError(`Refusing to overwrite unmanaged Skill directories: ${conflicts.map((item) => item.name).join(", ")}`, "security", 4);
    }
    if (action === "uninstall") {
      for (const state of states) if (state.status !== "missing") await uninstallOwned(target.path, state.name);
    } else {
      for (const skill of skills) await installAtomic(target.path, skill.name, packageInfo);
    }
    reports.push({
      ...target,
      skills: await Promise.all(skills.map((skill) => inspectInstalled(target.path, skill.name, packageInfo.version))),
    });
  }
  return { action, package: packageInfo.name, version: packageInfo.version, targets: reports };
}

function resolveTargets(options) {
  const target = options.target || "codex";
  if (options.dir) {
    if (options.target !== undefined) throw cliError("--dir cannot be combined with --target", "usage", 2);
    return [{ target: "custom", path: path.resolve(options.dir) }];
  }
  const roots = {
    codex: path.join(os.homedir(), ".agents", "skills"),
    claude: path.join(os.homedir(), ".claude", "skills"),
  };
  if (target === "both") return Object.entries(roots).map(([name, targetPath]) => ({ target: name, path: targetPath }));
  if (!roots[target]) throw cliError("--target must be codex, claude, or both", "usage", 2);
  return [{ target, path: roots[target] }];
}

async function inspectInstalled(targetPath, name, version) {
  const destination = path.join(targetPath, name);
  try {
    const marker = JSON.parse(await fs.readFile(path.join(destination, MARKER), "utf8"));
    if (marker.owner !== "SearXNG-cli" || marker.skill !== name) return { name, status: "unmanaged" };
    return { name, status: marker.version === version ? "current" : "outdated", installed_version: marker.version };
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    try {
      await fs.access(destination);
      return { name, status: "unmanaged" };
    } catch (accessError) {
      if (accessError.code === "ENOENT") return { name, status: "missing" };
      throw accessError;
    }
  }
}

async function installAtomic(targetPath, name, packageInfo) {
  const source = path.join(SKILL_DIR, name);
  const destination = path.join(targetPath, name);
  const suffix = `${process.pid}-${randomUUID()}`;
  const temporary = path.join(targetPath, `.${name}.install-${suffix}`);
  const backup = path.join(targetPath, `.${name}.backup-${suffix}`);
  let backedUp = false;
  try {
    await fs.cp(source, temporary, { recursive: true, errorOnExist: true });
    await fs.writeFile(path.join(temporary, MARKER), `${JSON.stringify({ owner: "SearXNG-cli", package: packageInfo.name, version: packageInfo.version, skill: name }, null, 2)}\n`);
    try {
      await fs.rename(destination, backup);
      backedUp = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.rename(temporary, destination);
    if (backedUp) await fs.rm(backup, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    if (backedUp) {
      await fs.rm(destination, { recursive: true, force: true });
      await fs.rename(backup, destination);
    }
    throw error;
  }
}

async function uninstallOwned(targetPath, name) {
  const destination = path.join(targetPath, name);
  const temporary = path.join(targetPath, `.${name}.remove-${process.pid}-${randomUUID()}`);
  await fs.rename(destination, temporary);
  await fs.rm(temporary, { recursive: true, force: true });
}
