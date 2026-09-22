// Light registry with no web3 dependencies, so the launch UI can check whether
// a chosen pair is deployable without pulling in the transaction runtime.
import quoteAssets from "./quote-assets.json";

export type QuoteAsset = (typeof quoteAssets.assets)[number];
export const quoteAssetList: QuoteAsset[] = quoteAssets.assets;
export const quoteAssetBySymbol = (symbol: string) =>
  quoteAssetList.find((a) => a.symbol === symbol);
export const isDeployableQuote = (symbol: string) =>
  !!quoteAssetBySymbol(symbol);
/** Display symbol for a market's quote mint. Markets differ, so never assume mSPY. */
export const quoteSymbolOf = (mint: string) =>
  quoteAssetList.find((a) => a.mint === mint)?.symbol ?? "quote";
