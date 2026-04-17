import { readFileSync, writeFileSync } from 'fs';

const STATE_FILE = '/tmp/oddmaki-integration-state.json';

export interface SharedState {
  venueId: string; // serialized as string for JSON (BigInt not serializable)
  marketId: string;
}

export function writeSharedState(state: SharedState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function readSharedState(): SharedState {
  try {
    const raw = readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(raw) as SharedState;
  } catch {
    throw new Error(
      `Could not read shared test state from ${STATE_FILE}.\n` +
        'This usually means globalSetup did not run (ODDMAKI_TEST_PRIVATE_KEY not set).',
    );
  }
}
