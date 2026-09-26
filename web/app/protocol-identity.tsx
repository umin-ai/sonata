export function MeteoraLabel({
  children = "Meteora",
}: {
  children?: React.ReactNode;
}) {
  return (
    <span className="sr-protocol-name">
      <img src="/protocol-logos/meteora.svg" width={24} height={24} alt="" />
      <strong>{children}</strong>
    </span>
  );
}
