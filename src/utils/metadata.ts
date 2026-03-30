const DEFAULT_IPFS_GATEWAY = 'https://gateway.pinata.cloud/ipfs/';

/**
 * Resolve an IPFS URI to an HTTP gateway URL.
 * If the URI is already an HTTP(S) URL, returns it as-is.
 * Returns empty string for empty/undefined input.
 */
export function resolveIPFSUri(
  uri: string | undefined | null,
  gateway?: string,
): string {
  if (!uri) return '';
  const gw = gateway || DEFAULT_IPFS_GATEWAY;
  if (uri.startsWith('ipfs://')) {
    const base = gw.endsWith('/') ? gw : `${gw}/`;
    const gateway = base.includes('/ipfs/') ? base : `${base}ipfs/`;
    return `${gateway}${uri.slice(7)}`;
  }
  return uri;
}

/** Venue metadata schema (v1) — all fields optional except version */
export interface VenueMetadata {
  version: number;
  venue_url?: string;
  image_url?: string;
  banner_url?: string;
  description?: string;
  social?: {
    twitter?: string;
    discord?: string;
    telegram?: string;
  };
}

/** Market metadata schema (v1) — all fields optional except version */
export interface MarketMetadata {
  version: number;
  image_url?: string;
  source_url?: string;
  category?: string;
}

/**
 * Safely parse a JSON string into a typed metadata object.
 * Returns null if the JSON is invalid or missing a version field.
 */
export function parseMetadata<T extends { version: number }>(
  json: string,
): T | null {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.version !== 'number') return null;
    return parsed as T;
  } catch {
    return null;
  }
}
