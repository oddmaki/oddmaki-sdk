import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Abi } from 'viem';
import * as contracts from '../src/contracts';

// ---------------------------------------------------------------------------
// ABI drift catcher.
//
// Catches a specific failure mode: the SDK calls `functionName: 'foo'` against
// an ABI that no longer exports `foo` (renamed, removed, or never added). This
// would fail only at runtime against a live chain — usually with an opaque
// viem error. This suite turns those into unit-test failures.
//
// It scans every file under src/modules/ for two patterns:
//
//   1. `abi: SomeFacetABI,` paired with a nearby `functionName: 'doThing'`
//   2. `parseEventFromReceipt(..., SomeFacetABI as any, 'EventName')` (test code)
//
// then checks that `doThing` exists in SomeFacetABI (as a function) and
// `EventName` exists (as an event). An unknown ABI identifier is also fatal —
// we don't silently skip.
// ---------------------------------------------------------------------------

const ABI_REGISTRY = contracts as unknown as Record<string, Abi>;

type CallRef = {
  file: string;
  abiName: string;
  fnName: string;
  kind: 'function' | 'event';
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

// Extract identifiers imported from '../contracts' (or './contracts', etc).
// Only those are subject to the drift check — inline ABI fragments are
// self-contained and verified by their local `as const` + viem type-check.
function importedFromContracts(source: string): Set<string> {
  const imported = new Set<string>();
  const importRegex =
    /import\s*\{([^}]+)\}\s*from\s*['"][^'"]*contracts['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source)) !== null) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().replace(/\s+as\s+\w+$/, '');
      if (name) imported.add(name);
    }
  }
  return imported;
}

function scanFile(path: string): CallRef[] {
  const source = readFileSync(path, 'utf-8');
  const refs: CallRef[] = [];
  const imported = importedFromContracts(source);

  // Pattern 1: abi/functionName pairs in simulate/read/writeContract calls.
  // The SDK writes these consistently as sibling lines inside one object
  // literal; a 500-char proximity window is more than enough.
  const abiRegex = /abi:\s*(\w+ABI)\b/g;
  let match: RegExpExecArray | null;
  while ((match = abiRegex.exec(source)) !== null) {
    const abiName = match[1];
    // Skip ABI identifiers that aren't imported from contracts — they're
    // inline fragments declared locally in this file.
    if (!imported.has(abiName)) continue;

    const window = source.slice(match.index, match.index + 500);
    const fnMatch = window.match(/functionName:\s*['"]([^'"]+)['"]/);
    if (fnMatch) {
      refs.push({
        file: path,
        abiName,
        fnName: fnMatch[1],
        kind: 'function',
      });
    }
  }

  return refs;
}

function scanAllSourceCalls(): CallRef[] {
  const root = join(__dirname, '..', 'src');
  const files = listSourceFiles(root);
  return files.flatMap(scanFile);
}

function hasFunction(abi: Abi, fnName: string): boolean {
  return abi.some(
    (item) =>
      (item as { type?: string; name?: string }).type === 'function' &&
      (item as { name?: string }).name === fnName,
  );
}

function hasEvent(abi: Abi, eventName: string): boolean {
  return abi.some(
    (item) =>
      (item as { type?: string; name?: string }).type === 'event' &&
      (item as { name?: string }).name === eventName,
  );
}

describe('ABI drift', () => {
  const refs = scanAllSourceCalls();

  it('finds a meaningful number of ABI references across src/', () => {
    // If this drops below ~30, our scanner broke or the SDK was gutted.
    expect(refs.length).toBeGreaterThan(30);
  });

  it('every (ABI, functionName) pair resolves to a function in the bundled ABI', () => {
    const missing = refs
      .filter((r) => r.kind === 'function')
      .filter((r) => {
        const abi = ABI_REGISTRY[r.abiName];
        return !abi || !hasFunction(abi, r.fnName);
      });

    if (missing.length > 0) {
      throw new Error(
        `SDK references that don't resolve to a function in the bundled ABI — ` +
          `someone renamed / removed a function, or the ABI is stale:\n` +
          missing
            .map((m) => `  - ${m.abiName}.${m.fnName}  (${m.file})`)
            .join('\n'),
      );
    }
    expect(missing).toHaveLength(0);
  });
});

describe('event drift (SDK + test code)', () => {
  // Events decoded by the integration tests live in test/integration; the
  // decodeEventLog call there will silently skip mismatches and then throw
  // `Event "X" not found` against a receipt. Catch that up front by verifying
  // the (ABI, eventName) pairs are real.
  const testRoot = join(__dirname, 'integration');
  const files = statSync(testRoot).isDirectory() ? listSourceFiles(testRoot) : [];
  const eventRefs: CallRef[] = [];

  const eventRegex =
    /parseEventFromReceipt\s*\(\s*[^,]+,\s*(\w+ABI)\s+as\s+any\s*,\s*['"]([^'"]+)['"]/g;
  const eventAllRegex =
    /parseAllEventsFromReceipt\s*\(\s*[^,]+,\s*(\w+ABI)\s+as\s+any\s*,\s*['"]([^'"]+)['"]/g;

  for (const file of files) {
    const source = readFileSync(file, 'utf-8');
    for (const rx of [eventRegex, eventAllRegex]) {
      rx.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rx.exec(source)) !== null) {
        eventRefs.push({
          file,
          abiName: match[1],
          fnName: match[2],
          kind: 'event',
        });
      }
    }
  }

  it('finds event references in integration tests', () => {
    // Sanity — if this is 0 the scanner regexed nothing.
    expect(eventRefs.length).toBeGreaterThan(0);
  });

  it('every (ABI, eventName) decoded in tests exists in the bundled ABI', () => {
    const missing = eventRefs.filter((r) => {
      const abi = ABI_REGISTRY[r.abiName];
      return abi ? !hasEvent(abi, r.fnName) : true;
    });

    if (missing.length > 0) {
      throw new Error(
        `Tests decode events that don't exist in the bundled ABI:\n` +
          missing
            .map((m) => `  - ${m.abiName}.${m.fnName}  (${m.file})`)
            .join('\n'),
      );
    }
    expect(missing).toHaveLength(0);
  });
});
