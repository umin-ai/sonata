import { forwardRef, type AnchorHTMLAttributes } from "react";

// A plain anchor in place of next/link. In vinext 1.0.0-beta.5 production
// builds, next/link's lazily loaded navigation module is missing its exports,
// so a click is swallowed and nothing navigates (dev mode is unaffected).
// Upgrading vinext breaks the Solana dependencies' build, so links do a
// normal page load instead. Wallet state survives: the wallet reconnects and
// launch drafts are kept in browser storage.
type Props = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  prefetch?: boolean | null;
  replace?: boolean;
  scroll?: boolean;
};

const Link = forwardRef<HTMLAnchorElement, Props>(function Link(
  { prefetch: _prefetch, replace: _replace, scroll: _scroll, ...props },
  ref,
) {
  return <a ref={ref} {...props} />;
});

export default Link;
