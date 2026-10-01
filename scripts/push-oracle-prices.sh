#!/usr/bin/env bash
# Refresh the launchpads' on-chain base prices (operator-run, one shot).
#
# createToken / create_token refuse a stale base price ("stale oracle"):
# EVM PushPriceSource tolerates 25h, Solana `global.max_oracle_staleness`
# (90s by default). Prices come from Coinbase spot, the same feed the API
# sizes curves with; stables are $1 and RH stock bases use the static table
# in apps/api/src/router/base-price.ts.
#
#   EVM_PK        oracle authority key for RH + Base (omit to skip EVM)
#   SOL_KEYPAIR   path to the Solana oracle authority keypair (omit to skip)
#   SOL_MAX_STALENESS  optional: also set global.max_oracle_staleness (admin)
#   NETS          which chains to push (default "RH BASE SOL")
#   RH_RPC_URL / BASE_RPC_URL / SOLANA_RPC_URL  override the RPCs; the defaults
#                 are the project's QuickNode testnet endpoints
#                 (docs/deployment.md "RPC endpoints")
set -euo pipefail
cd "$(dirname "$0")/.."

spot() { curl -fsS "https://api.coinbase.com/v2/prices/$1-USD/spot" | python3 -c 'import json,sys;print(int(round(float(json.load(sys.stdin)["data"]["amount"])*1e6)))'; }
ETH=$(spot ETH); SOL=$(spot SOL)
echo "ETH=$ETH SOL=$SOL (USD 1e6)"

push_evm() { # net rpc launchpad weth stable...
  local net=$1 rpc=$2 lp=$3; shift 3
  local src; src=$(cast call "$lp" 'priceSource()(address)' -r "$rpc")
  echo "== $net priceSource $src"
  local me; me=$(cast wallet address --private-key "$EVM_PK")
  while [ $# -gt 0 ]; do
    # Load-balanced RPCs: a node a block behind hands out a stale nonce
    # ("replacement transaction underpriced"). Use the pending nonce and
    # retry instead of aborting the whole run.
    local ok=0
    for attempt in 1 2 3 4; do
      local nonce out
      nonce=$(cast nonce "$me" --block pending -r "$rpc")
      if out=$(cast send "$src" 'pushPrice(address,uint256,uint256)' "$1" "$2" 0 \
        --nonce "$nonce" --private-key "$EVM_PK" -r "$rpc" --json 2>&1); then
        echo "$out" | python3 -c 'import json,sys;t=json.load(sys.stdin);print(" ",t["transactionHash"],"ok" if t["status"]=="0x1" else "REVERTED")'
        ok=1; break
      fi
      echo "  retry $attempt for $1: $(echo "$out" | tail -1 | cut -c1-100)"; sleep 4
    done
    [ "$ok" = 1 ] || { echo "  FAILED $1"; FAILED=1; }
    shift 2
  done
}
FAILED=0
NETS=${NETS:-RH BASE SOL}
RH_RPC_URL=${RH_RPC_URL:-https://icy-cosmopolitan-brook.robinhood-testnet.quiknode.pro/9c53e25ca5bbcb46f445fb61fa7049408ee9fcfb/}
BASE_RPC_URL=${BASE_RPC_URL:-https://bold-morning-cherry.base-sepolia.quiknode.pro/e3b199333fe5835cdfe212994bd562e853860ffb/}
export SOLANA_RPC_URL=${SOLANA_RPC_URL:-https://practical-quaint-meme.solana-devnet.quiknode.pro/c8aa47382db29af890d18e52774284dabdb6845a/}
want() { case " $NETS " in *" $1 "*) return 0;; *) return 1;; esac; }

if [ -n "${EVM_PK:-}" ] && want RH; then
  push_evm RH "$RH_RPC_URL" 0xe308287C9A85E2B53F1027a1c589B5e3969928e8 \
    0x7943e237c7F95DA44E0301572D358911207852Fa "$ETH" \
    0x7E955252E15c84f5768B83c41a71F9eba181802F 1000000 \
    0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E 250000000 \
    0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02 200000000 \
    0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0 40000000 \
    0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93 700000000 \
    0x71178BAc73cBeb415514eB542a8995b82669778d 160000000
fi
if [ -n "${EVM_PK:-}" ] && want BASE; then
  push_evm BASE "$BASE_RPC_URL" 0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35 \
    0x4200000000000000000000000000000000000006 "$ETH" \
    0x036CbD53842c5426634e7929541eC2318f3dCF7e 1000000
fi

if [ -n "${SOL_KEYPAIR:-}" ] && want SOL; then
  echo "== SOL"
  (cd apps/api && SOL_PRICE="$SOL" node --input-type=module -e '
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
const disc = (n) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const program = new PublicKey("FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg");
const wsol = new PublicKey("So11111111111111111111111111111111111111112");
const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.SOL_KEYPAIR, "utf8"))));
const conn = new Connection(process.env.SOLANA_RPC_URL, "confirmed");
const [global] = PublicKey.findProgramAddressSync([Buffer.from("global")], program);
const [oracle] = PublicKey.findProgramAddressSync([Buffer.from("oracle"), wsol.toBuffer()], program);
const tx = new Transaction();
if (process.env.SOL_MAX_STALENESS) {
  const d = Buffer.alloc(16); disc("set_max_oracle_staleness").copy(d); d.writeBigInt64LE(BigInt(process.env.SOL_MAX_STALENESS), 8);
  tx.add(new TransactionInstruction({ programId: program, data: d, keys: [
    { pubkey: global, isSigner: false, isWritable: true },
    { pubkey: signer.publicKey, isSigner: true, isWritable: false } ] }));
}
const price = BigInt(process.env.SOL_PRICE);
const d = Buffer.alloc(24); disc("push_price").copy(d); d.writeBigUInt64LE(price, 8); d.writeBigUInt64LE(price / 1000n, 16);
tx.add(new TransactionInstruction({ programId: program, data: d, keys: [
  { pubkey: global, isSigner: false, isWritable: false },
  { pubkey: oracle, isSigner: false, isWritable: true },
  { pubkey: wsol, isSigner: false, isWritable: false },
  { pubkey: signer.publicKey, isSigner: true, isWritable: true },
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false } ] }));
console.log("  ", await sendAndConfirmTransaction(conn, tx, [signer]), "ok");
')
fi
exit "$FAILED"
