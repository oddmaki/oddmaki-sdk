import { BaseModule } from './base';
import {
  ResolutionFacetABI,
  MarketsFacetABI,
  ProtocolFacetABI,
  ConditionalTokensABI,
} from '../contracts';
import { erc20Abi } from 'viem';
import type { Address } from 'viem';

/** Minimal ABI for UMA Optimistic Oracle V3 getMinimumBond */
const optimisticOracleV3Abi = [
  {
    inputs: [{ name: 'currency', type: 'address' }],
    name: 'getMinimumBond',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * UMA Module - Handles oracle assertion and resolution operations
 *
 * Workflow:
 * 1. Market is created → gets a questionId
 * 2. After resolutionTime, anyone can assert an outcome → gets assertionId
 * 3. After liveness period, anyone can settle the assertion
 * 4. After settlement (if truthful), anyone can report resolution to CTF
 */
export class UmaModule extends BaseModule {
  /**
   * Assert an outcome for a market question
   *
   * @param params.marketId - The market ID to assert on
   * @param params.outcome - The outcome string (e.g., "YES", "NO")
   * @param params.autoApprove - Automatically approve bond token if needed (default: true)
   *
   * @returns Transaction hash
   */
  async assertMarketOutcome(params: {
    marketId: bigint;
    outcome: string;
    autoApprove?: boolean;
  }) {
    const wallet = this.walletClient;
    const [account] = await wallet.getAddresses();
    const autoApprove = params.autoApprove ?? true;

    // Step 1: Get market registry data to find questionId
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registryData: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'getMarketRegistryData',
      args: [params.marketId],
    });

    const questionId = registryData.questionId as `0x${string}`;

    // Step 2: Get effective bond (max of requiredBond and UMA's minimumBond)
    const { effectiveBond, currency } = await this.getEffectiveBond(params.marketId);
    const bondAmount = effectiveBond;

    // Step 3: Check current allowance (approve Diamond, which delegates to ResolutionFacet)
    const currentAllowance = (await this.publicClient.readContract({
      address: currency,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account, this.config.diamondAddress],
    })) as bigint;

    // Step 4: Approve if needed
    if (currentAllowance < bondAmount && autoApprove) {
      const approveHash = await wallet.writeContract({
        address: currency,
        abi: erc20Abi,
        functionName: 'approve',
        args: [this.config.diamondAddress, bondAmount],
        account,
        chain: this.config.chain,
      });

      await this.publicClient.waitForTransactionReceipt({
        hash: approveHash,
        confirmations: 2,
      });

      await new Promise((resolve) => setTimeout(resolve, 2000));

      const newAllowance = (await this.publicClient.readContract({
        address: currency,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account, this.config.diamondAddress],
      })) as bigint;

      if (newAllowance < bondAmount) {
        throw new Error(
          `Approval failed to update. New allowance: ${newAllowance.toString()}, Required: ${bondAmount.toString()}`
        );
      }
    } else if (currentAllowance < bondAmount) {
      throw new Error(
        `Insufficient bond token allowance. Required: ${bondAmount.toString()}, Current: ${currentAllowance.toString()}. Please approve the Diamond (${
          this.config.diamondAddress
        }) to spend bond tokens.`
      );
    }

    // Step 5: Check balance
    const balance = (await this.publicClient.readContract({
      address: currency,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    })) as bigint;

    if (balance < bondAmount) {
      throw new Error(
        `Insufficient bond token balance. Required: ${bondAmount.toString()}, Have: ${balance.toString()}`
      );
    }

    // Step 6: Assert the outcome via Diamond
    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: ResolutionFacetABI,
      functionName: 'assertMarketOutcome',
      args: [questionId, params.outcome],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Get the effective bond for a market, accounting for UMA's minimum bond.
   * The contract uses max(requiredBond, oo.getMinimumBond(currency)).
   */
  async getEffectiveBond(marketId: bigint): Promise<{
    requiredBond: bigint;
    minimumBond: bigint;
    effectiveBond: bigint;
    currency: Address;
  }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oracleData: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'getMarketOracleData',
      args: [marketId],
    });

    const requiredBond = BigInt(oracleData.requiredBond);
    const currency = oracleData.currency as Address;

    const umaOracle = (await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: ProtocolFacetABI,
      functionName: 'getUmaOracle',
    })) as Address;

    const minimumBond = (await this.publicClient.readContract({
      address: umaOracle,
      abi: optimisticOracleV3Abi,
      functionName: 'getMinimumBond',
      args: [currency],
    })) as bigint;

    const effectiveBond = requiredBond > minimumBond ? requiredBond : minimumBond;

    return { requiredBond, minimumBond, effectiveBond, currency };
  }

  /**
   * Settle an assertion after the liveness period
   */
  async settleAssertion(assertionId: `0x${string}`) {
    const wallet = this.walletClient;
    const [account] = await wallet.getAddresses();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: ResolutionFacetABI,
      functionName: 'settleAssertion',
      args: [assertionId],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Report resolution after UMA settlement
   */
  async reportResolution(params: { marketId: bigint; outcome: string }) {
    const wallet = this.walletClient;
    const [account] = await wallet.getAddresses();

    const { request } = await this.publicClient.simulateContract({
      address: this.config.diamondAddress,
      abi: ResolutionFacetABI,
      functionName: 'reportResolution',
      args: [params.marketId, params.outcome],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Check if a market has been resolved in CTF
   */
  async getResolutionStatus(marketId: bigint) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oracleData: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'getMarketOracleData',
      args: [marketId],
    });

    const conditionId = oracleData.conditionId as `0x${string}`;

    const payoutDenominator = (await this.publicClient.readContract({
      address: this.config.conditionalTokensAddress,
      abi: ConditionalTokensABI,
      functionName: 'payoutDenominator',
      args: [conditionId],
    })) as bigint;

    if (payoutDenominator === 0n) {
      return {
        resolved: false,
        winningOutcome: null,
        payouts: [],
      };
    }

    const outcomeSlotCount = Number(oracleData.outcomeSlotCount || 2);
    const payouts: bigint[] = [];

    for (let i = 0; i < outcomeSlotCount; i++) {
      const payout = (await this.publicClient.readContract({
        address: this.config.conditionalTokensAddress,
        abi: ConditionalTokensABI,
        functionName: 'payoutNumerators',
        args: [conditionId, BigInt(i)],
      })) as bigint;
      payouts.push(payout);
    }

    let winningOutcome: string | null = null;
    if (outcomeSlotCount === 2) {
      if (payouts[0] > 0n && payouts[1] === 0n) {
        winningOutcome = 'YES';
      } else if (payouts[1] > 0n && payouts[0] === 0n) {
        winningOutcome = 'NO';
      } else if (payouts[0] === payouts[1]) {
        winningOutcome = 'INVALID';
      }
    }

    return {
      resolved: true,
      winningOutcome,
      payouts,
      payoutDenominator,
    };
  }

  /**
   * Redeem winning outcome tokens for collateral
   */
  async redeemWinnings(marketId: bigint) {
    const wallet = this.walletClient;
    const [account] = await wallet.getAddresses();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oracleData: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'getMarketOracleData',
      args: [marketId],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tradingData: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'getMarketTradingData',
      args: [marketId],
    });

    const conditionId = oracleData.conditionId as `0x${string}`;
    const collateralToken = tradingData.collateralToken as Address;

    const indexSets = [1, 2];

    const { request } = await this.publicClient.simulateContract({
      address: this.config.conditionalTokensAddress,
      abi: ConditionalTokensABI,
      functionName: 'redeemPositions',
      args: [
        collateralToken,
        '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
        conditionId,
        indexSets,
      ],
      account,
    });

    return wallet.writeContract(request);
  }

  /**
   * Get the collateral token address for a market
   */
  async getCollateralToken(marketId: bigint): Promise<Address> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tradingData: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'getMarketTradingData',
      args: [marketId],
    });

    return tradingData.collateralToken as Address;
  }

  /**
   * Get question/oracle data for a market
   */
  async getQuestionData(marketId: bigint) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oracleData: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'getMarketOracleData',
      args: [marketId],
    });

    return {
      questionId: oracleData.questionId as `0x${string}`,
      conditionId: oracleData.conditionId as `0x${string}`,
      outcomeSlotCount: BigInt(oracleData.outcomeSlotCount),
      currency: oracleData.currency as Address,
      reward: BigInt(oracleData.reward),
      requiredBond: BigInt(oracleData.requiredBond),
      liveness: BigInt(oracleData.liveness),
      initialized: oracleData.initialized as boolean,
      activeAssertionId: oracleData.activeAssertionId as `0x${string}`,
      ancillaryData: oracleData.ancillaryData as `0x${string}`,
    };
  }

  /**
   * Get assertion data
   */
  async getAssertionData(assertionId: `0x${string}`) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: ResolutionFacetABI,
      functionName: 'getAssertionData',
      args: [assertionId],
    });

    return {
      assertionId: data.assertionId as `0x${string}`,
      questionId: data.questionId as `0x${string}`,
      outcome: data.outcome as string,
      settled: data.settled as boolean,
    };
  }

  /**
   * Get assertion details from UMA Oracle including expiration time
   */
  async getAssertionDetails(assertionId: `0x${string}`) {
    // Get the UMA Oracle address from Diamond
    const oracleAddress = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: ProtocolFacetABI,
      functionName: 'getUmaOracle',
    });

    // Query the oracle directly for assertion details
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const assertion: any = await this.publicClient.readContract({
      address: oracleAddress as `0x${string}`,
      abi: [
        {
          name: 'getAssertion',
          type: 'function',
          stateMutability: 'view',
          inputs: [{ name: 'assertionId', type: 'bytes32' }],
          outputs: [
            {
              name: 'assertion',
              type: 'tuple',
              components: [
                {
                  name: 'escalationManagerSettings',
                  type: 'tuple',
                  components: [
                    { name: 'arbitrateViaEscalationManager', type: 'bool' },
                    { name: 'discardOracle', type: 'bool' },
                    { name: 'validateDisputers', type: 'bool' },
                    { name: 'assertingCaller', type: 'address' },
                    { name: 'escalationManager', type: 'address' },
                  ],
                },
                { name: 'asserter', type: 'address' },
                { name: 'assertionTime', type: 'uint64' },
                { name: 'settled', type: 'bool' },
                { name: 'currency', type: 'address' },
                { name: 'expirationTime', type: 'uint64' },
                { name: 'settlementResolution', type: 'bool' },
                { name: 'domainId', type: 'bytes32' },
                { name: 'identifier', type: 'bytes32' },
                { name: 'bond', type: 'uint256' },
                { name: 'callbackRecipient', type: 'address' },
                { name: 'disputer', type: 'address' },
              ],
            },
          ],
        },
      ],
      functionName: 'getAssertion',
      args: [assertionId],
    });

    const expirationTime = Number(assertion.expirationTime);
    const currentTime = Math.floor(Date.now() / 1000);

    return {
      asserter: assertion.asserter as `0x${string}`,
      assertionTime: Number(assertion.assertionTime),
      settled: assertion.settled as boolean,
      expirationTime,
      canSettle: currentTime >= expirationTime,
      disputer: assertion.disputer as `0x${string}`,
      isDisputed: assertion.disputer !== '0x0000000000000000000000000000000000000000',
    };
  }

  /**
   * Get comprehensive market status for UMA resolution
   */
  async getMarketStatus(marketId: bigint) {
    // Get market registry data
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registryData: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'getMarketRegistryData',
      args: [marketId],
    });

    const questionId = registryData.questionId as `0x${string}`;
    const marketStatus = Number(registryData.status); // 0=Draft, 1=Active, 2=Resolved

    // Get question/oracle data
    const questionData = await this.getQuestionData(marketId);
    const conditionId = questionData.conditionId;

    // Check if there's an active assertion
    const hasAssertion =
      questionData.activeAssertionId !==
      '0x0000000000000000000000000000000000000000000000000000000000000000';

    let assertionData = null;
    let isSettled = false;

    if (hasAssertion) {
      assertionData = await this.getAssertionData(
        questionData.activeAssertionId
      );
      isSettled = assertionData.settled;
    }

    // Check if resolution has been reported to CTF
    const payoutDenominator = (await this.publicClient.readContract({
      address: this.config.conditionalTokensAddress,
      abi: ConditionalTokensABI,
      functionName: 'payoutDenominator',
      args: [conditionId],
    })) as bigint;

    const isReportedToCTF = payoutDenominator > 0n;

    let winningOutcome: string | null = null;
    if (isReportedToCTF) {
      const payout0 = (await this.publicClient.readContract({
        address: this.config.conditionalTokensAddress,
        abi: ConditionalTokensABI,
        functionName: 'payoutNumerators',
        args: [conditionId, 0n],
      })) as bigint;

      const payout1 = (await this.publicClient.readContract({
        address: this.config.conditionalTokensAddress,
        abi: ConditionalTokensABI,
        functionName: 'payoutNumerators',
        args: [conditionId, 1n],
      })) as bigint;

      if (payout0 > 0n && payout1 === 0n) {
        winningOutcome = 'YES';
      } else if (payout1 > 0n && payout0 === 0n) {
        winningOutcome = 'NO';
      } else if (payout0 === payout1) {
        winningOutcome = 'INVALID';
      }
    }

    return {
      marketId,
      questionId,
      marketStatus:
        marketStatus === 0
          ? 'Draft'
          : marketStatus === 1
          ? 'Active'
          : 'Resolved',
      assertion: {
        hasAssertion,
        assertionId: hasAssertion ? questionData.activeAssertionId : null,
        outcome: assertionData?.outcome || null,
        settled: isSettled,
      },
      question: {
        requiredBond: questionData.requiredBond,
        currency: questionData.currency,
        reward: questionData.reward,
        liveness: questionData.liveness,
      },
      resolution: {
        reportedToCTF: isReportedToCTF,
        winningOutcome,
      },
      canAssert: !hasAssertion && marketStatus === 1,
      canSettle: hasAssertion && !isSettled,
      canReportResolution: hasAssertion && isSettled && !isReportedToCTF,
      isResolved: isReportedToCTF,
    };
  }

  /**
   * Get the questionId for a market
   */
  async getQuestionId(marketId: bigint): Promise<`0x${string}`> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registryData: any = await this.publicClient.readContract({
      address: this.config.diamondAddress,
      abi: MarketsFacetABI,
      functionName: 'getMarketRegistryData',
      args: [marketId],
    });

    return registryData.questionId as `0x${string}`;
  }
}
