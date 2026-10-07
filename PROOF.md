# lane-guard — design record

## What (REQUIRE, one line)
One mechanism that fences **any** protected directory ("lane") from inadvertent agent cross-directory writes, with per-lane arming and owner-gated session bindings — so a multi-agent gateway cannot write past directory boundaries a human hasn't opened.

## DELETE (not built)
No REST API, no UI, no NLP lane parsing, no unbind daemon (TTL evaluated at read), no per-tool policy matrix, no metrics.

## Manual proof
- The friction exists: on the origin host, a routine agent operation (credential rotation in a deployed app under a protected tree) required an explicit human arm — the live case that motivated generalizing from a single-path guard to lanes.
- Barrier proven live: during the generalization sweep, the running plugin blocked the authoring agent's own command whose text merely *mentioned* a protected path — over-approximation working as designed.
- Suite: `node test-lane-guard.mjs` → **58 passed, 0 failed** (RED-first throughout).

## Machine owners
- `decide()` in `index.js` — all policy (pure, tested).
- Root-owned `config.json` — lane list; policy changes need the operator's sudo.
- `/var/lib/lane-guard/ARMED.<lane>` — per-lane arm windows (written by `bin/lane-guard-arm`, sudo-gated, capped).
- `/var/lib/lane-guard/bindings.json` — session→lane bindings (written by `bin/lane-guard-bind`, owner-gated by the plugin).
- Plugin `register()` — reads state fresh per tool call; `subagent_spawned` propagates parent bindings to children.

## Semantics
- Lanes: `{name, path, protected}`; `protected:false` = bind target only (longest-path match claims its subtree away from enclosing protected lanes).
- Write/edit/patch/exec-touch to a protected lane → blocked unless: that lane armed, OR session bound to it. Arm overrides binding for the armed lane only.
- Unarmed reads always pass (read-only grammar allowlist).
- Exclusions win over everything.
- Bind gate: `lane-guard-bind` via exec requires `requester.senderIsOwner === true` (fail-closed; sudoers still governs the binary).
- TTL: bindings carry `expiresAt` (default 24h), evaluated at read; every CLI write prunes stale rows.

## Threat model honesty
Targets **inadvertent** pollution — wrong-directory writes, session confusion, spawn drift. Not a containment boundary against a hostile agent with shell + docker/root-adjacent rights; that's an OS-perms / container-isolation problem, owned elsewhere.

## Test command
`cd /usr/local/lib/lane-guard && node test-lane-guard.mjs` (needs `node_modules/openclaw` symlink to the gateway's OpenClaw install)