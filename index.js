// lane-guard — generalized cross-lane pollution barrier (v2 of platform-guard).
// Lanes: config-driven protected directories. Agent writes to a protected lane
// are blocked unless that lane is armed (sudo TTL, per-lane) or the session is
// bound to it (owner-gated). Unprotected lanes (bind targets) stay free.
// Unarmed reads always pass. Exclusions win over everything.

import { readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Defaults ───
const DEFAULT_LANES = []; // none by default — config drives all lane policy
const DEFAULT_EXCLUDE_PATHS = [];
const DEFAULT_STATE_DIR = "/var/lib/lane-guard";
const DEFAULT_ARM_MAX_MINUTES = 60;

// ─── Safe command set (read-only grammar) ───
const SAFE_COMMANDS = new Set([
  "cat", "head", "tail", "grep", "rg", "ls", "stat", "file", "wc",
  "find", "du", "df", "diff", "echo", "pwd", "which", "tree", "jq",
  "ss", "ps", "true", "id", "uname",
]);

const GIT_SAFE_SUBCOMMANDS = new Set([
  "log", "show", "status", "diff", "blame", "ls-files", "rev-parse",
  "describe", "branch", "tag", "shortlog", "grep", "cat-file", "diff-tree",
]);

const METACHARS = [";", "&&", "||", "|", ">>", ">", "<<", "<", "$(", "`", "&", "\n"];

// ─── Pure: isArmed(content, mtime, now, armMaxMinutes?) ───
export function isArmed(content, mtime, now, armMaxMinutes = DEFAULT_ARM_MAX_MINUTES) {
  if (content == null) return { armed: false, warning: "armFile content is null" };
  const trimmed = String(content).trim();
  if (!trimmed) return { armed: false, warning: "armFile content is empty" };
  const parsed = Date.parse(trimmed);
  if (isNaN(parsed)) {
    return { armed: false, warning: `armFile content not parseable as ISO-8601: ${JSON.stringify(trimmed)}` };
  }
  if (parsed <= now) return { armed: false, warning: null };
  const maxSpreadMs = armMaxMinutes * 60000;
  if (parsed - mtime > maxSpreadMs) {
    return { armed: false, warning: `armFile stale: content timestamp ${trimmed} too far from mtime (>${armMaxMinutes}min)` };
  }
  return { armed: true, warning: null };
}

// ─── Pure: isReadOnlyGrammar(cmd) ───
export function isReadOnlyGrammar(cmd) {
  if (typeof cmd !== "string" || cmd.trim() === "") return { clean: false, rule: "empty command" };
  for (const mc of METACHARS) {
    if (cmd.includes(mc)) return { clean: false, rule: `metachar '${mc}' in raw command` };
  }
  if (/\bcd\b/.test(cmd)) return { clean: false, rule: "cd token present" };
  const tokens = cmd.trim().split(/\s+/);
  if (tokens.length === 0) return { clean: false, rule: "no tokens" };
  const first = tokens[0];
  if (first === "git") {
    if (tokens.length < 2) return { clean: false, rule: "git without subcommand" };
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith("-")) {
      i++;
      if (i < tokens.length && tokens[i - 1] === "-C") i++;
    }
    const subcmd = tokens[i];
    if (subcmd && GIT_SAFE_SUBCOMMANDS.has(subcmd)) return { clean: true };
    return { clean: false, rule: `git subcommand '${subcmd}' not in safe set` };
  }
  if (SAFE_COMMANDS.has(first)) return { clean: true };
  return { clean: false, rule: `first token '${first}' not in safe set` };
}

// ─── Pure: resolvesUnderProtected(path, protectedPaths) ───
export function resolvesUnderProtected(path, protectedPaths) {
  if (typeof path !== "string" || !path) return false;
  for (const pp of protectedPaths) {
    if (path === pp) return true;
    if (path.startsWith(pp + "/")) return true;
  }
  return false;
}

// ─── Pure: extractPatchPaths(input) ───
export function extractPatchPaths(input) {
  if (typeof input !== "string" || !input) return [];
  const paths = [];
  for (const line of input.split("\n")) {
    const m = line.match(/^\*\*\* (?:Update File|Add File|Delete File):\s*(.+)$/);
    if (m) paths.push(m[1].trim());
  }
  return paths;
}

// ─── Pure: laneForPath(path, cfg) — longest lane match; null if excluded/unprotected/not a lane ───
// Returns the lane NAME whose path is the longest prefix match. Excluded paths
// and lanes marked protected:false return null (no write protection).
export function laneForPath(path, cfg = {}) {
  const lanes = cfg.lanes || DEFAULT_LANES;
  const excludePaths = cfg.excludePaths || DEFAULT_EXCLUDE_PATHS;
  if (typeof path !== "string" || !path) return null;
  if (resolvesUnderProtected(path, excludePaths)) return null;
  let best = null;
  let bestLen = -1;
  for (const lane of lanes) {
    if (!lane || typeof lane.path !== "string" || !lane.name) continue;
    if (resolvesUnderProtected(path, [lane.path]) && lane.path.length > bestLen) {
      best = lane.name; // longest match wins — unprotected lanes claim their subtree
      bestLen = lane.path.length;
    }
  }
  return best;
}

// lane def lookup by name (null if unknown)
function laneByName(name, cfg = {}) {
  for (const lane of cfg.lanes || []) {
    if (lane?.name === name) return lane;
  }
  return null;
}

// ─── Pure: collectTouchedLanes({command, workdir}, cfg) — protected lanes touched ───
// Over-approximate, conservative: command text mentioning a protected lane path,
// or workdir under one. Excluded refs are stripped first.
export function collectTouchedLanes({ command, workdir } = {}, cfg = {}) {
  const touched = new Set();
  const excludePaths = cfg.excludePaths || DEFAULT_EXCLUDE_PATHS;
  let scan = typeof command === "string" ? command : "";
  for (const xp of excludePaths) scan = scan.split(xp).join("");

  const lanes = (cfg.lanes || []).filter((l) => l?.path && l?.name);
  if (scan && lanes.length > 0) {
    // Per-occurrence longest match: each mention position resolves to the
    // longest lane path starting exactly there (po claims its subtree;
    // a separate mention elsewhere still resolves to its own lane).
    const escaped = lanes
      .slice()
      .sort((a, b) => b.path.length - a.path.length)
      .map((l) => l.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp("(" + escaped.join("|") + ")", "g");
    for (const m of scan.matchAll(re)) {
      const idx = m.index;
      // longest lane path matching at this exact occurrence
      let winner = null;
      for (const lane of lanes) {
        if (scan.startsWith(lane.path, idx) && (!winner || lane.path.length > winner.path.length)) {
          winner = lane;
        }
      }
      if (winner && winner.protected !== false) touched.add(winner.name);
    }
    // cd target resolves via path-prefix semantics
    const mcd = scan.match(/\bcd\s+(?:["']?)(\S+)/);
    if (mcd) {
      const cdTarget = mcd[1].replace(/["']/g, "");
      const wl = laneForPath(cdTarget, cfg);
      if (wl && laneByName(wl, cfg)?.protected !== false) touched.add(wl);
    }
  }
  const wl = workdir ? laneForPath(workdir, cfg) : null;
  if (wl) {
    const def = laneByName(wl, cfg);
    if (def && def.protected !== false) touched.add(wl);
  }
  return touched;
}

// ─── Pure: bindingActive(binding, now) ───
export function bindingActive(binding, now) {
  if (!binding || typeof binding.lane !== "string") return false;
  if (typeof binding.expiresAt === "number" && binding.expiresAt <= now) return false;
  return true;
}

// ─── helpers ───
function laneAllowedForState(lane, state) {
  if (state.armed && state.armed.includes(lane)) return true; // arm overrides
  if (bindingActive(state.binding, state.now) && state.binding.lane === lane) return true; // own lane
  return false;
}

function makeBlockReason(rule, detail) {
  return (
    `lane-guard: cross-lane write blocked (${rule}). ` +
    `Arm via sudo: /usr/local/lib/lane-guard/bin/lane-guard-arm <minutes> <lane> ` +
    `(or bind the session to this lane). Offending: ${detail}`
  );
}

// ─── Pure: decide(toolName, params, state, cfg) ───
// state: { now, armed: [laneNames], binding: {lane, boundAt, expiresAt?}|null, requesterIsOwner }
export function decide(toolName, params, state = {}, cfg = {}) {
  const tool = (typeof toolName === "string" ? toolName : "").toLowerCase().trim();
  const GUARDED_TOOLS = new Set(["exec", "write", "edit", "apply_patch", "patch"]);
  if (!GUARDED_TOOLS.has(tool)) return { action: "allow" };

  const now = typeof state.now === "number" ? state.now : Date.now();
  const armed = Array.isArray(state.armed) ? state.armed : [];
  const binding = state.binding || null;
  const st = { now, armed, binding, requesterIsOwner: state.requesterIsOwner === true };

  try {
    // ── owner gate for the bind CLI ──
    // lane-guard-bind changes session↔lane policy; only an owner-originated
    // request may run it through the agent lane. (sudoers still governs the
    // binary; this gate stops non-owner sessions from invoking it via tools.)
    if (tool === "exec" && typeof params?.command === "string" && params.command.includes("lane-guard-bind")) {
      if (!st.requesterIsOwner) {
        return {
          action: "block",
          blockReason: makeBlockReason("lane-guard-bind requires owner requester", params.command),
        };
      }
      // LG-002: owner falls THROUGH to the normal exec scan below — the CLI
      // invocation itself touches no lane, but a chained write into a
      // protected lane must still be checked. Never allow the whole command.
    }

    // ── owner gate for the lane CLI ──
    // lane-guard-lane rewrites lane policy config (add/update lanes); only an
    // owner-originated request may run it through the agent lane. (sudoers
    // still governs the binary; this gate stops non-owner sessions from
    // invoking it via tools.)
    if (tool === "exec" && typeof params?.command === "string" && params.command.includes("lane-guard-lane")) {
      if (!st.requesterIsOwner) {
        return {
          action: "block",
          blockReason: makeBlockReason("lane-guard-lane requires owner requester", params.command),
        };
      }
      // LG-002: owner falls THROUGH — same rule as the bind gate above.
    }

    // ── write/edit ──
    if (tool === "write" || tool === "edit") {
      const path = params?.path;
      if (typeof path !== "string") return { action: "allow" };
      const lane = laneForPath(path, cfg);
      if (!lane) return { action: "allow" }; // excluded / non-lane
      if (laneByName(lane, cfg)?.protected === false) return { action: "allow" }; // bind target
      if (laneAllowedForState(lane, st)) return { action: "allow" };
      return { action: "block", blockReason: makeBlockReason(`lane '${lane}' not armed/bound`, path) };
    }

    // ── apply_patch / patch ──
    if (tool === "apply_patch" || tool === "patch") {
      const input = params?.input;
      if (typeof input !== "string") return { action: "allow" };
      for (const p of extractPatchPaths(input)) {
        const lane = laneForPath(p, cfg);
        if (!lane) continue;
        if (laneByName(lane, cfg)?.protected === false) continue; // bind target
        if (laneAllowedForState(lane, st)) continue;
        return { action: "block", blockReason: makeBlockReason(`lane '${lane}' not armed/bound`, p) };
      }
      return { action: "allow" };
    }

    // ── exec ──
    if (tool === "exec") {
      const touched = collectTouchedLanes({ command: params?.command, workdir: params?.workdir }, cfg);
      if (touched.size === 0) return { action: "allow" };
      const grammar = isReadOnlyGrammar(params?.command || "");
      if (grammar.clean) return { action: "allow" }; // unarmed reads always pass
      for (const lane of touched) {
        if (!laneAllowedForState(lane, st)) {
          return {
            action: "block",
            blockReason: makeBlockReason(`lane '${lane}' not armed/bound`, params?.command || ""),
          };
        }
      }
      return { action: "allow" };
    }

    return { action: "allow" };
  } catch (err) {
    return {
      action: "block",
      blockReason: `lane-guard: internal error (fail-closed): ${err?.message || String(err)}`,
    };
  }
}

// ─── Config resolution ───
function resolveConfig(api) {
  const defaults = {
    lanes: DEFAULT_LANES,
    excludePaths: DEFAULT_EXCLUDE_PATHS,
    stateDir: DEFAULT_STATE_DIR,
    armMaxMinutes: DEFAULT_ARM_MAX_MINUTES,
  };
  if (
    api?.pluginConfig &&
    typeof api.pluginConfig === "object" &&
    Object.keys(api.pluginConfig).length > 0
  ) {
    return {
      lanes: Array.isArray(api.pluginConfig.lanes) ? api.pluginConfig.lanes : defaults.lanes,
      excludePaths: Array.isArray(api.pluginConfig.excludePaths) ? api.pluginConfig.excludePaths : defaults.excludePaths,
      stateDir: typeof api.pluginConfig.stateDir === "string" ? api.pluginConfig.stateDir : defaults.stateDir,
      armMaxMinutes: typeof api.pluginConfig.armMaxMinutes === "number" ? api.pluginConfig.armMaxMinutes : defaults.armMaxMinutes,
    };
  }
  try {
    const raw = readFileSync(join(__dirname, "config.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      lanes: Array.isArray(parsed.lanes) ? parsed.lanes : defaults.lanes,
      excludePaths: Array.isArray(parsed.excludePaths) ? parsed.excludePaths : defaults.excludePaths,
      stateDir: typeof parsed.stateDir === "string" ? parsed.stateDir : defaults.stateDir,
      armMaxMinutes: typeof parsed.armMaxMinutes === "number" ? parsed.armMaxMinutes : defaults.armMaxMinutes,
    };
  } catch {
    return defaults;
  }
}

// ─── Runtime state readers (fresh per call; missing state = disarmed, fail-safe) ───
function readArmedLanes(cfg, api) {
  const armed = [];
  for (const lane of cfg.lanes || []) {
    if (!lane?.name) continue;
    const armFile = join(cfg.stateDir, `ARMED.${lane.name}`);
    try {
      const content = readFileSync(armFile, "utf-8");
      const stat = statSync(armFile);
      const r = isArmed(content, stat.mtimeMs, Date.now(), cfg.armMaxMinutes);
      if (r.warning) {
        try { api?.logger?.warn?.(`lane-guard: ${armFile}: ${r.warning}`); } catch {}
      }
      if (r.armed) armed.push(lane.name);
    } catch {
      // no arm file for this lane — not armed
    }
  }
  return armed;
}

function readBindings(cfg) {
  try {
    const raw = readFileSync(join(cfg.stateDir, "bindings.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

import * as node_fs_shim from "node:fs";

// ─── Plugin entry ───
function buildPluginEntry() {
  if (!definePluginEntry) return null;
  return definePluginEntry({
    id: "lane-guard",
    name: "Lane Guard",
    description:
      "Generalized cross-lane pollution barrier: per-lane protected directories, per-lane sudo arm windows, owner-gated session bindings with child inheritance. Fires on exec, write, edit, apply_patch at priority 900.",
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        lanes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              path: { type: "string" },
              protected: { type: "boolean" },
              description: { type: "string" },
            },
          },
          description: "Lanes: protected directories (protected defaults true; protected:false = bind target only)",
        },
        excludePaths: {
          type: "array",
          items: { type: "string" },
          description: "Paths excluded from all lane protection (exclusion wins)",
        },
        stateDir: { type: "string", description: "State dir for ARMED.<lane> files and bindings.json" },
        armMaxMinutes: { type: "number", description: "Maximum arm window in minutes (default 60)" },
      },
    },
    register(api) {
      // LG-001: lanes config is resolved FRESH on every tool call (and every
      // subagent_spawned) — never cached across the plugin lifetime. A lane
      // added/removed via lane-guard-lane must protect/unprotect the next
      // call without a gateway restart.
      api.on(
        "before_tool_call",
        async (event, ctx) => {
          const cfg = resolveConfig(api);
          const toolName = event?.toolName;
          const params = event?.params;
          if (!toolName || !params) return;

          const armed = readArmedLanes(cfg, api);
          const sessionKey = ctx?.sessionKey;
          const bindingRaw = sessionKey ? readBindings(cfg)[sessionKey] : null;
          const binding =
            bindingRaw && bindingActive(bindingRaw, Date.now()) ? bindingRaw : null;

          const state = {
            now: Date.now(),
            armed,
            binding,
            requesterIsOwner: ctx?.requester?.senderIsOwner === true,
          };

          const result = decide(toolName, params, state, cfg);
          if (result.action === "block") {
            try { api?.logger?.warn?.(`lane-guard: BLOCKED ${toolName} — ${result.blockReason}`); } catch {}
            return { block: true, blockReason: result.blockReason };
          }
          return undefined;
        },
        { priority: 900 },
      );

      // Child inheritance: a spawned subagent inherits the parent's lane binding.
      api.on("subagent_spawned", async (event, ctx) => {
        try {
          const cfg = resolveConfig(api);
          const childKey = event?.childSessionKey || event?.targetSessionKey;
          const parentKey = event?.parentSessionKey || ctx?.sessionKey;
          if (!childKey || !parentKey) return;
          const parentBinding = readBindings(cfg)[parentKey];
          if (!parentBinding || !bindingActive(parentBinding, Date.now())) return;
          const { mkdirSync, writeFileSync, readFileSync: rf } = node_fs_shim;
          const bindingsPath = join(cfg.stateDir, "bindings.json");
          let bindings = {};
          try {
            bindings = JSON.parse(rf(bindingsPath, "utf-8") || "{}");
          } catch { bindings = {}; }
          if (!bindings[childKey]) {
            bindings[childKey] = parentBinding;
            mkdirSync(cfg.stateDir, { recursive: true });
            writeFileSync(bindingsPath, JSON.stringify(bindings, null, 2));
            try { api?.logger?.info?.(`lane-guard: child ${childKey} inherited lane binding '${parentBinding.lane}' from ${parentKey}`); } catch {}
          }
        } catch (err) {
          try { api?.logger?.warn?.(`lane-guard: subagent_spawned inheritance failed: ${err?.message}`); } catch {}
        }
      });
    },
  });
}

export default buildPluginEntry();
