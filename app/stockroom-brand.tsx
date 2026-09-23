const SONATA_CURVE = "M76 140C76 66 132 12 204 12H372C372 86 333 138 277 138C228 138 200 101 192 32C184 105 151 140 76 140Z";

export function BrandMark() {
  return (
    <svg
      className="sr-brand-mark"
      width="36"
      height="27"
      viewBox="0 0 384 288"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={SONATA_CURVE} />
      <path d={SONATA_CURVE} transform="rotate(180 192 144)" />
    </svg>
  );
}
