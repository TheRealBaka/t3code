/**
 * ClaudeSkills — filesystem discovery of Claude Code skills for the `$` picker.
 *
 * Claude Code loads skills from installed plugins (`plugin` scope), then
 * `<config dir>/skills` (user scope), then `<cwd>/.agents/skills` and
 * `<cwd>/.claude/skills` (project scope), one directory per skill with a
 * `SKILL.md` carrying YAML frontmatter. Later roots win on name collisions, so
 * precedence is plugin, user, `.agents`, then `.claude`.
 *
 * The Agent SDK init handshake reports one flat `commands` list whose entries
 * carry only a name, description, argument hint, and aliases. Claude Code puts
 * session controls (`/clear`, `/compact`, `/model`) in that same list with no
 * marker separating them from skills, and skills built into the CLI binary
 * exist nowhere on disk. So the handshake cannot be used to extend this list —
 * the provider snapshot scans the filesystem locations directly, mirroring how
 * the Codex app-server reports its skills, and the built-in skills stay
 * reachable through the `/` menu that `slashCommands` already feeds.
 *
 * @module provider/Drivers/ClaudeSkills
 */
import * as NodeOS from "node:os";

import type { ClaudeSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "../../pathExpansion.ts";

type ClaudeSkillScope = "user" | "project" | "plugin";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "parsed"; readonly name?: string; readonly description?: string };

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

/**
 * Resolve the Claude config directory the CLI would use, matching the
 * precedence the spawned CLI sees: the instance's `homePath` (exported as
 * `CLAUDE_CONFIG_DIR` by `makeClaudeEnvironment`), then a `CLAUDE_CONFIG_DIR`
 * already present in the process environment, then `~/.claude`.
 */
const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath));
  }
  // No tilde expansion here: the spawned CLI receives this env var verbatim
  // (env vars are never shell-expanded), so a literal `~` must stay literal
  // for discovery to scan the same directory the runtime would. A relative
  // value is resolved against the workspace cwd — the subprocess's own cwd —
  // for the same reason.
  const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir);
  }
  return path.join(NodeOS.homedir(), ".claude");
});

/** Read a JSON object from disk, treating unreadable or non-object files as absent. */
const readJsonRecord = Effect.fn("readJsonRecord")(function* (
  filePath: string,
): Effect.fn.Return<Record<string, unknown> | undefined, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem
    .readFileString(filePath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (contents === undefined) {
    return undefined;
  }

  const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(contents).pipe(
    Effect.orElseSucceed((): unknown => undefined),
  );
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
});

/**
 * Plugin ids the user turned off, read from the settings files Claude Code
 * merges in load order. `installed_plugins.json` already lists only installed
 * plugins, so an id counts as enabled unless a settings file explicitly sets it
 * to `false`; a later file re-enabling it wins, matching the merge order.
 */
const readDisabledPluginIds = Effect.fn("readDisabledPluginIds")(function* (
  settingsPaths: ReadonlyArray<string>,
): Effect.fn.Return<ReadonlySet<string>, never, FileSystem.FileSystem> {
  const disabled = new Set<string>();
  for (const settingsPath of settingsPaths) {
    const settings = yield* readJsonRecord(settingsPath);
    const enabledPlugins = settings?.enabledPlugins;
    if (typeof enabledPlugins !== "object" || enabledPlugins === null) {
      continue;
    }

    for (const [pluginId, value] of Object.entries(enabledPlugins as Record<string, unknown>)) {
      const key = pluginId.trim().toLowerCase();
      if (!key) {
        continue;
      }
      if (value === false) {
        disabled.add(key);
      } else {
        disabled.delete(key);
      }
    }
  }
  return disabled;
});

/**
 * `<install path>/skills` for every enabled installed plugin, sorted by plugin
 * id so the snapshot is stable across refreshes. `installed_plugins.json` is
 * Claude Code's own registry of what it loads and records an absolute
 * `installPath` per entry, so discovery follows it instead of reconstructing
 * marketplace layouts.
 */
const readInstalledPluginSkillRoots = Effect.fn("readInstalledPluginSkillRoots")(function* (
  configDirPath: string,
  disabledPluginIds: ReadonlySet<string>,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const registry = yield* readJsonRecord(
    path.join(configDirPath, "plugins", "installed_plugins.json"),
  );
  const plugins = registry?.plugins;
  if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) {
    return [];
  }

  const roots: string[] = [];
  for (const [pluginId, installs] of Object.entries(plugins as Record<string, unknown>).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (disabledPluginIds.has(pluginId.trim().toLowerCase())) {
      continue;
    }

    const installList: ReadonlyArray<unknown> = Array.isArray(installs) ? installs : [installs];
    for (const install of installList) {
      if (typeof install !== "object" || install === null) {
        continue;
      }
      const installPath = (install as { readonly installPath?: unknown }).installPath;
      if (typeof installPath !== "string" || !installPath.trim()) {
        continue;
      }
      roots.push(path.join(installPath.trim(), "skills"));
    }
  }
  return roots;
});

/**
 * Enumerate Claude Code skills from installed plugins, the user config dir,
 * workspace `.agents/skills`, and workspace `.claude/skills`, in that order.
 * Discovery is best-effort: unreadable roots and malformed skill entries are
 * skipped so a broken skill never degrades the provider snapshot. On name
 * collisions, later roots win: user beats plugin, `.agents` beats user, and
 * `.claude` beats `.agents`, matching Claude Code's resolution.
 */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment ?? process.env, cwd);

  const settingsPaths = [
    path.join(configDirPath, "settings.json"),
    ...(cwd
      ? [
          path.join(cwd, ".claude", "settings.json"),
          path.join(cwd, ".claude", "settings.local.json"),
        ]
      : []),
  ];
  const disabledPluginIds = yield* readDisabledPluginIds(settingsPaths);
  const pluginSkillRoots = yield* readInstalledPluginSkillRoots(configDirPath, disabledPluginIds);

  const roots: ReadonlyArray<{ directory: string; scope: ClaudeSkillScope }> = [
    ...pluginSkillRoots.map((directory) => ({ directory, scope: "plugin" as const })),
    { directory: path.join(configDirPath, "skills"), scope: "user" },
    ...(cwd
      ? [
          { directory: path.join(cwd, ".agents", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".claude", "skills"), scope: "project" as const },
        ]
      : []),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      const skillPath = path.join(root.directory, entry, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }

      const frontmatter = parseSkillFrontmatter(contents);
      // Malformed frontmatter means the skill won't load in Claude Code
      // either — skip it rather than surfacing a broken entry under its
      // directory name.
      if (frontmatter.kind === "malformed") {
        continue;
      }

      const name = (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? entry.trim();
      if (!name) {
        continue;
      }

      skillsByName.set(name, {
        name,
        path: skillPath,
        enabled: true,
        scope: root.scope,
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
