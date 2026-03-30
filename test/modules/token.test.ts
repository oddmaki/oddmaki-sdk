import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenModule } from '../../src/modules/token';
import { OddMakiClientConfig } from '../../src/types';
import { ERC20ABI } from '../../src/contracts';
import { baseSepolia } from 'viem/chains';
import { createPublicClient, http } from 'viem';

// Mock viem
const mockReadContract = vi.fn();
const mockSimulateContract = vi.fn();

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    createPublicClient: vi.fn(() => ({
      readContract: mockReadContract,
      simulateContract: mockSimulateContract,
    })),
  };
});

describe('TokenModule', () => {
  let module: TokenModule;
  const config: OddMakiClientConfig = {
    chain: baseSepolia,
    transport: http(),
    diamondAddress: '0x0000000000000000000000000000000000000000',
    conditionalTokensAddress: '0x0000000000000000000000000000000000000000',
    subgraphEndpoint: 'https://example.com/subgraph',
    publicClient: createPublicClient({ chain: baseSepolia, transport: http() }) as any,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    module = new TokenModule(config);
  });

  it('should get allowance', async () => {
    mockReadContract.mockResolvedValue(1000n);
    const token = '0xToken';
    const owner = '0xOwner';
    const spender = '0xSpender';

    const result = await module.getAllowance(token, owner, spender);

    expect(mockReadContract).toHaveBeenCalledWith({
      address: token,
      abi: ERC20ABI,
      functionName: 'allowance',
      args: [owner, spender],
    });
    expect(result).toBe(1000n);
  });

  it('should get balance', async () => {
    mockReadContract.mockResolvedValue(500n);
    const token = '0xToken';
    const owner = '0xOwner';

    const result = await module.getBalance(token, owner);

    expect(mockReadContract).toHaveBeenCalledWith({
      address: token,
      abi: ERC20ABI,
      functionName: 'balanceOf',
      args: [owner],
    });
    expect(result).toBe(500n);
  });

  it('should get decimals', async () => {
    mockReadContract.mockResolvedValue(18);
    const token = '0xToken';

    const result = await module.getDecimals(token);

    expect(mockReadContract).toHaveBeenCalledWith({
      address: token,
      abi: ERC20ABI,
      functionName: 'decimals',
    });
    expect(result).toBe(18);
  });

  it('should get symbol', async () => {
    mockReadContract.mockResolvedValue('TEST');
    const token = '0xToken';

    const result = await module.getSymbol(token);

    expect(mockReadContract).toHaveBeenCalledWith({
      address: token,
      abi: ERC20ABI,
      functionName: 'symbol',
    });
    expect(result).toBe('TEST');
  });
});
