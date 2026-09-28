/**
 * The off-chain half of a Solana token's Metaplex metadata.
 *
 * `create_token` writes an immutable Metaplex metadata account whose `uri`
 * is the launch `uri`, and wallets / explorers resolve that `uri` as the
 * Token Metadata Standard JSON (`name`, `symbol`, `description`, `image`, …)
 * — not as an image. So `/launch/prepare` pins this document and puts *its*
 * URL on-chain; the image URL stays on the intent / `tokens` row for the
 * app's own board.
 */

export interface SolanaTokenMetadataInput {
  name: string;
  ticker: string;
  descr: string;
  /** Display image (https), or null when the launch has none. */
  image: string | null;
  website: string | null;
  /** Bare X handle, no `@`. */
  xHandle: string | null;
  /** Canonical `https://t.me/…` link. */
  telegram: string | null;
}

const EXT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Image MIME type from a URL's extension, when it has one we allow. */
function imageTypeOf(url: string): string | null {
  try {
    const ext = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
    return ext ? (EXT_TYPES[ext] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Metaplex Token Metadata Standard (fungible) JSON. Key order is fixed and
 * nothing time-dependent is included, so identical launches serialise — and
 * pin — identically.
 */
export function buildSolanaTokenMetadata(m: SolanaTokenMetadataInput): Record<string, unknown> {
  const extensions: Record<string, string> = {};
  if (m.website) extensions['website'] = m.website;
  if (m.xHandle) extensions['twitter'] = `https://x.com/${m.xHandle}`;
  if (m.telegram) extensions['telegram'] = m.telegram;

  const type = m.image ? imageTypeOf(m.image) : null;
  return {
    name: m.name,
    symbol: m.ticker,
    description: m.descr,
    ...(m.image ? { image: m.image } : {}),
    ...(m.website ? { external_url: m.website } : {}),
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
    ...(m.image
      ? {
          properties: {
            category: 'image',
            files: [{ uri: m.image, ...(type ? { type } : {}) }],
          },
        }
      : {}),
  };
}
