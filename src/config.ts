import type { Address } from 'viem';
import { baseSepolia } from 'viem/chains';

export const CONTRACT_ADDRESSES = {
  [baseSepolia.id]: {
    diamond: '0x5067a8175086e6b4863660fa165f8605302781e7' as Address,
    conditionalTokens: '0x7364747372Ac4a175B5326f5B2C9CB1C271d32e8' as Address,
    usdc: '0xd7a0a331f6fa862222049c97a3dded97bed2ef93' as Address,
    subgraph: 'https://api.studio.thegraph.com/query/1716020/octopus-protocol/version/latest',
  }
} as const;

export const DEFAULT_CHAIN = baseSepolia;
