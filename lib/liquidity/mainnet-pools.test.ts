import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_POOL_TVL_USD,
  PAGE_SIZE,
  compactUsd,
  meteoraPoolUrl,
  mergePools,
  parsePools,
  percentText,
  transferFeeAt,
} from "./mainnet-pools.ts";

const NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";
const OPENAI = "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF";
const SOL = "So11111111111111111111111111111111111111112";
const FAKE = "7XmaUUj2PQw2sQvPKkomKUQXFNtqzMo2DURHhrk7rnN2";
const row = (address: string, x: string, y: string, tvl: number, extra: object = {}) => ({
  address,
  token_x: { address: x, symbol: x === SOL ? "SOL" : "TOKEN", is_verified: x === SOL },
  token_y: { address: y, symbol: "NVDAx", is_verified: false },
  tvl,
  volume: { "24h": 5000 },
  fees: { "24h": tvl / 50 },
  protocol_fees: { "24h": tvl / 500 },
  pool_config: { base_fee_pct: 0.2 },
  is_blacklisted: false,
  ...extra,
});

test("keeps only live pools holding a real stock mint", () => {
  const { pools, flagged, more } = parsePools("dlmm", {
    data: [
      row("FCn5zw4gAcfRpQgst5ThFuzBGXbbJ6RocVErgC4vJ9j1", SOL, NVDAX, 76_000),
      // A look-alike named NVDAx, found by the name search: not a stock pool.
      row("GNCR91v4bo6DG9ALVDUzNv5wMkawDMLPTA3JfFE95FA6", SOL, FAKE, 50_000),
      row("5uxAKbbymJ6G4RTTPqit7V5sei9hVT2gPY5j1W2cgjd4", SOL, NVDAX, 9_000, { is_blacklisted: true }),
      row("not-an-address", SOL, NVDAX, 9_000),
      row("49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6", SOL, NVDAX, MIN_POOL_TVL_USD - 1),
      null,
    ],
  });
  assert.equal(pools.length, 1);
  assert.equal(flagged, 1);
  assert.equal(more, false);
  const [p] = pools;
  assert.equal(p.y.symbol, "NVDAx");
  assert.equal(p.y.verified, true);
  assert.equal(p.unverified, false);
  assert.deepEqual(p.stocks, ["NVDAx"]);
  assert.deepEqual(p.families, ["xStocks"]);
  // 2% of liquidity in fees, less Meteora's 10% protocol share.
  assert.equal(Number(p.lpFeeTvl24h.toFixed(6)), 1.8);
  assert.equal(meteoraPoolUrl(p), "https://app.meteora.ag/dlmm/FCn5zw4gAcfRpQgst5ThFuzBGXbbJ6RocVErgC4vJ9j1");
});

test("a look-alike keeps its own name and marks the pool unverified", () => {
  const { pools } = parsePools("damm-v2", {
    data: [
      {
        ...row("GNCR91v4bo6DG9ALVDUzNv5wMkawDMLPTA3JfFE95FA6", FAKE, NVDAX, 13_000),
        token_x: { address: FAKE, symbol: "TSLAx", is_verified: false },
      },
    ],
  });
  const [p] = pools;
  assert.equal(p.x.symbol, "TSLAx");
  assert.equal(p.x.stock, false);
  assert.equal(p.unverified, true);
  assert.equal(meteoraPoolUrl(p), "https://app.meteora.ag/dammv2/GNCR91v4bo6DG9ALVDUzNv5wMkawDMLPTA3JfFE95FA6");
});

test("asks for the next page only when a full page ends above the floor", () => {
  const full = (tvl: number) => ({
    pages: 2,
    current_page: 1,
    data: Array.from({ length: PAGE_SIZE }, () => row("FCn5zw4gAcfRpQgst5ThFuzBGXbbJ6RocVErgC4vJ9j1", SOL, NVDAX, tvl)),
  });
  assert.equal(parsePools("dlmm", full(5_000)).more, true);
  assert.equal(parsePools("dlmm", full(10)).more, false);
  assert.equal(parsePools("dlmm", { ...full(5_000), current_page: 2 }).more, false);
});

test("a pool of two stocks is listed once, under both", () => {
  const a = parsePools("dlmm", { data: [row("CQbcYspb3iDF96Ykfru7QY89QTuYXD9mkpxymLMdXrc2", TSLAX, NVDAX, 6_000)] }).pools;
  const b = parsePools("dlmm", { data: [row("CQbcYspb3iDF96Ykfru7QY89QTuYXD9mkpxymLMdXrc2", TSLAX, NVDAX, 6_000)] }).pools;
  const c = parsePools("dlmm", { data: [row("G61ytWwozeNCzUaDRt8UG18jyYTR56fx3j3CbjXxfPVM", OPENAI, NVDAX, 60_000)] }).pools;
  const merged = mergePools([a, b, c]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].tvl, 60_000);
  assert.deepEqual(merged[0].families.sort(), ["PreStocks", "xStocks"]);
  assert.deepEqual(merged[1].stocks, ["TSLAx", "NVDAx"]);
});

test("rejects a body without a pool list, and ignores bad numbers", () => {
  assert.throws(() => parsePools("dlmm", { error: "rate limited" }));
  const [p] = parsePools("dlmm", {
    data: [{ ...row("FCn5zw4gAcfRpQgst5ThFuzBGXbbJ6RocVErgC4vJ9j1", SOL, NVDAX, 2_000), fees: { "24h": "NaN" }, volume: {} }],
  }).pools;
  assert.equal(p.lpFees24h, 0);
  assert.equal(p.volume24h, 0);
});

test("reads the transfer fee in force and a scheduled change", () => {
  // OPENAI on mainnet: 1% since epoch 1039, 3% from epoch 1043.
  const config = {
    olderTransferFee: { epoch: 1039, transferFeeBasisPoints: 100 },
    newerTransferFee: { epoch: 1043, transferFeeBasisPoints: 300 },
  };
  assert.deepEqual(transferFeeAt(config, 1041, 15_395, 432_000), { bps: 100, next: { bps: 300, inDays: 2 } });
  assert.deepEqual(transferFeeAt(config, 1043, 400_000, 432_000), { bps: 300 });
  assert.equal(transferFeeAt(undefined, 1041, 1, 432_000), undefined);
  assert.equal(
    transferFeeAt({ olderTransferFee: { epoch: 0, transferFeeBasisPoints: 0 }, newerTransferFee: { epoch: 0, transferFeeBasisPoints: 0 } }, 1041, 1, 432_000),
    undefined,
  );
});

test("formats money and percents compactly", () => {
  assert.equal(compactUsd(76_674), "$76.7K");
  assert.equal(compactUsd(1_900_000), "$1.9M");
  assert.equal(compactUsd(0.4), "<$1");
  assert.equal(percentText(2.0972), "2.1%");
  assert.equal(percentText(0.25), "0.25%");
});
