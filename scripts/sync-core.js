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
 *
 * ABI sync targets are auto-discovered from deployment.contracts plus a fixed
 * list of per-venue contracts (PER_VENUE_ABIS). Diamond infrastructure facets
 * (Cut/Loupe/Ownership/ERC1155Receiver) and the OddMaki proxy itself are
 * skipped via SKIP_DEPLOYED. Names that don't match the deployment key are
 * mapped through DEPLOYED_NAME_TO_ABI; unusual artifact paths through ABI_OVERRIDES.
 *
 * New ABI files are written but NOT auto-imported in src/contracts/index.ts
 * — add imports/exports manually if you want to expose them. Orphan files
 * (existing on disk but not in the target set) are flagged with a warning,
 * never deleted.
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
  UmaOracle: 'OptimisticOracleV3Interface.sol/OptimisticOracleV3Interface.json',
};

// ---------------------------------------------------------------------------
// Deployment contract names the SDK does NOT need ABIs for.
// (Diamond infrastructure / hooks; not part of the public SDK surface.)
// ---------------------------------------------------------------------------
const SKIP_DEPLOYED = new Set([
  'OddMaki',              // Diamond proxy address; ABI is the union of facets
  'DiamondCutFacet',      // Diamond infra, deploy-time only
  'DiamondLoupeFacet',    // Diamond introspection, not exposed by SDK
  'OwnershipFacet',       // Diamond ownership, not exposed by SDK
  'ERC1155ReceiverFacet', // Hook only, no callable surface
]);

// ---------------------------------------------------------------------------
// Map deployment contract name → SDK ABI filename when they differ.
// ---------------------------------------------------------------------------
const DEPLOYED_NAME_TO_ABI = {
  USDC: 'ERC20',
};

// ---------------------------------------------------------------------------
// Per-venue contracts deployed by AccessControlFacet (not in protocol-level
// deployment JSON, but the SDK needs ABIs to interact with deployed instances).
// ---------------------------------------------------------------------------
const PER_VENUE_ABIS = [
  'WhitelistAccessControl',
  'NFTGatedAccessControl',
  'TokenGatedAccessControl',
];

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

/** Resolve a Forge artifact path for a given SDK ABI filename. */
function resolveArtifactPath(outDir, name) {
  const candidates = [];
  if (ABI_OVERRIDES[name]) {
    candidates.push(path.join(outDir, ABI_OVERRIDES[name]));
  }
  candidates.push(path.join(outDir, `${name}.sol`, `${name}.json`));
  candidates.push(path.join(outDir, `I${name}.sol`, `I${name}.json`));

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Build the set of ABI filenames the SDK should sync.
 *
 * Sources:
 *   1. deployment.contracts (auto-discovers everything deployed at protocol level)
 *   2. PER_VENUE_ABIS (contracts deployed per-venue, not in protocol deployment)
 *
 * Filtered by SKIP_DEPLOYED, then mapped via DEPLOYED_NAME_TO_ABI.
 */
function buildTargetSet(deployment) {
  const targets = new Set();

  for (const depName of Object.keys(deployment.contracts || {})) {
    if (SKIP_DEPLOYED.has(depName)) continue;
    const abiName = DEPLOYED_NAME_TO_ABI[depName] || depName;
    targets.add(abiName);
  }

  for (const name of PER_VENUE_ABIS) {
    targets.add(name);
  }

  return targets;
}

function syncAbis(sdkRoot, coreRoot, deployment) {
  const abisDir = path.join(sdkRoot, 'src', 'contracts', 'abis');
  const outDir = path.join(coreRoot, 'out');

  const targets = buildTargetSet(deployment);
  const sortedTargets = [...targets].sort();

  let synced = 0;
  let added = 0;
  const newFiles = [];
  const missing = [];

  for (const name of sortedTargets) {
    const abiPath = path.join(abisDir, `${name}.json`);
    const isNew = !fs.existsSync(abiPath);

    const artifactPath = resolveArtifactPath(outDir, name);
    if (!artifactPath) {
      missing.push(name);
      continue;
    }

    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    if (!Array.isArray(artifact.abi)) {
      missing.push(name);
      continue;
    }

    fs.writeFileSync(abiPath, JSON.stringify(artifact.abi, null, 2) + '\n');
    synced++;
    if (isNew) {
      added++;
      newFiles.push(name);
    }
  }

  // Detect orphan files: present on disk but not in target set.
  // Don't delete — just warn; an orphan may be a deprecated contract still
  // imported somewhere, so removal must be a manual decision.
  const existingNames = fs
    .readdirSync(abisDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.basename(f, '.json'));
  const orphans = existingNames.filter((n) => !targets.has(n));

  console.log(
    `  ✓ ${synced}/${sortedTargets.length} ABIs synced` +
      (added > 0 ? ` (${added} new: ${newFiles.join(', ')})` : '')
  );
  if (added > 0) {
    console.log(
      `  ℹ New ABIs were written to ${path.relative(sdkRoot, abisDir)}/ but are NOT auto-imported.`
    );
    console.log(
      `    Add imports/exports in src/contracts/index.ts if you want to expose them.`
    );
  }
  if (missing.length > 0) {
    console.warn(`  ⚠ No Forge artifact found for: ${missing.join(', ')}`);
  }
  if (orphans.length > 0) {
    console.warn(
      `  ⚠ Orphan ABI files (not in deployment + per-venue extras): ${orphans.join(', ')}`
    );
    console.warn(`    Review and remove if obsolete.`);
  }
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
  syncAbis(sdkRoot, coreRoot, deployment);

  console.log('Done.');
}

main();
