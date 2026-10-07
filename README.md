# lane-guard

**A fail-closed write barrier between your AI agents and the directories that matter.**

lane-guard is an [OpenClaw](https://github.com/openclaw/openclaw) gateway plugin that blocks agent writes — `exec`, `write`, `edit`, `apply_patch` — from crossing directory boundaries you define, until a human explicitly opens the door. It turns "the agent accidentally trashed the wrong repo" from a recovery story into a blocked tool call.

## Why you want it

- **Contain the blast radius of agent mistakes.** Multi-agent setups mean parallel seats with overlapping filesystem reach. lane-guard fences each protected directory ("lane") so a seat working in one lane physically cannot write into another — no amount of confusion, context pollution, or prompt confusion crosses the fence.
- **Human-in-the-loop by default, not by convention.** Writes to protected lanes need an explicit, time-boxed arm (`sudo`, TTL capped server-side) or an owner-confirmed session binding. No daemon, no standing token, no agent can grant itself access — policy files are root-owned.
- **Reads are never in the way.** `ls`, `cat`, `git status`, log greps — the read-only grammar passes always. Agents stay useful in every lane; they just can't *change* what they can't touch.
- **Per-session lanes, not global locks.** Say "this session is lane X only" and that session tree is fenced — including every subagent it spawns (bindings inherit). Other sessions keep working, each with their own fences and their own arms. One seat's permission never becomes another seat's escape hatch.
- **Everything expires.** Arms cap at 60 minutes; bindings carry a TTL (default 24h) and self-prune. Stale sessions die harmless — no orphaned locks, no cleanup jobs.
- **Fail-closed by construction.** Missing arm file, unparseable state, internal error → blocked. An attacker who can read your state dir learns nothing they can use to open a lane.

## How it works

| Artifact | Role |
|---|---|
| Plugin (`index.js`) | `before_tool_call` policy on exec/write/edit/patch + `subagent_spawned` binding inheritance |
| `bin/lane-guard-arm` | Open one lane for a TTL window (minutes, capped) — `sudo` NOPASSWD-able |
| `bin/lane-guard-bind` | Bind/unbind a session key to a lane (owner-gated, TTL, prune-on-write) |
| `config.json` | All policy: lanes (`{name, path, protected}`), exclusions, caps — root-owned |
| `test-lane-guard.mjs` | Pure-function suite — 58 tests, zero external deps |

**Semantics in one paragraph:** a write to a protected lane is blocked unless that lane is armed *or* the calling session is bound to it. `protected: false` lanes are bind-only targets (their subtree is claimed away from enclosing protected lanes by longest-path match). Unprotected directories behave exactly as before — install changes nothing outside the lanes you list. Exclusions override everything. Bindings key by session: one session's fence never hinders another. Binding through the agent path requires the owner's own request.

## Install

```bash
sudo mkdir -p /usr/local/lib/lane-guard
sudo cp -a . /usr/local/lib/lane-guard/
sudo chown -R root:root /usr/local/lib/lane-guard
sudo find /usr/local/lib/lane-guard -type d -exec chmod 755 {} +
sudo find /usr/local/lib/lane-guard -type f -exec chmod 644 {} +
sudo chmod 755 /usr/local/lib/lane-guard/bin/*
sudo mkdir -p /var/lib/lane-guard && sudo sh -c 'echo "{}" > /var/lib/lane-guard/bindings.json'
```

Then add both CLIs to sudoers (NOPASSWD), point `openclaw.json` `plugins.load.paths` at `/usr/local/lib/lane-guard`, and restart the gateway. See `SKILL.md` and `DOCUMENT_MAP.md`.

## Test

```bash
node test-lane-guard.mjs   # 58 passed
```

The suite imports the plugin SDK via `node_modules/openclaw` — symlink to your global OpenClaw install if needed. No other dependencies.

## Quick start policy

Copy `config.example.json` → `config.json`, define your lanes, restart. Adding a lane later is one line and no code change.