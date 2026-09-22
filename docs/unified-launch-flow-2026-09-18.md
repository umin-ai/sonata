# Unified launch flow

Rebuilt /create as Token → Pair → Curve → Rewards → Review using a shared settings object. Pair choices: mSPY, mNVDA, mQQQ, mTSLA. Curve market caps and fixed fee feed the official SDK preview automatically. Rewards choices: existing creator split, proposed holder rewards, proposed liquidity allocation. Summary and review use the selected quote currency consistently.

Only the existing mSPY / 2 starting market cap / 12 graduation market cap / 1% / treasury split is deployable. Other choices are explicitly previews and can export JSON; they cannot reach prepareLaunch. SDK-invalid inputs cannot export or submit. Saved existing pool drafts retain treasury activation and recovery behavior. No new onchain configurations were deployed.

Browser verification: entered a temporary token identity; selected mNVDA; verified pair and reward text changed; selected holder rewards; verified Review exposed Export configuration rather than a launch transaction. No wallet signatures. TypeScript and production build checked.

This preserves the trader/creator audience while organizing DBC configuration as one workflow. Outstanding: onchain configuration creation/allowlist changes, migration execution and independently verified holder/liquidity policy integration for newly launched markets. Do not represent these previews as completed protocol functionality.
