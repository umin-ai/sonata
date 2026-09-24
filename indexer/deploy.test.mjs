// deploy/lightsail/setup.sh's update order: the crank's timer is stopped and
// disabled (and a running pass waited for) before any code changes, so not
// even a reboot starts a pass, and enabled again only once the restarted
// indexer has migrated the database. Its wait functions are
// run in bash with systemctl, journalctl and sleep stubbed; nothing else of
// the script runs.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATED_LINE } from "./index.mjs";

const SETUP = fileURLToPath(new URL("../deploy/lightsail/setup.sh", import.meta.url));
const script = readFileSync(SETUP, "utf8");

// systemctl: the timer exists unless TIMER_MISSING=1; sonata-crank.service is
// "activating" for its first RUNNING_FOR reads. journalctl: the indexer's
// invocation prints the migrated line from its MIGRATED_AFTER-th read.
const STUBS = `
count() { local n; n=$(( $(cat "$T/$1" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$T/$1"; echo "$n"; }
systemctl() {
  echo "systemctl $*" >> "$T/calls"
  case "$1 \${2:-}" in
    "cat sonata-crank.timer") [ "\${TIMER_MISSING:-0}" != 1 ] ;;
    "disable --now" | "enable --now") return 0 ;;
    "show -p")
      if [ "\${3:-}" = ActiveState ]; then
        if [ "$(count active)" -le "\${RUNNING_FOR:-0}" ]; then echo activating; else echo inactive; fi
      elif [ "\${3:-}" = InvocationID ]; then echo inv-7; fi ;;
    *) return 1 ;;
  esac
}
journalctl() {
  echo "journalctl $*" >> "$T/calls"
  echo "indexer API on 127.0.0.1:8790"
  echo "not ${MIGRATED_LINE} yet"
  if [ "$(count journal)" -ge "\${MIGRATED_AFTER:-1}" ]; then echo "${MIGRATED_LINE}"; fi
}
sleep() { echo "sleep $*" >> "$T/calls"; }
`;

function run(body, env = {}) {
  const T = mkdtempSync(join(tmpdir(), "sonata-setup-"));
  try {
    const r = spawnSync("bash", ["-c", `${STUBS}\nSONATA_SETUP_FUNCTIONS_ONLY=1 source "$SETUP"\n${body}`], {
      env: { PATH: process.env.PATH, SETUP, T, ...env },
      encoding: "utf8",
    });
    let calls = [];
    try {
      calls = readFileSync(join(T, "calls"), "utf8").trim().split("\n");
    } catch {
      // nothing was called
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls };
  } finally {
    rmSync(T, { recursive: true, force: true });
  }
}

test("setup.sh stops and disables the crank's timer and waits for a running pass before changing anything", () => {
  const r = run("stop_crank", { RUNNING_FOR: "2" });
  assert.equal(r.status, 0, r.stderr);
  // Disabled, not only stopped: a reboot before setup.sh completes starts no pass.
  assert.deepEqual(r.calls, [
    "systemctl cat sonata-crank.timer",
    "systemctl disable --now sonata-crank.timer",
    "systemctl show -p ActiveState --value sonata-crank.service",
    "sleep 5",
    "systemctl show -p ActiveState --value sonata-crank.service",
    "sleep 5",
    "systemctl show -p ActiveState --value sonata-crank.service",
  ]);
  assert.match(r.stdout, /Waiting for the running crank pass to finish/);
  // A first install has no timer to stop and no pass running.
  const first = run("stop_crank", { TIMER_MISSING: "1" });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(first.calls, ["systemctl cat sonata-crank.timer", "systemctl show -p ActiveState --value sonata-crank.service"]);
  // A pass that does not end in time: setup.sh stops there, with the timer stopped.
  const stuck = run("stop_crank", { RUNNING_FOR: "1000", CRANK_WAIT_SECONDS: "10" });
  assert.notEqual(stuck.status, 0);
  assert.match(stuck.stderr, /still running after 10s; nothing updated/);
  assert.equal(stuck.calls.filter((c) => c === "sleep 5").length, 2);
});

test("setup.sh waits for the restarted indexer's own migrated line, and gives up after its limit", () => {
  const r = run("wait_for_migration", { MIGRATED_AFTER: "3" });
  assert.equal(r.status, 0, r.stderr);
  const reads = r.calls.filter((c) => c.startsWith("journalctl"));
  assert.equal(reads.length, 3);
  // Only the current process's entries count, not an earlier start's.
  assert.ok(reads.every((c) => c === "journalctl --no-pager -q -o cat _SYSTEMD_INVOCATION_ID=inv-7"));
  assert.equal(r.calls.filter((c) => c === "sleep 2").length, 2);
  const late = run("wait_for_migration", { MIGRATED_AFTER: "100", MIGRATION_WAIT_SECONDS: "4" });
  assert.notEqual(late.status, 0);
  assert.match(late.stderr, /has not finished its database migration after 4s/);
});

test("setup.sh's order: timer stopped and disabled, code pulled and built, indexer restarted and migrated, then the timer enabled", () => {
  assert.match(script, new RegExp(`^MIGRATED_LINE="${MIGRATED_LINE}"$`, "m"));
  const lines = script.split("\n");
  const at = (re) => {
    const i = lines.findIndex((l) => re.test(l));
    assert.ok(i >= 0, `setup.sh has ${re}`);
    return i;
  };
  const steps = [
    at(/^CRANK_HELD=1$/),
    at(/^stop_crank$/),
    at(/^if \[ -d \$APP_DIR\/\.git \]; then sudo -u sonata git -C \$APP_DIR pull --ff-only$/),
    at(/npm ci --no-audit --no-fund && npm run build/),
    at(/^install -m 644 "\$HERE\/sonata-crank.timer"/),
    at(/^systemctl restart sonata sonata-indexer$/),
    at(/^wait_for_migration$/),
    at(/^systemctl enable --now sonata-crank.timer$/),
    at(/^CRANK_HELD=0$/),
  ];
  assert.deepEqual([...steps].sort((a, b) => a - b), steps);
  // Nothing before the stop touches the code, and nothing restarts the timer on its own.
  assert.ok(!lines.slice(0, steps[1]).some((l) => /git |npm /.test(l) && !/^\s*#/.test(l)));
  assert.ok(!/restart[^\n]*sonata-crank/.test(script));
  // The timer is enabled (so it would start at boot) only by that last step.
  const enables = lines.filter((l) => /^\s*systemctl\b.*\b(enable|start)\b.*sonata-crank/.test(l));
  assert.deepEqual(enables, ["systemctl enable --now sonata-crank.timer"]);
  // Left stopped when any step fails.
  assert.match(script, /trap 'if \[ "\$CRANK_HELD" = 1 \]; then echo "setup.sh did not finish: sonata-crank.timer is left stopped/);

  // The indexer prints the line only after both of its migrations.
  const indexer = readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
  const main = indexer.slice(indexer.indexOf("if (isMain)"));
  const migrated = main.indexOf("console.log(MIGRATED_LINE)");
  assert.ok(main.indexOf("await migrate();") < migrated && main.indexOf("await migrateIndexerSchema(db);") < migrated);
  assert.ok(migrated < main.indexOf("syncer({"));
});
