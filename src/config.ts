import type { Address } from 'viem';
import { baseSepolia } from 'viem/chains';

export const CONTRACT_ADDRESSES = {
  [baseSepolia.id]: {
    diamond: '0x188563069e0ae7247f0e2f0fce0382f0ed28d31a' as Address,
    conditionalTokens: '0x7364747372Ac4a175B5326f5B2C9CB1C271d32e8' as Address,
    usdc: '0xb7e73d2848dd908a90a50ba679719eb9375c3fdf' as Address,
    subgraph: 'https://api.studio.thegraph.com/query/1716020/oddmaki/version/latest',
  },
} as const;

export const DEFAULT_CHAIN = baseSepolia;
