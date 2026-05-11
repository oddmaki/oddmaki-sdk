import type { Address } from 'viem';
import { baseSepolia, base } from 'viem/chains';

export const CONTRACT_ADDRESSES = {
  [baseSepolia.id]: {
    diamond: '0x31a4126aec35b36d46dd371eb0f0d5b71e1c2292' as Address,
    conditionalTokens: '0x7364747372Ac4a175B5326f5B2C9CB1C271d32e8' as Address,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address,
    subgraph: 'https://api.studio.thegraph.com/query/1716020/oddmaki-base-sepolia/version/latest',
  },
  [base.id]: {
    diamond: '0x025d086a62d93e24f3cb3f161612ca8e9530127d' as Address,
    conditionalTokens: '0x3e2ae408ca03f27849edff32d107c7b8ea5c87b4' as Address,
    usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address,
    subgraph: 'https://api.studio.thegraph.com/query/1716020/oddmaki-base/version/latest',
  },
} as const;

export const SUBGRAPH_IDS = {
  [base.id]: 'CxoYVjELrNCMLopAmVshnfVAie7yH6QZyCSKD3r41XSQ',
  [baseSepolia.id]: 'DCnd3ozSyvYxRg7kmZYiDWGBiJCe6QHwu8M93jMN1Q3b',
} as const;

export function buildSubgraphGatewayUrl(
  chainId: number,
  apiKey: string,
): string | undefined {
  const id = SUBGRAPH_IDS[chainId as keyof typeof SUBGRAPH_IDS];
  return id
    ? `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${id}`
    : undefined;
}

export const DEFAULT_CHAIN = base;
