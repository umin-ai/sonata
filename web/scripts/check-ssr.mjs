// Checks that the market list and market pages arrive complete in the server's
// HTML, and that nothing on a market page can be sent before the browser's own
// live read, then times the pages. Read-only: plain GET requests.
//
//   node scripts/check-ssr.mjs <base-url> [runs]
//   node scripts/check-ssr.mjs http://127.0.0.1:5190 10
//
// Exits non-zero when a check fails. Timings are medians over `runs` requests:
// time to first byte, and from the first byte to the last market card's bytes.
const base = (process.argv[2] || "http://localhost:5173").replace(/\/+$/, "");
const runs = Math.max(1, Number(process.argv[3] || 5));
const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** GET with timings: ttfb (ms), the body, and when the last occurrence of `marker` arrived after the first byte. */
async function timed(path, marker) {
  const started = performance.now();
  const r = await fetch(base + path, { headers: { accept: "text/html,application/json", "accept-encoding": "identity" } });
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let body = "",
    first = null,
    lastMarker = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const now = performance.now();
    first ??= now;
    const chunk = decoder.decode(value, { stream: true });
    body += chunk;
    if (marker && chunk.includes(marker)) lastMarker = now;
  }
  const end = performance.now();
  return {
    status: r.status,
    headers: r.headers,
    body,
    ttfb: (first ?? end) - started,
    toMarker: lastMarker === null ? null : lastMarker - (first ?? end),
    total: end - started,
  };
}

const text = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
// Each card's markup, from one card's opening tag to the next.
const cards = (html) =>
  html
    .split(/(?=<div[^>]*class="[^"]*sonata-token-card)/)
    .slice(1)
    .map((chunk) => chunk.split(/<section|<\/section>/)[0]);
const buttons = (html) =>
  [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, inner]) => ({
    disabled: /\sdisabled(=|\s|$|>)/.test(` ${attrs} `) || /\sdisabled=""/.test(attrs),
    label: text(inner).trim(),
  }));

// ---- /api/markets ------------------------------------------------------------
const api = await timed("/api/markets");
let snapshot = null;
try {
  snapshot = JSON.parse(api.body);
} catch {
  /* reported below */
}
check(api.status === 200 && snapshot?.v === 1 && Array.isArray(snapshot.entries), `/api/markets answers a snapshot (HTTP ${api.status})`);
if (!snapshot?.entries?.length) {
  console.log("No snapshot: the pages fall back to the browser's chain read. Nothing more to check.");
  process.exit(1);
}
check(
  snapshot.entries.every((e) => typeof e.market?.pool === "string" && typeof e.market?.symbol === "string" && ("data" in e)),
  `every entry has an identity and card data (${snapshot.entries.length} markets, ${snapshot.skipped?.length ?? 0} skipped, ${Math.round(snapshot.ageMs / 1000)} s old)`,
);
check(api.headers.get("cache-control") === "no-store", "/api/markets is never cached");

// ---- Home --------------------------------------------------------------------
const home = await timed("/", "sonata-token-card");
const homeCards = cards(home.body);
check(home.status === 200, `/ answers 200`);
check(homeCards.length === snapshot.entries.length, `/ has a card per market (${homeCards.length} of ${snapshot.entries.length})`);
check(!home.body.includes("nm-market-skeleton"), "/ has no loading skeletons");
const withData = snapshot.entries.filter((e) => e.data).length;
check(homeCards.filter((c) => /MC <b>/.test(c)).length === withData, `every card with numbers shows its market cap (${withData})`);
check(
  homeCards.filter((c) => c.includes("market-card-stats")).length === (snapshot.stats ? homeCards.length : 0),
  snapshot.stats ? "every card shows its 24h stats" : "no stats in the snapshot (the indexer's /stats was unavailable)",
);
const images = Object.values(snapshot.profiles ?? {}).filter((p) => p.image).length;
check(images === 0 || /class="token-image"/.test(home.body), `card images are in the HTML (${images} profiles with an image)`);

// ---- Market pages: a curve market, a graduated one and a Backed one ------------
const pick = (label, test) => {
  const entry = snapshot.entries.find((e) => e.data && test(e));
  if (!entry) console.log(`(no ${label} market in the snapshot)`);
  return entry && { label, entry };
};
const pages = [
  pick("curve", (e) => !e.data.migrated && e.market.mode !== "floor" && e.market.mode !== "standardFloor"),
  pick("graduated", (e) => e.data.migrated),
  pick("Backed", (e) => e.market.mode === "floor" || e.market.mode === "standardFloor"),
].filter(Boolean);
for (const { label, entry } of pages) {
  const path = `/onchain?pool=${entry.market.pool}`;
  const page = await timed(path, "</h1>");
  const h1 = text(page.body.match(/<h1[\s\S]*?<\/h1>/)?.[0] ?? "");
  check(page.status === 200 && h1.includes(entry.market.symbol), `${label} ${entry.market.symbol}: the header is in the HTML`);
  check(!page.body.includes("Verifying market registration"), `${label}: no "Verifying market registration"`);
  check(/Bonding curve progress/.test(page.body) && /Graduated|Bonding curve/.test(text(page.body)), `${label}: status and progress are in the HTML`);
  check(page.body.includes("Reading the market"), `${label}: the swap panel waits for the live read ("Reading the market…")`);
  const actions = buttons(page.body).filter((b) =>
    /Review burn|Withdraw|add now|Send it now|Graduate|Claim fees|^Buy |^Sell /.test(b.label),
  );
  check(actions.every((b) => b.disabled), `${label}: every action is disabled in the HTML (${actions.map((b) => b.label).join(", ") || "none rendered"})`);
}

// ---- Timings -------------------------------------------------------------------
const rows = [];
for (const [name, path, marker] of [
  ["/", "/", "sonata-token-card"],
  ["/api/markets", "/api/markets", null],
  ...pages.slice(0, 1).map(({ entry }) => ["market page", `/onchain?pool=${entry.market.pool}`, "</h1>"]),
]) {
  const samples = [];
  for (let i = 0; i < runs; i++) samples.push(await timed(path, marker));
  rows.push({
    page: name,
    "ttfb ms": Math.round(median(samples.map((s) => s.ttfb))),
    "first byte to last card ms": marker ? Math.round(median(samples.map((s) => s.toMarker ?? NaN))) : "",
    "total ms": Math.round(median(samples.map((s) => s.total))),
    "bytes (uncompressed)": samples[0].body.length,
  });
}
console.table(rows);
if (failures.length) {
  console.log(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("All checks passed.");
