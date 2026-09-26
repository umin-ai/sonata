// The market page's rule (panel-state.ts): the server snapshot's numbers are
// display only; only the live read enables anything that trades or moves funds.
import test from "node:test";
import assert from "node:assert/strict";
import fixtureJson from "../../lib/treasury/fixtures/devnet-markets.json" with { type: "json" };
import type { TreasurySnapshot } from "../../lib/treasury/runtime.ts";
import type { CardData } from "../../lib/treasury/market-snapshot.ts";
import { actionsEnabled, panelInit, panelReducer, panelState, snapshotDeadline } from "./panel-state.ts";

type Golden = { markets: { symbol: string; pool: string; mode: string }[]; treasuries: Record<string, TreasurySnapshot> };
const golden = (fixtureJson as unknown as { golden: Golden }).golden;
const byMode = (mode: string) => golden.treasuries[golden.markets.find((m) => m.mode === mode)!.pool];
// A market on its curve, and a graduated one (ROOM), as the live read returns them.
const curve = byMode("floor");
const graduated = byMode("duet");
const card = (t: TreasurySnapshot): CardData => ({ ...t, poolFees: null });
const wallet = { address: "wallet", busy: "", pending: null };

test("the fixture has a curve market and a graduated one with a DAMM v2 pool", () => {
  assert.equal(curve.migrated, false);
  assert.equal(graduated.migrated, true);
  assert.ok(graduated.dammPool);
});

test("with only the snapshot's numbers, nothing is verified and no action is enabled, curve or graduated, hydrated or not", () => {
  for (const snap of [card(curve), card(graduated)])
    for (const hydrated of [false, true]) {
      const { shown, fees, verified } = panelState({ live: null, snap, hydrated });
      assert.equal(shown, snap, "the snapshot's numbers are shown");
      assert.equal(verified, false);
      assert.equal(actionsEnabled({ ...wallet, data: fees, verified }), false);
      assert.equal(actionsEnabled({ ...wallet, data: snap, verified }), false, "whatever data a panel is given");
    }
  // A curve market's fee panels show the snapshot after hydration (countdowns use the time now); a graduated one's never.
  assert.equal(panelState({ live: null, snap: card(curve), hydrated: false }).fees, null);
  assert.ok(panelState({ live: null, snap: card(curve), hydrated: true }).fees);
  assert.equal(panelState({ live: null, snap: card(graduated), hydrated: true }).fees, null);
});

test("the live read enables actions; a graduated market's fee panels wait for its pool fees", () => {
  const live = panelState({ live: curve, snap: null, hydrated: true });
  assert.equal(live.verified, true);
  assert.equal(live.fees, curve);
  assert.equal(actionsEnabled({ ...wallet, data: live.fees, verified: live.verified }), true);
  assert.equal(actionsEnabled({ ...wallet, address: "", data: live.fees, verified: true }), false, "no wallet");
  assert.equal(actionsEnabled({ ...wallet, busy: "Signing…", data: live.fees, verified: true }), false, "busy");
  assert.equal(actionsEnabled({ ...wallet, pending: {}, data: live.fees, verified: true }), false, "pending");
  const partial = panelState({ live: { ...graduated, poolFees: null }, snap: null, hydrated: true });
  assert.equal(partial.verified, true);
  assert.equal(partial.fees, null, "no fee panel numbers until the pool fees are read");
  assert.equal(partial.shown?.migrated, true);
  const complete = panelState({ live: graduated, snap: null, hydrated: true });
  assert.equal(complete.fees, graduated);
});

test("a failed live read clears the snapshot's numbers and shows why", () => {
  let state = panelInit(card(curve));
  state = panelReducer(state, { type: "reading" });
  state = panelReducer(state, { type: "failed", error: "Onchain program or account ownership changed." });
  assert.deepEqual(state, { live: null, snap: null, error: "Onchain program or account ownership changed." });
  assert.equal(panelState({ ...state, hydrated: true }).shown, null);
  // A failure after a live read clears that too: nothing stays on screen as if it were current.
  const after = panelReducer(panelReducer(panelInit(null), { type: "complete", value: curve }), { type: "failed", error: "x" });
  assert.equal(after.live, null);
  // The next refresh clears the error.
  assert.equal(panelReducer(after, { type: "reading" }).error, "");
});

test("the snapshot's numbers expire; a live read replaces them and is not expired", () => {
  const expired = panelReducer(panelInit(card(curve)), { type: "expired" });
  assert.equal(expired.snap, null);
  assert.equal(panelState({ ...expired, hydrated: true }).shown, null, "back to Loading");
  const live = panelReducer(panelInit(card(curve)), { type: "verified", value: curve, partial: false });
  assert.equal(live.snap, null);
  assert.equal(panelReducer(live, { type: "expired" }), live);
  // A minute from when they were read: 45 s old when rendered, they go 15 s into the page's life.
  assert.equal(snapshotDeadline(45_000, 60_000), 15_000);
  assert.equal(snapshotDeadline(60_000, 60_000), 0);
});

test("a graduated market's refresh keeps its last full read until the new one completes", () => {
  const first = panelReducer(panelInit(card(graduated)), { type: "verified", value: { ...graduated, poolFees: null }, partial: true });
  assert.equal(first.live?.poolFees, null, "the first verified read shows at once");
  const full = panelReducer(first, { type: "complete", value: graduated });
  const again = panelReducer(full, { type: "verified", value: { ...graduated, poolFees: null }, partial: true });
  assert.equal(again.live, graduated, "the last full read stays");
});
