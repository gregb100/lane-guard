---
name: "lane-guard"
description: "Cross-lane write barrier for OpenClaw gateways: per-lane protected dirs, per-lane arm windows, owner-gated session bindings. Fires when the operator says 'this lane is X only', a write hits a protected lane, or arm/bind/unbind is needed."
---

# Lane Guard — cross-lane write barrier

## What it is

A root-owned OpenClaw plugin that blocks agent writes to protected directories ("lanes"). Prevents inadvertent cross-directory / cross-lane pollution from any seat — the operator's own agents included. Lives at `/usr/local/lib/lane-guard` — **policy is root-owned; only the operator's sudo changes it.**

## Metal truth

| Artifact | Path |
|---|---|
| Plugin + policy | `/usr/local/lib/lane-guard/` (root:root) |
| Config (lanes, exclusions, caps) | `/usr/local/lib/lane-guard/config.json` |
| Arm windows | `/var/lib/lane-guard/ARMED.<lane>` |
| Session bindings | `/var/lib/lane-guard/bindings.json` |
| Arm CLI | `sudo /usr/local/lib/lane-guard/bin/lane-guard-arm <minutes> <lane>` (NOPASSWD-able, cap from config) |
| Bind CLI | `sudo /usr/local/lib/lane-guard/bin/lane-guard-bind <lane> <sessionKey> [--ttl-hours H]` / `--unbind <sessionKey>` |
| Lane CLI | `sudo /usr/local/lib/lane-guard/bin/lane-guard-lane <name> <path> <true|false> [description]` (owner-gated add/update; never deletes) |
| Test suite | `cd /usr/local/lib/lane-guard && node test-lane-guard.mjs` |

## Semantics (law)

- A **lane** = `{name, path, protected}` in config. `protected:false` = bind target only (claims its subtree away from enclosing protected lanes via longest-path match).
- Write/edit/apply_patch/exec-touch to a **protected** lane is **blocked** unless: that lane is armed, OR the calling session is bound to that lane. Arm overrides binding for the armed lane only.
- **Unarmed reads always pass** (`ls`, `cat`, `git status`, read-only grammar) — never arm for a read.
- **Exclusions win over everything** (`excludePaths` in config).
- Bindings are **per-session** (`sessionKey`-keyed): fencing one session never hinders another. Spawned children inherit the parent binding. TTL default 24h, evaluated at read; every CLI write prunes stale rows.
- `lane-guard-bind` via agent exec requires **owner requester** (`requester.senderIsOwner === true`); non-owner sessions cannot bind, rebind, or unbind through the agent lane.
- `lane-guard-lane` via agent exec requires **owner requester** too. It adds a new lane or flips an existing lane's `protected` flag (absolute paths, lowercase-dash names); **lane removal stays a manual root edit** — the CLI never deletes.
- Any unlisted directory is unprotected — normal agent workspace, unchanged behavior.

## Current lanes

Read them from metal — never assume:

```bash
sudo cat /usr/local/lib/lane-guard/config.json
```

## Procedures

### When the operator says "this lane is X only" / "this session is X lane"
1. Confirm the lane exists in config (command above).
2. Bind the session: `sudo /usr/local/lib/lane-guard/bin/lane-guard-bind <lane> <thisSessionKey>`.
3. From then: writes inside the lane flow freely; writes to other protected lanes are blocked (no arm needed). Children inherit.
4. On "lane done" or moving sessions: `--unbind <sessionKey>`. Stale bindings self-expire via TTL — never lock anything.

### When a protected-lane write is blocked
1. Don't fight it. Tell the operator which lane + what needs writing.
2. If the operator confirms: `sudo /usr/local/lib/lane-guard/bin/lane-guard-arm <minutes> <lane>` — opens **that lane only**, expires automatically (≤ cap).
3. Do the write. No disarm step exists; the window just lapses.

### Adding a lane
Owner says "add lane X" / "lock lane X" → `sudo -n /usr/local/lib/lane-guard/bin/lane-guard-lane <name> <path> <true|false> [description]` (owner-gated; NOPASSWD via sudoers). No code change; no restart — config is read fresh per tool call. **Lane removal stays the operator's manual root edit** — the CLI never deletes a lane.

### Verifying the barrier
1. `node test-lane-guard.mjs` in the installed dir → full suite green.
2. Unarmed write to a protected lane → must BLOCK.
3. Unarmed write to a bind target → must ALLOW.
4. `sudo -n .../bin/lane-guard-arm 3 <lane>` → no password prompt (NOPASSWD verified).

## Rules of engagement

- Never edit `/usr/local/lib/lane-guard` directly as an agent; policy changes route through the operator.
- Never treat a binding as a lock on the directory — it fences the session, not other seats.
- Never arm for reads.
- Lane **policy** edits (`lane-guard-lane`, `config.json`) take effect on the next tool call — no restart. **Code** changes to `index.js` need the runtime sync + a gateway restart; until then the previous generation stays active (fail-safe).
- Repo source of truth is canonical; runtime is a root-owned copy of it. Verify parity after any sync.