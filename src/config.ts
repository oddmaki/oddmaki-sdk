import type { Address } from 'viem';
import { baseSepolia } from 'viem/chains';

export const CONTRACT_ADDRESSES = {
  [baseSepolia.id]: {
    diamond: '0x31a4126aec35b36d46dd371eb0f0d5b71e1c2292' as Address,
    conditionalTokens: '0x7364747372Ac4a175B5326f5B2C9CB1C271d32e8' as Address,
    usdc: '0x1d3caa0156e8e573814b78766ba7958d7e11488b' as Address,
    subgraph: 'https://api.studio.thegraph.com/query/1716020/oddmaki/version/latest',
  },
} as const;

export const DEFAULT_CHAIN = baseSepolia;
