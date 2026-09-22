import legacy from "./deployment.json";
import registry from "./mock-markets.json";

export const marketCatalog = registry.markets;
const legacyMarket = {
  ...legacy,
  id: "legacy",
  symbol: "DemoStock",
  name: "Original demo market",
  multiplier: 1,
};
export function getMarket(id: string) {
  if (id === "legacy") return legacyMarket;
  const market = marketCatalog.find((m) => m.id === id);
  if (!market) throw Error("Unknown Sonata Devnet market.");
  return market;
}
