#!/usr/bin/env node
/**
 * sync-core — Syncs contract addresses and ABIs from the oddmaki-core repo into the SDK.
 *
 * Expects oddmaki-core to be a sibling directory (../oddmaki-core relative to this repo).
 *
 * Usage:
 *   node scripts/sync-core.js --chain <chain-name> [--version <version>]
 *
 * Options:
 *   --chain     Chain directory name under oddmaki-core/deployments/ (e.g. base-sepolia, base)
 *   --version   Deployment version (e.g. v0.12.0). Omit to use latest.json
 *
 * Examples:
 *   node scripts/sync-core.js --chain base-sepolia
 *   node scripts/sync-core.js --chain base-sepolia --version v0.12.0
 *
 * Steps performed:
 *   1. Reads deployment JSON from oddmaki-core/deployments/<chain>/<version>.json
 *   2. Updates src/config.ts with new contract addresses (preserves subgraph URLs)
 *   3. Extracts ABIs from oddmaki-core Forge artifacts (out/) into src/contracts/abis/
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Chain name → viem import mapping
// ---------------------------------------------------------------------------
const CHAIN_MAP = {
  'base-sepolia': 'baseSepolia',
  'base': 'base',
};

// ---------------------------------------------------------------------------
// Forge artifact overrides for ABI filenames that don't match 1-to-1
// Key = SDK ABI filename (without .json), Value = path under out/
// ---------------------------------------------------------------------------
const ABI_OVERRIDES = {
  ConditionalTokens: 'IConditionalTokens.sol/IConditionalTokens.json',
  ERC20: 'MockERC20.sol/MockERC20.json',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { chain: null, version: 'latest' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--chain' && args[i + 1]) opts.chain = args[++i];
    else if (args[i] === '--version' && args[i + 1]) opts.version = args[++i];
  }
  if (!opts.chain) {
    console.error('Usage: node scripts/sync-core.js --chain <chain-name> [--version <version>]');
    process.exit(1);
  }
  if (!CHAIN_MAP[opts.chain]) {
    console.error(`Unknown chain "${opts.chain}". Known chains: ${Object.keys(CHAIN_MAP).join(', ')}`);
    process.exit(1);
  }
  return opts;
}

/** Parse existing config.ts to extract chain entries (addresses + subgraph URLs). */
function parseExistingConfig(configPath) {
  if (!fs.existsSync(configPath)) return {};

  const src = fs.readFileSync(configPath, 'utf8');
  const entries = {};

  // Match each chain block: [viemName.id]: { ... }
  const blockRe = /\[(\w+)\.id\]:\s*\{([^}]+)\}/gs;
  let m;
  while ((m = blockRe.exec(src)) !== null) {
    const viemName = m[1];
    const body = m[2];
    const entry = {};

    // Extract address fields
    const addrRe = /(\w+):\s*'(0x[a-fA-F0-9]+)'\s*as\s*Address/g;
    let am;
    while ((am = addrRe.exec(body)) !== null) {
      entry[am[1]] = am[2];
    }

    // Extract subgraph URL
    const sgm = body.match(/subgraph:\s*'([^']+)'/);
    if (sgm) entry.subgraph = sgm[1];

    entries[viemName] = entry;
  }

  // Extract DEFAULT_CHAIN
  const dcm = src.match(/export const DEFAULT_CHAIN\s*=\s*(\w+)/);
  entries._defaultChain = dcm ? dcm[1] : null;

  return entries;
}

/** Generate config.ts content from entries map. */
function generateConfig(entries) {
  const defaultChain = entries._defaultChain;
  const chainNames = Object.keys(entries).filter((k) => k !== '_defaultChain');

  const imports = chainNames.join(', ');

  let out = '';
  out += `import type { Address } from 'viem';\n`;
  out += `import { ${imports} } from 'viem/chains';\n`;
  out += `\n`;
  out += `export const CONTRACT_ADDRESSES = {\n`;

  for (const name of chainNames) {
    const e = entries[name];
    out += `  [${name}.id]: {\n`;
    out += `    diamond: '${e.diamond}' as Address,\n`;
    out += `    conditionalTokens: '${e.conditionalTokens}' as Address,\n`;
    out += `    usdc: '${e.usdc}' as Address,\n`;
    out += `    subgraph: '${e.subgraph}',\n`;
    out += `  },\n`;
  }

  out += `} as const;\n`;
  out += `\n`;
  out += `export const DEFAULT_CHAIN = ${defaultChain || chainNames[0]};\n`;

  return out;
}

// ---------------------------------------------------------------------------
// Main tasks
// ---------------------------------------------------------------------------

function updateConfig(sdkRoot, chainName, deployment) {
  const configPath = path.join(sdkRoot, 'src', 'config.ts');
  const viemName = CHAIN_MAP[chainName];

  const entries = parseExistingConfig(configPath);
  const existingSubgraph = entries[viemName]?.subgraph;

  // Build/update the entry for this chain
  const contracts = deployment.contracts;
  if (!contracts.OddMaki || !contracts.ConditionalTokens || !contracts.USDC) {
    console.error('Deployment missing required contracts: OddMaki, ConditionalTokens, or USDC');
    process.exit(1);
  }

  entries[viemName] = {
    diamond: contracts.OddMaki.toLowerCase(),
    conditionalTokens: contracts.ConditionalTokens,
    usdc: contracts.USDC.toLowerCase(),
    subgraph: existingSubgraph || 'TODO: set subgraph URL',
  };

  // Preserve DEFAULT_CHAIN; default to current chain if unset
  if (!entries._defaultChain) entries._defaultChain = viemName;

  fs.writeFileSync(configPath, generateConfig(entries));
  console.log(`  ✓ config.ts updated (${viemName}, diamond=${contracts.OddMaki})`);
}

function syncAbis(sdkRoot, coreRoot) {
  const abisDir = path.join(sdkRoot, 'src', 'contracts', 'abis');
  const outDir = path.join(coreRoot, 'out');

  const files = fs.readdirSync(abisDir).filter((f) => f.endsWith('.json'));
  let synced = 0;

  for (const file of files) {
    const name = path.basename(file, '.json');

    // Resolve Forge artifact path
    let artifactPath;
    if (ABI_OVERRIDES[name]) {
      artifactPath = path.join(outDir, ABI_OVERRIDES[name]);
    } else {
      artifactPath = path.join(outDir, `${name}.sol`, `${name}.json`);
    }

    // Fallback: interface variant (I-prefix)
    if (!fs.existsSync(artifactPath)) {
      artifactPath = path.join(outDir, `I${name}.sol`, `I${name}.json`);
    }

    if (!fs.existsSync(artifactPath)) {
      console.warn(`  ⚠ No Forge artifact for ${name}, skipping`);
      continue;
    }

    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    if (!Array.isArray(artifact.abi)) {
      console.warn(`  ⚠ No ABI array in artifact for ${name}, skipping`);
      continue;
    }

    fs.writeFileSync(path.join(abisDir, file), JSON.stringify(artifact.abi, null, 2) + '\n');
    synced++;
  }

  console.log(`  ✓ ${synced}/${files.length} ABIs synced`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs();
  const sdkRoot = path.resolve(__dirname, '..');
  const coreRoot = path.resolve(sdkRoot, '..', 'oddmaki-core');

  if (!fs.existsSync(coreRoot)) {
    console.error(`oddmaki-core not found at ${coreRoot}`);
    process.exit(1);
  }

  // Resolve deployment file
  const versionFile =
    opts.version === 'latest'
      ? 'latest.json'
      : `${opts.version.startsWith('v') ? opts.version : 'v' + opts.version}.json`;

  const deployPath = path.join(coreRoot, 'deployments', opts.chain, versionFile);

  if (!fs.existsSync(deployPath)) {
    console.error(`Deployment not found: ${deployPath}`);
    const available = fs.readdirSync(path.join(coreRoot, 'deployments', opts.chain)).filter((f) => f.endsWith('.json'));
    console.error(`Available: ${available.join(', ')}`);
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(deployPath, 'utf8'));
  console.log(`Syncing ${opts.chain} v${deployment.version || opts.version} → SDK`);

  updateConfig(sdkRoot, opts.chain, deployment);
  syncAbis(sdkRoot, coreRoot);

  console.log('Done.');
}

main();
