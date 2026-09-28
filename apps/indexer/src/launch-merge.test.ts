import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { chainEvents, creatorVaults, launchIntents, tokens } from '@stonkz/api/db/schema';
import type { Net } from '@stonkz/shared';
import {
  compareEvents,
  type ChainEvent,
  type TokenCreatedEvent,
  type TradeEvent,
} from './events.js';
import { safeImageUrl } from './ingest.js';
import { createIndexerRig, FROZEN_NOW, type IndexerTestRig } from './test/harness.js';

/**
 * How a chain-decoded launch meets the row `/launch/confirm` may already have
 * written, and the launch path's crash/ordering edges.
 */
let rig: IndexerTestRig | null = null;
afterEach(async () => {
  await rig?.close();
  rig = null;
});

const SOL_MINT = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const SOL_CREATOR = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
const EVM_TOKEN = '0x0000000000000000000000000000000000d0660A';
const EVM_CREATOR = '0x00000000000000000000000000000000000C4ea7';
const BLOCK_MS = FROZEN_NOW - 60_000;

function launch(net: Net, overrides: Partial<TokenCreatedEvent> = {}): TokenCreatedEvent {
  const sol = net === 'SOL';
  return {
    kind: 'TokenCreated',
    net,
    txSig: sol ? 'sigLaunch' : '0xab01',
    logIndex: 0,
    chainPosition: 1_100,
    blockTimeMs: BLOCK_MS,
    mint: sol ? SOL_MINT : EVM_TOKEN,
    sym: 'DOGGO',
    name: 'DOGGO',
    descr: '',
    creator: sol ? SOL_CREATOR : EVM_CREATOR,
    baseSymbol: sol ? 'SOL' : 'WETH',
    baseMint: sol
      ? 'So11111111111111111111111111111111111111112'
      : '0x7943e237c7F95DA44E0301572D358911207852Fa',
    supply: 1e9,
    feeBps: 250,
    cashback: true,
    seed: 7,
    mc: 4_312.5,
    curve: {
      tokenDecimals: sol ? 6 : 18,
      baseDecimals: sol ? 9 : 18,
      basePriceUsd1e6: '214080000',
      tokensForSale: '800000000000000',
      virtualBase0: '111',
      virtualToken0: '222',
      k: '24642',
      realBase: '0',
      realToken: '800000000000000',
      gradMcapBase: '333',
    },
    ...overrides,
  };
}

async function tokenRow(r: IndexerTestRig, net: Net, mint: string) {
  const [row] = await r.db.db
    .select()
    .from(tokens)
    .where(and(eq(tokens.net, net), eq(tokens.mint, mint)))
    .limit(1);
  return row;
}

async function intent(
  r: IndexerTestRig,
  values: Partial<typeof launchIntents.$inferInsert> & { net: Net; creator: string },
): Promise<void> {
  await r.db.db.insert(launchIntents).values({
    ticker: 'DOGGO',
    name: 'Doggo Coin',
    descr: 'much wow',
    uri: 'https://gateway.pinata.cloud/ipfs/QmDoggo',
    supply: 1e9,
    feeBps: 250,
    baseSymbol: 'SOL',
    baseMint: 'So11111111111111111111111111111111111111112',
    unsignedPayload: 'payload',
    issuedAt: new Date(BLOCK_MS - 30_000),
    expiresAt: new Date(BLOCK_MS + 300_000),
    ...values,
  });
}

describe('a chain launch meeting the /launch/confirm row', () => {
  it("keeps the creator's metadata but takes the chain's curve constants and cashback start", async () => {
    rig = await createIndexerRig();
    // What /launch/confirm writes on Solana: a curve re-derived from a
    // re-fetched oracle price, and its own wall clock as the cashback start.
    await rig.db.db.insert(tokens).values({
      net: 'SOL',
      sym: 'DOGGO',
      name: 'Doggo Coin',
      descr: 'much wow',
      creator: SOL_CREATOR,
      mint: SOL_MINT,
      baseSymbol: 'SOL',
      baseMint: 'So11111111111111111111111111111111111111112',
      supply: 1e9,
      feeBps: 250,
      cashback: true,
      cbStartMs: FROZEN_NOW,
      mc: 4_300,
      lastMc: 4_300,
      lane: 'new',
      seed: 1,
      imageUrl: 'https://gateway.pinata.cloud/ipfs/QmDoggo',
      tokenDecimals: 6,
      baseDecimals: 9,
      basePriceUsd1e6: '213000000',
      curveTokensForSale: '800000000000000',
      curveVirtualBase0: '1',
      curveVirtualToken0: '2',
      curveK: '2',
      curveRealBase: '5',
      curveRealToken: '6',
      curveGradMcapBase: '3',
    });

    const report = await rig.ingestor.apply([launch('SOL')]);
    expect(report.accepted).toBe(1);

    const row = await tokenRow(rig, 'SOL', SOL_MINT);
    expect(row?.name).toBe('Doggo Coin');
    expect(row?.descr).toBe('much wow');
    expect(row?.imageUrl).toBe('https://gateway.pinata.cloud/ipfs/QmDoggo');
    // Chain-authoritative, immutable launch constants.
    expect(row?.basePriceUsd1e6).toBe('214080000');
    expect(row?.curveVirtualBase0).toBe('111');
    expect(row?.curveK).toBe('24642');
    expect(row?.curveGradMcapBase).toBe('333');
    expect(row?.cbStartMs).toBe(BLOCK_MS);
    // Mutable reserves are left for the fills to keep current.
    expect(row?.curveRealBase).toBe('5');
    expect(row?.curveRealToken).toBe('6');
  });

  it("lists an indexer-first Solana launch with the creator's prepared name, description and image", async () => {
    rig = await createIndexerRig();
    await intent(rig, { net: 'SOL', creator: SOL_CREATOR, predictedMint: SOL_MINT });

    await rig.ingestor.apply([launch('SOL')]);
    const row = await tokenRow(rig, 'SOL', SOL_MINT);
    expect(row?.name).toBe('Doggo Coin');
    expect(row?.descr).toBe('much wow');
    expect(row?.imageUrl).toBe('https://gateway.pinata.cloud/ipfs/QmDoggo');

    const board = rig.published.find(
      (p) => p.channel === 'board' && (p.data as { type?: string }).type === 'token_created',
    );
    expect((board?.data as { payload?: { name?: string } }).payload?.name).toBe('Doggo Coin');
  });

  it('never takes metadata from an intent for a different mint or creator', async () => {
    rig = await createIndexerRig();
    await intent(rig, {
      net: 'SOL',
      creator: 'SomeoneElse1111111111111111111111111111111',
      predictedMint: SOL_MINT,
    });
    await intent(rig, {
      net: 'SOL',
      creator: SOL_CREATOR,
      predictedMint: 'OtherMint111111111111111111111111111111111',
    });

    await rig.ingestor.apply([launch('SOL')]);
    const row = await tokenRow(rig, 'SOL', SOL_MINT);
    expect(row?.name).toBe('DOGGO');
    expect(row?.imageUrl).toBeNull();
  });

  it('drops a prepared image URI that is not a plain http(s) URL', async () => {
    rig = await createIndexerRig();
    await intent(rig, {
      net: 'SOL',
      creator: SOL_CREATOR,
      predictedMint: SOL_MINT,
      uri: 'javascript:alert(document.cookie)',
    });
    await rig.ingestor.apply([launch('SOL')]);
    const row = await tokenRow(rig, 'SOL', SOL_MINT);
    expect(row?.name).toBe('Doggo Coin');
    expect(row?.imageUrl).toBeNull();
  });

  it("uses an EVM creator's intent only when it is unambiguous", async () => {
    rig = await createIndexerRig();
    await intent(rig, { net: 'RH', creator: EVM_CREATOR.toLowerCase() });
    await rig.ingestor.apply([launch('RH')]);
    expect((await tokenRow(rig, 'RH', EVM_TOKEN))?.name).toBe('Doggo Coin');

    await rig.close();
    rig = await createIndexerRig();
    await intent(rig, { net: 'RH', creator: EVM_CREATOR });
    await intent(rig, { net: 'RH', creator: EVM_CREATOR, name: 'Other Doggo' });
    await rig.ingestor.apply([launch('RH')]);
    // Two prepared launches for the same ticker disagree: keep the ticker.
    expect((await tokenRow(rig, 'RH', EVM_TOKEN))?.name).toBe('DOGGO');
  });
});

describe('launch durability and ordering', () => {
  it('recreates a launch whose chain_events row survived a crash but whose tokens row did not', async () => {
    rig = await createIndexerRig();
    const event = launch('SOL');
    await rig.ingestor.apply([event]);
    // The crash window: `record()` committed, `dispatch()` never ran.
    await rig.db.db.delete(tokens).where(eq(tokens.mint, SOL_MINT));
    await rig.db.db.delete(creatorVaults).where(eq(creatorVaults.mint, SOL_MINT));

    const replay = await rig.ingestor.apply([event]);
    expect(replay.duplicates).toBe(1);
    expect((await tokenRow(rig, 'SOL', SOL_MINT))?.sym).toBe('DOGGO');
    const vaults = await rig.db.db
      .select()
      .from(creatorVaults)
      .where(eq(creatorVaults.mint, SOL_MINT));
    expect(vaults).toHaveLength(1);
    const recorded = await rig.db.db
      .select()
      .from(chainEvents)
      .where(eq(chainEvents.txSig, 'sigLaunch'));
    expect(recorded).toHaveLength(1);
  });

  it('applies a same-position launch before a fill of it, whatever the tx signatures', async () => {
    const created = launch('SOL', { txSig: 'zzLaunch' });
    const fill: TradeEvent = {
      kind: 'Trade',
      net: 'SOL',
      txSig: 'aaSnipe',
      logIndex: 0,
      chainPosition: 1_100,
      blockTimeMs: BLOCK_MS,
      mint: SOL_MINT,
      sym: 'DOGGO',
      trader: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      side: 'buy',
      nativeAmount: 1.5,
      baseAmount: 1.5,
      tokenAmount: 1_000_000,
      usdValue: 321.12,
      mc: 5_000,
      cashback: false,
    };
    const sorted: ChainEvent[] = [fill, created].sort(compareEvents);
    expect(sorted.map((e) => e.kind)).toEqual(['TokenCreated', 'Trade']);

    rig = await createIndexerRig();
    await rig.ingestor.apply([fill, created]);
    // The snipe's cap stuck: the launch no longer lands after it and resets it.
    expect((await tokenRow(rig, 'SOL', SOL_MINT))?.mc).toBe(5_000);
  });
});

describe('safeImageUrl', () => {
  it('passes a plain https or http URL through unchanged', () => {
    expect(safeImageUrl('https://gateway.pinata.cloud/ipfs/Qm1')).toBe(
      'https://gateway.pinata.cloud/ipfs/Qm1',
    );
    expect(safeImageUrl('  http://example.com/a.png ')).toBe('http://example.com/a.png');
  });

  it('refuses other schemes, attribute breakouts, credentials and junk', () => {
    for (const bad of [
      '',
      'javascript:alert(1)',
      'data:image/svg+xml,<svg onload=alert(1)>',
      'ipfs://Qm1',
      'https://x.com/a.png" onerror="alert(1)',
      "https://x.com/a.png'",
      'https://x.com/<script>',
      'https://x.com/a b.png',
      'https://user:pass@x.com/a.png',
      'https://x.com/\u0000.png',
      '/relative.png',
      `https://x.com/${'a'.repeat(600)}`,
    ]) {
      expect(safeImageUrl(bad)).toBeNull();
    }
  });
});
