import type { CSSProperties } from "react";

const stockLogos: Record<string, string> = {
  mSPY: "SPYx",
  MockSPYx: "SPYx",
  SPYx: "SPYx",
  mNVDA: "NVDAx",
  MockNVDAx: "NVDAx",
  NVDAx: "NVDAx",
  mQQQ: "QQQx",
  MockQQQx: "QQQx",
  QQQx: "QQQx",
  mTSLA: "TSLAx",
  MockTSLAx: "TSLAx",
  TSLAx: "TSLAx",
  mMSFT: "MSFTx",
  MSFTx: "MSFTx",
  mAMZN: "AMZNx",
  AMZNx: "AMZNx",
  mMETA: "METAx",
  METAx: "METAx",
  mMCD: "MCDx",
  MCDx: "MCDx",
  mANTHROPIC: "ANTHROPIC",
  ANTHROPIC: "ANTHROPIC",
};

// PreStocks' own logos, as its public API lists them (prestocks.com/api/prestocks).
const remoteLogos: Record<string, string> = {
  mOPENAI: "https://www.prestocks.com/logos/openai.png",
  OPENAI: "https://www.prestocks.com/logos/openai.png",
  mSPACEX: "https://www.prestocks.com/logos/spacex.png",
  SPACEX: "https://www.prestocks.com/logos/spacex.png",
  mKALSHI: "https://www.prestocks.com/logos/kalshi.png",
  KALSHI: "https://www.prestocks.com/logos/kalshi.png",
  mPOLYMARKET: "https://www.prestocks.com/logos/polymarket.png",
  POLYMARKET: "https://www.prestocks.com/logos/polymarket.png",
  mANDURIL: "https://www.prestocks.com/logos/anduril.png",
  ANDURIL: "https://www.prestocks.com/logos/anduril.png",
  mFIGUREAI: "https://www.prestocks.com/logos/figureai.png",
  FIGUREAI: "https://www.prestocks.com/logos/figureai.png",
  mNEURALINK: "https://www.prestocks.com/logos/neuralink.png",
  NEURALINK: "https://www.prestocks.com/logos/neuralink.png",
};

/** The logo of a token that has none (or whose image fails to load): a round "?" badge. */
export function TokenFallback({ size = 24 }: { size?: number }) {
  return (
    <span
      className="sr-token-monogram token-fallback"
      style={{ "--token-size": `${size}px` } as CSSProperties}
      aria-hidden="true"
    >
      ?
    </span>
  );
}

/** Mock stock labels stay explicit; a token without a logo gets the "?" badge. */
export function TokenName({
  symbol,
  size = 24,
}: {
  symbol: string;
  size?: number;
}) {
  const logo =
    symbol === "ROOM"
      ? "/favicon.svg"
      : stockLogos[symbol]
        ? `/token-logos/${stockLogos[symbol]}.png`
        : remoteLogos[symbol];
  return (
    <span
      className="sr-token-name"
      style={{ "--token-size": `${size}px` } as CSSProperties}
    >
      {logo ? (
        <img
          src={logo}
          width={size}
          height={size}
          alt=""
          className="sr-token-logo"
        />
      ) : (
        <TokenFallback size={size} />
      )}
      <b>{symbol}</b>
    </span>
  );
}

export function TokenPair({
  base = "ROOM",
  quote = "mSPY",
  size = 28,
}: {
  base?: string;
  quote?: string;
  size?: number;
}) {
  return (
    <span className="sr-token-pair-label">
      <TokenName symbol={base} size={size} />
      <span className="sr-pair-divider">/</span>
      <TokenName symbol={quote} size={size} />
    </span>
  );
}
