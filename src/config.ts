import type { Address } from 'viem';
import { baseSepolia } from 'viem/chains';

export const CONTRACT_ADDRESSES = {
  [baseSepolia.id]: {
    diamond: '0xd6b87a68de56ddef64b270feb74fd3c684e91b20' as Address,
    conditionalTokens: '0x7364747372Ac4a175B5326f5B2C9CB1C271d32e8' as Address,
    usdc: '0x9a537902b0456ce532ee58859a0e9db47c647668' as Address,
    subgraph: 'https://api.studio.thegraph.com/query/1716020/oddmaki/version/latest',
  },
} as const;

export const DEFAULT_CHAIN = baseSepolia;
