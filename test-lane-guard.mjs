// test-lane-guard.mjs — TDD suite for lane-guard
// Run: node test-lane-guard.mjs
// All fixtures are generic — no real host paths.

import {
  isArmed,
  isReadOnlyGrammar,
  resolvesUnderProtected,
  extractPatchPaths,
  laneForPath,
  collectTouchedLanes,
  bindingActive,
  decide,
} from "./index.js";

let pass = 0, fail = 0;

function ok(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log("  PASS  " + name); }
  else {
    fail++; console.log("  FAIL  " + name);
    console.log("    expected: " + e);
    console.log("    got:      " + a);
  }
}

const NOW = Date.parse("2026-10-07T16:00:00Z");

// Test config: tenants (protected), app (unprotected bind target), archive (protected).
const cfg = {
  lanes: [
    { name: "tenants", path: "/srv/tenants" },
    { name: "app", path: "/srv/apps/myapp", protected: false },
    { name: "archive", path: "/srv/archive/cases" },
  ],
  excludePaths: ["/srv/archive/cases/drafts"],
  stateDir: "/var/lib/lane-guard",
  armMaxMinutes: 60,
};

const APP = "/srv/apps/myapp";
const BOUND_APP = { lane: "app", boundAt: NOW - 1000, expiresAt: NOW + 86400000 };
const BOUND_TENANTS = { lane: "tenants", boundAt: NOW - 1000, expiresAt: NOW + 86400000 };
const EXPIRED = { lane: "app", boundAt: NOW - 90000000, expiresAt: NOW - 60000 };
const U = { now: NOW, armed: [], binding: null, requesterIsOwner: false };

console.log("\n[reused pure fns]");
ok("future ISO → armed", isArmed("2026-10-07T17:00:00Z", NOW, NOW).armed, true);
ok("past ISO → not armed", isArmed("2026-10-07T15:00:00Z", NOW, NOW).armed, false);
ok("stale mtime → not armed", isArmed("2026-10-07T17:00:00Z", Date.parse("2026-10-06T00:00:00Z"), NOW, 60).armed, false);
ok("cat → clean", isReadOnlyGrammar("cat /srv/tenants/x").clean, true);
ok("bash → dirty", isReadOnlyGrammar("bash scripts/run.sh").clean, false);
ok("pipe → dirty", isReadOnlyGrammar("cat a | grep b").clean, false);
ok("under → true", resolvesUnderProtected("/srv/tenants/x", ["/srv/tenants"]), true);
ok("boundary → false", resolvesUnderProtected("/srv/tenants-docs", ["/srv/tenants"]), false);
ok("extract patch path", extractPatchPaths("*** Update File: /srv/tenants/x\n*** End Patch"), ["/srv/tenants/x"]);

console.log("\n[laneForPath — longest match; exclusion and unprotected → null]");
ok("app dir → app (longest match)", laneForPath(APP + "/.env", cfg), "app");
ok("tenant file → tenants", laneForPath("/srv/tenants/pull.sh", cfg), "tenants");
ok("archive case → archive", laneForPath("/srv/archive/cases/case-7/x.md", cfg), "archive");
ok("excluded path → null", laneForPath("/srv/archive/cases/drafts/x.md", cfg), null);
ok("unrelated → null", laneForPath("/srv/workspaces/agents/x.md", cfg), null);
ok("no lanes → null", laneForPath("/srv/tenants/x", { lanes: [], excludePaths: [] }), null);

console.log("\n[collectTouchedLanes — protected lanes only]");
ok("app-only command → []", [...collectTouchedLanes({ command: "python3 " + APP + "/scripts/seed.js" }, cfg)].sort(), []);
ok("tenant command → [tenants]", [...collectTouchedLanes({ command: "sed -i s/a/b/ /srv/tenants/pull.sh" }, cfg)].sort(), ["tenants"]);
ok("workdir app → []", [...collectTouchedLanes({ command: "docker compose up -d app", workdir: APP }, cfg)].sort(), []);
ok("app cmd + archive → [archive]", [...collectTouchedLanes({ command: "cp " + APP + "/.env /srv/archive/cases/x" }, cfg)].sort(), ["archive"]);
ok("no touch → []", [...collectTouchedLanes({ command: "ls -la" }, cfg)].sort(), []);
ok("cd tenant → [tenants]", [...collectTouchedLanes({ command: "cd /srv/tenants && bash x.sh" }, cfg)].sort(), ["tenants"]);

console.log("\n[bindingActive]");
ok("valid binding → true", bindingActive(BOUND_APP, NOW), true);
ok("expired → false", bindingActive(EXPIRED, NOW), false);
ok("no expiresAt → true", bindingActive({ lane: "app", boundAt: NOW - 1000 }, NOW), true);
ok("null → false", bindingActive(null, NOW), false);

console.log("\n[decide — write/edit/patch per lane]");
ok("write app unarmed unbound → allow (unprotected bind target)",
  decide("write", { path: APP + "/.env" }, U, cfg).action, "allow");
ok("write app bound app → allow",
  decide("write", { path: APP + "/.env" }, { ...U, binding: BOUND_APP }, cfg).action, "allow");
ok("write tenants unarmed unbound → block",
  decide("write", { path: "/srv/tenants/pull.sh" }, U, cfg).action, "block");
ok("write tenants armed(tenants) → allow",
  decide("write", { path: "/srv/tenants/pull.sh" }, { ...U, armed: ["tenants"] }, cfg).action, "allow");
ok("write tenants bound(tenants) → allow (own lane)",
  decide("write", { path: "/srv/tenants/pull.sh" }, { ...U, binding: BOUND_TENANTS }, cfg).action, "allow");
ok("write tenants bound(app) → block (cross-lane)",
  decide("write", { path: "/srv/tenants/pull.sh" }, { ...U, binding: BOUND_APP }, cfg).action, "block");
ok("write tenants bound(app) + armed(tenants) → allow (arm overrides)",
  decide("write", { path: "/srv/tenants/pull.sh" }, { ...U, binding: BOUND_APP, armed: ["tenants"] }, cfg).action, "allow");
ok("write archive bound(app) → block (cross-lane)",
  decide("write", { path: "/srv/archive/cases/case-7/x.md" }, { ...U, binding: BOUND_APP }, cfg).action, "block");
ok("write archive unarmed unbound → block",
  decide("write", { path: "/srv/archive/cases/case-7/x.md" }, U, cfg).action, "block");
ok("edit app bound app → allow",
  decide("edit", { path: APP + "/docker-compose.yml" }, { ...U, binding: BOUND_APP }, cfg).action, "allow");
ok("apply_patch app armed app → allow",
  decide("apply_patch", { input: "*** Update File: " + APP + "/src/app.js\n*** End Patch" }, { ...U, armed: ["app"] }, cfg).action, "allow");
ok("apply_patch tenants unarmed → block",
  decide("apply_patch", { input: "*** Update File: /srv/tenants/projects/po/x\n*** End Patch" }, U, cfg).action, "block");
ok("write excluded path → allow",
  decide("write", { path: "/srv/archive/cases/drafts/x.md" }, U, cfg).action, "allow");
ok("write non-lane path → allow",
  decide("write", { path: "/srv/workspaces/agents/x.md" }, U, cfg).action, "allow");
ok("expired binding = no binding → block on tenants",
  decide("write", { path: "/srv/tenants/pull.sh" }, { ...U, binding: EXPIRED }, cfg).action, "block");

console.log("\n[decide — exec]");
ok("exec cat app unarmed → allow",
  decide("exec", { command: "cat " + APP + "/README" }, U, cfg).action, "allow");
ok("exec dirty workdir app unarmed → allow (app unprotected)",
  decide("exec", { command: "bash scripts/deploy.sh", workdir: APP }, U, cfg).action, "allow");
ok("exec dirty tenants unarmed → block",
  decide("exec", { command: "python3 /srv/tenants/pull.py" }, U, cfg).action, "block");
ok("exec dirty tenants bound(app) → block (cross-lane)",
  decide("exec", { command: "python3 /srv/tenants/pull.py" }, { ...U, binding: BOUND_APP }, cfg).action, "block");
ok("exec dirty tenants bound(tenants) → allow",
  decide("exec", { command: "python3 /srv/tenants/pull.py" }, { ...U, binding: BOUND_TENANTS }, cfg).action, "allow");
ok("exec dirty tenants armed → allow",
  decide("exec", { command: "python3 /srv/tenants/pull.py" }, { ...U, armed: ["tenants"] }, cfg).action, "allow");
ok("exec cp app→tenants bound(app) → block (tenants dest)",
  decide("exec", { command: "cp " + APP + "/.env /srv/tenants/" }, { ...U, binding: BOUND_APP }, cfg).action, "block");
ok("exec git status tenants unarmed → allow (read-only)",
  decide("exec", { command: "git -C /srv/tenants status" }, U, cfg).action, "allow");
ok("exec non-lane command → allow",
  decide("exec", { command: "bash /srv/tools/run.sh" }, U, cfg).action, "allow");
ok("exec dirty archive + tenants → block (any unallowed blocks)",
  decide("exec", { command: "cp /srv/archive/cases/a /srv/tenants/b" }, { ...U, armed: ["tenants"] }, cfg).action, "block");

console.log("\n[decide — bind tool owner gate]");
ok("exec lane-guard-bind owner → allow",
  decide("exec", { command: "sudo /usr/local/lib/lane-guard/bin/lane-guard-bind app sess-123" }, { ...U, requesterIsOwner: true }, cfg).action, "allow");
ok("exec lane-guard-bind non-owner → block",
  decide("exec", { command: "sudo /usr/local/lib/lane-guard/bin/lane-guard-bind app sess-123" }, { ...U, requesterIsOwner: false }, cfg).action, "block");
ok("exec lane-guard-bind --unbind owner → allow",
  decide("exec", { command: "sudo /usr/local/lib/lane-guard/bin/lane-guard-bind --unbind sess-123" }, { ...U, requesterIsOwner: true }, cfg).action, "allow");
ok("exec lane-guard-arm non-owner → allow (not plugin-gated; sudoers governs)",
  decide("exec", { command: "sudo /usr/local/lib/lane-guard/bin/lane-guard-arm 30 tenants" }, { ...U, requesterIsOwner: false }, cfg).action, "allow");

console.log("\n[decide — misc]");
ok("read tool → allow", decide("read", { path: "/srv/tenants/x" }, U, cfg).action, "allow");
ok("block reason mentions lane name",
  decide("write", { path: "/srv/tenants/pull.sh" }, U, cfg).blockReason.includes("tenants"), true);
ok("block reason mentions lane-guard",
  decide("write", { path: "/srv/tenants/pull.sh" }, U, cfg).blockReason.includes("lane-guard"), true);
ok("patch alias → block",
  decide("patch", { input: "*** Update File: /srv/tenants/x\n*** End Patch" }, U, cfg).action, "block");

// ─── Summary ───
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);