import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseTokenAmount,
  getCachedTokenDecimals,
  clearDecimalsCache,
} from '../../src/utils/decimals';

describe('parseTokenAmount', () => {
  it('parses USDC-style 6-decimal amounts', () => {
    expect(parseTokenAmount('10.5', 6)).toBe(10_500_000n);
    expect(parseTokenAmount('0', 6)).toBe(0n);
  });

  it('parses 18-decimal amounts via viem', () => {
    expect(parseTokenAmount('1', 18)).toBe(10n ** 18n);
  });

  it('rejects decimals outside [0, 18]', () => {
    expect(() => parseTokenAmount('1', -1)).toThrow(/Invalid decimals/);
    expect(() => parseTokenAmount('1', 19)).toThrow(/Invalid decimals/);
  });

  it('rejects empty or whitespace-only amounts', () => {
    expect(() => parseTokenAmount('', 6)).toThrow(/empty/i);
    expect(() => parseTokenAmount('   ', 6)).toThrow(/empty/i);
  });
});

describe('getCachedTokenDecimals', () => {
  beforeEach(() => {
    clearDecimalsCache();
  });

  // Minimal PublicClient stand-in — only the two methods the helper touches.
  function makeMockClient(chainId: number, decimals: number) {
    const readContract = vi.fn(async () => decimals);
    return {
      client: {
        getChainId: async () => chainId,
        readContract,
      } as any,
      readContract,
    };
  }

  const TOKEN = '0x9a537902b0456ce532ee58859a0e9db47c647668' as `0x${string}`;

  it('hits the chain on cache miss and returns the decimals', async () => {
    const { client, readContract } = makeMockClient(84532, 6);
    const d = await getCachedTokenDecimals(client, TOKEN);
    expect(d).toBe(6);
    expect(readContract).toHaveBeenCalledTimes(1);
  });

  it('reuses cached value on the second call with the same chain+token', async () => {
    const { client, readContract } = makeMockClient(84532, 6);
    await getCachedTokenDecimals(client, TOKEN);
    await getCachedTokenDecimals(client, TOKEN);
    expect(readContract).toHaveBeenCalledTimes(1);
  });

  it('keys the cache by chainId as well — same token on two chains reads twice', async () => {
    const base = makeMockClient(84532, 6);
    const mainnet = makeMockClient(8453, 6);
    await getCachedTokenDecimals(base.client, TOKEN);
    await getCachedTokenDecimals(mainnet.client, TOKEN);
    expect(base.readContract).toHaveBeenCalledTimes(1);
    expect(mainnet.readContract).toHaveBeenCalledTimes(1);
  });

  it('treats addresses case-insensitively via lowercase cache key', async () => {
    const { client, readContract } = makeMockClient(84532, 6);
    await getCachedTokenDecimals(client, TOKEN);
    await getCachedTokenDecimals(
      client,
      TOKEN.toUpperCase() as `0x${string}`,
    );
    expect(readContract).toHaveBeenCalledTimes(1);
  });

  it('clearDecimalsCache forces the next read back to the chain', async () => {
    const { client, readContract } = makeMockClient(84532, 6);
    await getCachedTokenDecimals(client, TOKEN);
    clearDecimalsCache();
    await getCachedTokenDecimals(client, TOKEN);
    expect(readContract).toHaveBeenCalledTimes(2);
  });
});
