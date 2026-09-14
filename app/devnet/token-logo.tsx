import Image from "next/image";

const logos: Record<string, string> = {
  MockSPYx: "/token-logos/SPYx.png",
  MockNVDAx: "/token-logos/NVDAx.png",
  MockQQQx: "/token-logos/QQQx.png",
  MockTSLAx: "/token-logos/TSLAx.png",
};

export function TokenLogo({
  symbol,
  size = 40,
}: {
  symbol: string;
  size?: number;
}) {
  const src = logos[symbol];
  if (!src) return null;
  return (
    <Image
      className="mock-token-logo"
      src={src}
      width={size}
      height={size}
      alt=""
      unoptimized
    />
  );
}
