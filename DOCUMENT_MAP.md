# Document Map

| What you are looking for | Where it lives |
|---|---|
| Source of truth | this repo (`~/projects/lane-guard/`) |
| GitHub remote | `https://github.com/gregb100/lane-guard.git` (private) |
| Runtime install target (root-owned policy) | `/usr/local/lib/lane-guard/` |
| Dev/extension copy | `~/.openclaw/extensions/lane-guard/` |
| Plugin code | `index.js` (pure policy fns + `register()`) |
| Arm CLI | `bin/lane-guard-arm` (per-lane TTL window, capped) |
| Bind CLI | `bin/lane-guard-bind` (session↔lane bindings, TTL default 24h, prune-on-write) |
| Lane policy config | `config.json` (lanes / excludePaths / stateDir / armMaxMinutes) — `config.example.json` is the template |
| Test suite | `test-lane-guard.mjs` — `node test-lane-guard.mjs` (58 tests) |
| Design record | `PROOF.md` (REQUIRE / DELETE / manual proof / machine owners) |
| Agent skill | `SKILL.md` (this repo); live copy at the gateway workspace skills dir |
| Runtime state (not in repo) | `/var/lib/lane-guard/` — `ARMED.<lane>`, `bindings.json` |

## PROMPT → TASKS → GOALS → TOOLS → DATA → OUTPUTS

- **PROMPT** — AI agents with broad filesystem reach must not write across protected directory boundaries ("lanes") without an explicit, human-granted, time-boxed permission.
- **TASKS** — 1. Plugin blocks exec/write/edit/apply_patch on protected lanes. 2. Per-lane arm CLIs (TTL, sudo-gated). 3. Owner-gated session bindings + subagent inheritance. 4. Skill + tests + docs.
- **GOALS** — Cross-lane write blocked unless armed/bound (58-test suite green); unarmed reads never blocked; other sessions never hindered by another session's binding; all permission windows expire.
- **TOOLS** — OpenClaw plugin hooks (`before_tool_call`, `subagent_spawned`), `sudo` NOPASSWD sudoers, `jq` (bind CLI), node test suite.
- **DATA** — `config.json` lanes, `/var/lib/lane-guard/*` arm/bind state, tool-call params.
- **OUTPUTS** — allow/block decisions, ARMED files, bindings.json, this map.

## Sync law

Changes land in this repo first, then `sudo cp -a` to the root-owned runtime target (`/usr/local/lib/lane-guard`) with a parity check. The gateway loads the plugin from the runtime target; state in `/var/lib/lane-guard` is machine-local and never enters the repo. `config.json` on each host carries that host's lanes — the repo ships only `config.example.json`.