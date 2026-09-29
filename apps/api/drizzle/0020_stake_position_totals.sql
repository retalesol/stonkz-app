-- `Staked.amount` is the position's NEW TOTAL on both programs (EVM emits
-- `p.amount`, Solana `amount_after`), but the indexer used to ADD it to the
-- stored amount, so every top-up double-counted. Rebuild each position's
-- amount from the accepted events: the latest `Staked` total, less every
-- `Unstaked` after it. Idempotent; rows with nothing to change are untouched.
WITH ev AS (
  SELECT
    net,
    payload->>'mint' AS mint,
    wallet,
    kind,
    (payload->>'amount')::double precision AS amount,
    chain_position,
    log_index,
    id
  FROM chain_events
  WHERE kind IN ('Staked', 'Unstaked')
    AND wallet IS NOT NULL
    AND coalesce(payload->>'mint', '') <> ''
),
last_staked AS (
  SELECT DISTINCT ON (net, mint, wallet) net, mint, wallet, amount, chain_position, log_index, id
  FROM ev
  WHERE kind = 'Staked'
  ORDER BY net, mint, wallet, chain_position DESC, log_index DESC, id DESC
),
rebuilt AS (
  SELECT
    l.net,
    l.mint,
    l.wallet,
    greatest(
      0,
      l.amount - coalesce(
        (
          SELECT sum(u.amount)
          FROM ev u
          WHERE u.kind = 'Unstaked'
            AND u.net = l.net
            AND u.mint = l.mint
            AND u.wallet = l.wallet
            AND (u.chain_position, u.log_index, u.id) > (l.chain_position, l.log_index, l.id)
        ),
        0
      )
    ) AS amount
  FROM last_staked l
)
UPDATE stake_positions sp
SET amount = rebuilt.amount, updated_at = now()
FROM rebuilt
WHERE sp.net = rebuilt.net
  AND sp.mint = rebuilt.mint
  AND sp.wallet = rebuilt.wallet
  AND sp.amount IS DISTINCT FROM rebuilt.amount;
