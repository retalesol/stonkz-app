/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/launchpad.json`.
 */
export type Launchpad = {
  "address": "FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg",
  "metadata": {
    "name": "launchpad",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Stonkz bonding-curve launchpad: 20/70/10 on-chain fee split, $69K graduation"
  },
  "instructions": [
    {
      "name": "acceptAdmin",
      "discriminator": [
        112,
        42,
        45,
        90,
        116,
        181,
        13,
        170
      ],
      "accounts": [
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "pendingAdmin",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "buy",
      "docs": [
        "`amount_base` in, at least `min_out` tokens back. Slippage is enforced",
        "on this hop alone; the aggregator hop carries its own bound."
      ],
      "discriminator": [
        102,
        6,
        61,
        18,
        1,
        218,
        235,
        234
      ],
      "accounts": [
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "curve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "curve"
          ]
        },
        {
          "name": "baseMint",
          "relations": [
            "curve"
          ]
        },
        {
          "name": "curveBaseVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101,
                  95,
                  98,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "curveTokenVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "bucketBaseVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  99,
                  107,
                  101,
                  116,
                  95,
                  98,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "bucketTokenVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  99,
                  107,
                  101,
                  116,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "protocolVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "opsVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  112,
                  115,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "burnVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  114,
                  110,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "trader",
          "writable": true,
          "signer": true
        },
        {
          "name": "traderBaseAccount",
          "writable": true
        },
        {
          "name": "traderTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "baseTokenProgram"
        },
        {
          "name": "params"
        }
      ],
      "args": [
        {
          "name": "amountBase",
          "type": "u64"
        },
        {
          "name": "minOut",
          "type": "u64"
        }
      ]
    },
    {
      "name": "claimCreatorFees",
      "docs": [
        "Creator bucket only. Cannot reach the protocol or ops vaults."
      ],
      "discriminator": [
        0,
        23,
        125,
        234,
        156,
        118,
        134,
        89
      ],
      "accounts": [
        {
          "name": "curve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "curve"
          ]
        },
        {
          "name": "baseMint",
          "relations": [
            "curve"
          ]
        },
        {
          "name": "bucketBaseVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  99,
                  107,
                  101,
                  116,
                  95,
                  98,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "bucketTokenVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  99,
                  107,
                  101,
                  116,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "creator",
          "signer": true,
          "relations": [
            "curve"
          ]
        },
        {
          "name": "creatorBaseAccount",
          "writable": true
        },
        {
          "name": "creatorTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "baseTokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "claimDexFees",
      "docs": [
        "Permissionless crank: claim the locked DLMM position's swap fees into",
        "the curve's own 15 / 10 / 6 / 69 split, so post-bond fees keep flowing",
        "to the protocol, the buyback, the crate fund, the creator and stakers."
      ],
      "discriminator": [
        120,
        38,
        212,
        94,
        120,
        50,
        231,
        186
      ],
      "accounts": [
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "curve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "docs": [
            "Mutable: the token side's non-bucket legs are burned."
          ],
          "writable": true,
          "relations": [
            "curve"
          ]
        },
        {
          "name": "baseMint",
          "relations": [
            "curve"
          ]
        },
        {
          "name": "bucketBaseVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  99,
                  107,
                  101,
                  116,
                  95,
                  98,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "bucketTokenVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  99,
                  107,
                  101,
                  116,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "protocolVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "opsVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  112,
                  115,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "burnVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  114,
                  110,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  116,
                  101,
                  111,
                  114,
                  97,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "escrowBase",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "escrow"
              },
              {
                "kind": "account",
                "path": "baseTokenProgram"
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "escrowToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "escrow"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "lbPair",
          "writable": true
        },
        {
          "name": "position",
          "docs": [
            "(program-owned, this pool, escrow as owner and fee owner)."
          ],
          "writable": true
        },
        {
          "name": "binArrayLower",
          "writable": true
        },
        {
          "name": "binArrayUpper",
          "writable": true
        },
        {
          "name": "reserveX",
          "writable": true
        },
        {
          "name": "reserveY",
          "writable": true
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "dexProgram"
        },
        {
          "name": "memoProgram",
          "address": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
        },
        {
          "name": "caller",
          "docs": [
            "Anyone. Pays the transaction fee and receives nothing."
          ],
          "signer": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "baseTokenProgram"
        },
        {
          "name": "params"
        }
      ],
      "args": []
    },
    {
      "name": "claimReferral",
      "docs": [
        "Redeem an API-signed voucher for `cumulative_amount` (lifetime) base",
        "atoms: pays the difference over what this recipient already claimed.",
        "The transaction must carry an `Ed25519Program` verification of the",
        "voucher message by the configured signer before this instruction."
      ],
      "discriminator": [
        219,
        247,
        18,
        148,
        63,
        247,
        112,
        198
      ],
      "accounts": [
        {
          "name": "referralConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  102,
                  101,
                  114,
                  114,
                  97,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "baseMint"
        },
        {
          "name": "referralVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  102,
                  101,
                  114,
                  114,
                  97,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "referralAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  102,
                  101,
                  114,
                  114,
                  97,
                  108,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "claimState",
          "docs": [
            "The recipient's lifetime-claimed counter for this base mint. Rent is",
            "the recipient's: they are the one being paid."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  102,
                  101,
                  114,
                  114,
                  97,
                  108,
                  95,
                  99,
                  108,
                  97,
                  105,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              },
              {
                "kind": "account",
                "path": "recipient"
              }
            ]
          }
        },
        {
          "name": "recipient",
          "writable": true,
          "signer": true
        },
        {
          "name": "recipientTokenAccount",
          "docs": [
            "The recipient's ATA for the base mint, created here if missing with",
            "the recipient's lamports (they are the one being paid). Measured",
            "smaller than requiring a client-side create (830,136 vs 903,816 B)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "recipient"
              },
              {
                "kind": "account",
                "path": "baseTokenProgram"
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "instructionsSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "baseTokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "cumulativeAmount",
          "type": "u64"
        },
        {
          "name": "deadline",
          "type": "i64"
        }
      ]
    },
    {
      "name": "claimStake",
      "discriminator": [
        62,
        145,
        133,
        242,
        244,
        59,
        53,
        139
      ],
      "accounts": [
        {
          "name": "curve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "curve"
          ]
        },
        {
          "name": "baseMint",
          "relations": [
            "curve"
          ]
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  107,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "bucketBaseVault",
          "docs": [
            "The pool's money and the creator's money live in the same vault, told",
            "apart by the `Curve` ledger. Neither can overdraw the other."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  99,
                  107,
                  101,
                  116,
                  95,
                  98,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "bucketTokenVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  99,
                  107,
                  101,
                  116,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "position"
          ]
        },
        {
          "name": "ownerBaseAccount",
          "writable": true
        },
        {
          "name": "ownerTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "baseTokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "createToken",
      "discriminator": [
        84,
        52,
        204,
        228,
        24,
        140,
        234,
        75
      ],
      "accounts": [
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "mint",
          "docs": [
            "Mint PDA is seeded on creator + salt so the same ticker can launch",
            "more than once. Uniqueness of display name/ticker is an app-layer",
            "cooldown, not an on-chain permanent bind."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "creator"
              },
              {
                "kind": "arg",
                "path": "salt"
              }
            ]
          }
        },
        {
          "name": "curve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "baseMint"
        },
        {
          "name": "oracle",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "curveTokenVault",
          "docs": [
            "Holds the 80% sellable allocation."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "lpVault",
          "docs": [
            "Holds the 20% escrowed for the graduation pool."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "curveBaseVault",
          "docs": [
            "Holds base paid into the curve."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101,
                  95,
                  98,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "bucketBaseVault",
          "docs": [
            "The 69% bucket, in base. Creator claim and staker pool share it; the",
            "ledger on `Curve` says how much of the balance belongs to which."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  99,
                  107,
                  101,
                  116,
                  95,
                  98,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "bucketTokenVault",
          "docs": [
            "The 69% bucket after a cashback swap, in the launched token."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  99,
                  107,
                  101,
                  116,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "stakeEscrow",
          "docs": [
            "Escrow for staked tokens, including zero-weight FLEX positions."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  107,
                  101,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "docs": [
            "The launched mint's program. Classic SPL Token only: the Metaplex",
            "metadata below is the classic-mint path. The base mint is unaffected",
            "and may still be Token-2022 via `base_token_program`."
          ]
        },
        {
          "name": "baseTokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "metadata",
          "docs": [
            "The seeds pin it to `[\"metadata\", metaplex, mint]` under Metaplex."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "const",
                "value": [
                  11,
                  112,
                  101,
                  177,
                  227,
                  209,
                  124,
                  69,
                  56,
                  157,
                  82,
                  127,
                  107,
                  4,
                  195,
                  205,
                  88,
                  184,
                  108,
                  115,
                  26,
                  160,
                  253,
                  181,
                  73,
                  182,
                  209,
                  188,
                  3,
                  248,
                  41,
                  70
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                11,
                112,
                101,
                177,
                227,
                209,
                124,
                69,
                56,
                157,
                82,
                127,
                107,
                4,
                195,
                205,
                88,
                184,
                108,
                115,
                26,
                160,
                253,
                181,
                73,
                182,
                209,
                188,
                3,
                248,
                41,
                70
              ]
            }
          }
        },
        {
          "name": "tokenMetadataProgram",
          "address": "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
        },
        {
          "name": "params"
        }
      ],
      "args": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "ticker",
          "type": "string"
        },
        {
          "name": "uri",
          "type": "string"
        },
        {
          "name": "supply",
          "type": "u64"
        },
        {
          "name": "feeBps",
          "type": "u16"
        },
        {
          "name": "cashback",
          "type": "bool"
        },
        {
          "name": "salt",
          "type": "u64"
        }
      ]
    },
    {
      "name": "fundReferralVault",
      "docs": [
        "Anyone may top a referral vault up. The protocol withdraw authority",
        "normally uses `withdraw_treasury(Protocol, amount)` with the referral",
        "vault as `destination` instead."
      ],
      "discriminator": [
        42,
        156,
        53,
        170,
        210,
        212,
        200,
        86
      ],
      "accounts": [
        {
          "name": "baseMint"
        },
        {
          "name": "referralVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  102,
                  101,
                  114,
                  114,
                  97,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "source",
          "writable": true
        },
        {
          "name": "funder",
          "signer": true
        },
        {
          "name": "baseTokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "graduate",
      "discriminator": [
        45,
        235,
        225,
        181,
        17,
        218,
        64,
        130
      ],
      "accounts": [
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "curve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "writable": true,
          "relations": [
            "curve"
          ]
        },
        {
          "name": "baseMint",
          "relations": [
            "curve"
          ]
        },
        {
          "name": "oracle",
          "docs": [
            "Optional. Without it only the curve-exhaustion trigger is available,",
            "which is exactly the intended behaviour when the oracle is down."
          ],
          "optional": true
        },
        {
          "name": "curveTokenVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "params"
        }
      ],
      "args": []
    },
    {
      "name": "initReferralVault",
      "docs": [
        "Permissionless: open the referral payout vault for a base mint. Anyone",
        "may pay its rent; opening it grants nothing."
      ],
      "discriminator": [
        237,
        152,
        34,
        95,
        191,
        106,
        151,
        10
      ],
      "accounts": [
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "baseMint"
        },
        {
          "name": "referralVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  102,
                  101,
                  114,
                  114,
                  97,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "referralAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  102,
                  101,
                  114,
                  114,
                  97,
                  108,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "baseTokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initTreasury",
      "discriminator": [
        105,
        152,
        173,
        51,
        158,
        151,
        49,
        14
      ],
      "accounts": [
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "baseMint"
        },
        {
          "name": "protocolVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "opsVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  112,
                  115,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "burnVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  114,
                  110,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "baseTokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "admin",
          "type": "pubkey"
        },
        {
          "name": "protocolWithdrawAuthority",
          "type": "pubkey"
        },
        {
          "name": "opsWithdrawAuthority",
          "type": "pubkey"
        },
        {
          "name": "oracleAuthority",
          "type": "pubkey"
        },
        {
          "name": "migrationAuthority",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "migrateCreatePool",
      "docs": [
        "Step 1 of migration: create the Meteora DLMM LB pair at curve close price."
      ],
      "discriminator": [
        171,
        175,
        108,
        85,
        211,
        230,
        24,
        249
      ],
      "accounts": [
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "curve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "curve"
          ]
        },
        {
          "name": "baseMint",
          "relations": [
            "curve"
          ]
        },
        {
          "name": "dexProgram"
        },
        {
          "name": "presetParameter"
        },
        {
          "name": "lbPair",
          "writable": true
        },
        {
          "name": "binArrayBitmapExtension",
          "writable": true
        },
        {
          "name": "reserveX",
          "writable": true
        },
        {
          "name": "reserveY",
          "writable": true
        },
        {
          "name": "oracle",
          "writable": true
        },
        {
          "name": "tokenBadgeX"
        },
        {
          "name": "tokenBadgeY"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "migrationAuthority",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "baseTokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "migrateSeedLiquidity",
      "docs": [
        "Step 2 of migration: seed liquidity, lock the position permanently."
      ],
      "discriminator": [
        158,
        192,
        249,
        26,
        198,
        81,
        37,
        114
      ],
      "accounts": [
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "curve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "curve"
          ]
        },
        {
          "name": "baseMint",
          "relations": [
            "curve"
          ]
        },
        {
          "name": "curveBaseVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101,
                  95,
                  98,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "lpVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  116,
                  101,
                  111,
                  114,
                  97,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "escrowBase",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "escrow"
              },
              {
                "kind": "account",
                "path": "baseTokenProgram"
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "escrowToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "escrow"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "lbPair",
          "writable": true
        },
        {
          "name": "binArrayBitmapExtension",
          "writable": true
        },
        {
          "name": "reserveX",
          "writable": true
        },
        {
          "name": "reserveY",
          "writable": true
        },
        {
          "name": "binArray",
          "writable": true
        },
        {
          "name": "position",
          "writable": true
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "dexProgram"
        },
        {
          "name": "userTokenX",
          "docs": [
            "Escrow ATA for token X (sorted mint order). Client must pass the matching escrow ATA."
          ],
          "writable": true
        },
        {
          "name": "userTokenY",
          "docs": [
            "Escrow ATA for token Y (sorted mint order)."
          ],
          "writable": true
        },
        {
          "name": "migrationAuthority",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "baseTokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "docs": [
            "`initialize_position_pda` takes the rent sysvar."
          ],
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "pause",
      "docs": [
        "The pauser can set pause flags and nothing else; unpausing is admin's",
        "`set_pause`."
      ],
      "discriminator": [
        211,
        22,
        221,
        251,
        74,
        121,
        193,
        47
      ],
      "accounts": [
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "pauserConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  117,
                  115,
                  101,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "pauser",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "trading",
          "type": "bool"
        },
        {
          "name": "launch",
          "type": "bool"
        },
        {
          "name": "protocolWithdrawals",
          "type": "bool"
        },
        {
          "name": "opsWithdrawals",
          "type": "bool"
        }
      ]
    },
    {
      "name": "proposeAdmin",
      "discriminator": [
        121,
        214,
        199,
        212,
        87,
        39,
        117,
        234
      ],
      "accounts": [
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "global"
          ]
        }
      ],
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "pushPrice",
      "discriminator": [
        113,
        238,
        232,
        235,
        60,
        71,
        127,
        203
      ],
      "accounts": [
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "oracle",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "baseMint"
        },
        {
          "name": "oracleAuthority",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "price1e6",
          "type": "u64"
        },
        {
          "name": "conf1e6",
          "type": "u64"
        }
      ]
    },
    {
      "name": "sell",
      "docs": [
        "`amount_token` in, at least `min_out` base back **after** the curve fee."
      ],
      "discriminator": [
        51,
        230,
        133,
        164,
        1,
        127,
        131,
        173
      ],
      "accounts": [
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "curve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "curve"
          ]
        },
        {
          "name": "baseMint",
          "relations": [
            "curve"
          ]
        },
        {
          "name": "curveBaseVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101,
                  95,
                  98,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "curveTokenVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "bucketBaseVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  99,
                  107,
                  101,
                  116,
                  95,
                  98,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "bucketTokenVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  99,
                  107,
                  101,
                  116,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "protocolVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "opsVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  112,
                  115,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "burnVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  114,
                  110,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "trader",
          "writable": true,
          "signer": true
        },
        {
          "name": "traderBaseAccount",
          "writable": true
        },
        {
          "name": "traderTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "baseTokenProgram"
        },
        {
          "name": "params"
        }
      ],
      "args": [
        {
          "name": "amountToken",
          "type": "u64"
        },
        {
          "name": "minOut",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setMaxOracleStaleness",
      "discriminator": [
        147,
        95,
        20,
        164,
        151,
        239,
        132,
        172
      ],
      "accounts": [
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "global"
          ]
        }
      ],
      "args": [
        {
          "name": "secs",
          "type": "i64"
        }
      ]
    },
    {
      "name": "setMeteoraConfig",
      "docs": [
        "Which Meteora DLMM program and `PresetParameter2` migration CPIs into."
      ],
      "discriminator": [
        19,
        28,
        223,
        231,
        209,
        41,
        249,
        0
      ],
      "accounts": [
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "global"
          ]
        }
      ],
      "args": [
        {
          "name": "program",
          "type": "pubkey"
        },
        {
          "name": "preset",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setOracleAuthority",
      "discriminator": [
        39,
        155,
        66,
        106,
        213,
        226,
        114,
        174
      ],
      "accounts": [
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "global"
          ]
        }
      ],
      "args": [
        {
          "name": "authority",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setParams",
      "docs": [
        "Admin: the fee split, creator fee bounds, cashback window and",
        "graduation cap, in the `[\"params\"]` PDA (created on first call). Until",
        "it exists every instruction runs on the `constants.rs` defaults, so the",
        "program upgrade that introduced this needs no migration step."
      ],
      "discriminator": [
        27,
        234,
        178,
        52,
        147,
        2,
        187,
        141
      ],
      "accounts": [
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "params",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  114,
                  97,
                  109,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "global"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "paramsArgs"
            }
          }
        }
      ]
    },
    {
      "name": "setPause",
      "discriminator": [
        63,
        32,
        154,
        2,
        56,
        103,
        79,
        45
      ],
      "accounts": [
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "global"
          ]
        }
      ],
      "args": [
        {
          "name": "trading",
          "type": {
            "option": "bool"
          }
        },
        {
          "name": "launch",
          "type": {
            "option": "bool"
          }
        },
        {
          "name": "protocolWithdrawals",
          "type": {
            "option": "bool"
          }
        },
        {
          "name": "opsWithdrawals",
          "type": {
            "option": "bool"
          }
        }
      ]
    },
    {
      "name": "setPauser",
      "docs": [
        "Admin appoints the emergency pauser (default pubkey removes it)."
      ],
      "discriminator": [
        22,
        198,
        152,
        61,
        2,
        13,
        145,
        238
      ],
      "accounts": [
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "pauserConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  117,
                  115,
                  101,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "global"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "pauser",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setRaydiumConfig",
      "docs": [
        "Deprecated alias — same Global slots as `set_meteora_config`."
      ],
      "discriminator": [
        148,
        102,
        59,
        165,
        37,
        205,
        4,
        134
      ],
      "accounts": [
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "global"
          ]
        }
      ],
      "args": [
        {
          "name": "program",
          "type": "pubkey"
        },
        {
          "name": "ammConfig",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setReferralPaused",
      "docs": [
        "Admin or the emergency pauser may pause referral claims; only admin",
        "may unpause."
      ],
      "discriminator": [
        3,
        18,
        200,
        192,
        106,
        149,
        100,
        46
      ],
      "accounts": [
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "referralConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  102,
                  101,
                  114,
                  114,
                  97,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "pauserConfig",
          "docs": [
            "Absent when no pauser was ever appointed; then only admin may call."
          ],
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  117,
                  115,
                  101,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setReferralSigner",
      "docs": [
        "Admin: the API's Ed25519 voucher signer, the daily cap (base atoms;",
        "`0` refuses all, `u64::MAX` uncapped) and the 8-byte cluster tag."
      ],
      "discriminator": [
        94,
        195,
        146,
        192,
        95,
        19,
        207,
        255
      ],
      "accounts": [
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "referralConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  102,
                  101,
                  114,
                  114,
                  97,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "global"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "signer",
          "type": "pubkey"
        },
        {
          "name": "maxPerDay",
          "type": "u64"
        },
        {
          "name": "clusterTag",
          "type": {
            "array": [
              "u8",
              8
            ]
          }
        }
      ]
    },
    {
      "name": "setWithdrawAuthorities",
      "discriminator": [
        212,
        58,
        19,
        177,
        58,
        173,
        52,
        183
      ],
      "accounts": [
        {
          "name": "global",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "global"
          ]
        }
      ],
      "args": [
        {
          "name": "protocol",
          "type": {
            "option": "pubkey"
          }
        },
        {
          "name": "ops",
          "type": {
            "option": "pubkey"
          }
        }
      ]
    },
    {
      "name": "stake",
      "discriminator": [
        206,
        176,
        202,
        18,
        200,
        209,
        179,
        108
      ],
      "accounts": [
        {
          "name": "curve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "curve"
          ]
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  107,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "stakeEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  107,
                  101,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "ownerTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "lockDays",
          "type": "u16"
        }
      ]
    },
    {
      "name": "syncPriceFromPyth",
      "docs": [
        "Permissionless: copy the base mint's pinned Pyth feed (a verified",
        "`PriceUpdateV2`) into its `BaseOracle`. A not-newer update is a no-op.",
        "Appended last so every existing instruction keeps its position."
      ],
      "discriminator": [
        246,
        192,
        23,
        109,
        3,
        214,
        88,
        150
      ],
      "accounts": [
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "oracle",
          "docs": [
            "Same PDA and layout `push_price` writes; created on the first sync."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "baseMint"
        },
        {
          "name": "priceUpdate",
          "docs": [
            "the Pyth receiver program, Anchor discriminator, `Full` verification,",
            "and the feed id pinned for `base_mint` in `pyth::PYTH_FEEDS`. Any such",
            "account is genuine Wormhole-verified Pyth data, so its address is not",
            "pinned (sponsored push feed or a caller-posted update both work)."
          ]
        },
        {
          "name": "payer",
          "docs": [
            "Pays rent only when the `BaseOracle` does not exist yet."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "unstake",
      "discriminator": [
        90,
        95,
        107,
        42,
        205,
        124,
        50,
        225
      ],
      "accounts": [
        {
          "name": "curve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "curve"
          ]
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  107,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "stakeEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  107,
                  101,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "ownerTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "withdrawTreasury",
      "discriminator": [
        40,
        63,
        122,
        158,
        144,
        216,
        83,
        96
      ],
      "accounts": [
        {
          "name": "global",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "baseMint"
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "authority",
          "docs": [
            "Must equal `global.protocol_withdraw_authority` or",
            "`global.ops_withdraw_authority` depending on `which`. Documented to be a",
            "multisig or cold key; the API process holds neither."
          ],
          "signer": true
        },
        {
          "name": "baseTokenProgram"
        }
      ],
      "args": [
        {
          "name": "which",
          "type": {
            "defined": {
              "name": "treasury"
            }
          }
        },
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "baseOracle",
      "discriminator": [
        33,
        4,
        85,
        161,
        215,
        233,
        67,
        211
      ]
    },
    {
      "name": "curve",
      "discriminator": [
        191,
        180,
        249,
        66,
        180,
        71,
        51,
        182
      ]
    },
    {
      "name": "global",
      "discriminator": [
        167,
        232,
        232,
        177,
        200,
        108,
        114,
        127
      ]
    },
    {
      "name": "params",
      "discriminator": [
        129,
        232,
        120,
        183,
        156,
        198,
        9,
        242
      ]
    },
    {
      "name": "pauserConfig",
      "discriminator": [
        154,
        50,
        223,
        181,
        104,
        38,
        221,
        16
      ]
    },
    {
      "name": "referralClaimState",
      "discriminator": [
        222,
        207,
        78,
        72,
        5,
        246,
        121,
        59
      ]
    },
    {
      "name": "referralConfig",
      "discriminator": [
        102,
        148,
        171,
        235,
        148,
        83,
        250,
        140
      ]
    },
    {
      "name": "stakePosition",
      "discriminator": [
        78,
        165,
        30,
        111,
        171,
        125,
        11,
        220
      ]
    }
  ],
  "events": [
    {
      "name": "creatorFeesClaimed",
      "discriminator": [
        189,
        178,
        21,
        181,
        171,
        179,
        131,
        1
      ]
    },
    {
      "name": "dexFeesClaimed",
      "discriminator": [
        219,
        128,
        91,
        199,
        140,
        250,
        40,
        237
      ]
    },
    {
      "name": "feeAccrued",
      "discriminator": [
        61,
        83,
        48,
        144,
        144,
        50,
        153,
        45
      ]
    },
    {
      "name": "graduated",
      "discriminator": [
        51,
        241,
        66,
        50,
        140,
        245,
        156,
        192
      ]
    },
    {
      "name": "liquidityMigrated",
      "discriminator": [
        27,
        161,
        105,
        19,
        236,
        128,
        146,
        13
      ]
    },
    {
      "name": "paramsSet",
      "discriminator": [
        57,
        111,
        33,
        252,
        120,
        76,
        98,
        245
      ]
    },
    {
      "name": "referralClaimed",
      "discriminator": [
        195,
        109,
        77,
        196,
        134,
        226,
        78,
        108
      ]
    },
    {
      "name": "referralConfigSet",
      "discriminator": [
        174,
        66,
        125,
        58,
        20,
        47,
        0,
        34
      ]
    },
    {
      "name": "referralVaultFunded",
      "discriminator": [
        89,
        212,
        177,
        29,
        180,
        24,
        165,
        100
      ]
    },
    {
      "name": "stakeClaimed",
      "discriminator": [
        231,
        124,
        83,
        169,
        100,
        57,
        96,
        131
      ]
    },
    {
      "name": "staked",
      "discriminator": [
        11,
        146,
        45,
        205,
        230,
        58,
        213,
        240
      ]
    },
    {
      "name": "tokenCreated",
      "discriminator": [
        236,
        19,
        41,
        255,
        130,
        78,
        147,
        172
      ]
    },
    {
      "name": "trade",
      "discriminator": [
        24,
        254,
        218,
        152,
        253,
        43,
        18,
        81
      ]
    },
    {
      "name": "treasuryCredit",
      "discriminator": [
        162,
        91,
        194,
        155,
        235,
        4,
        184,
        132
      ]
    },
    {
      "name": "treasuryWithdrawn",
      "discriminator": [
        143,
        181,
        157,
        169,
        87,
        155,
        170,
        46
      ]
    },
    {
      "name": "unstaked",
      "discriminator": [
        27,
        179,
        156,
        215,
        47,
        71,
        195,
        7
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "mathOverflow",
      "msg": "Arithmetic overflowed or a quote could not be produced"
    },
    {
      "code": 6001,
      "name": "tradingPaused",
      "msg": "Trading is paused"
    },
    {
      "code": 6002,
      "name": "launchPaused",
      "msg": "Launching is paused"
    },
    {
      "code": 6003,
      "name": "withdrawalsPaused",
      "msg": "Withdrawals from this treasury are paused"
    },
    {
      "code": 6004,
      "name": "feeOutOfRange",
      "msg": "Curve fee is outside the configured min/max bounds (default 100-500 bps)"
    },
    {
      "code": 6005,
      "name": "unsupportedSupply",
      "msg": "Supply must be one of 1M, 500M, 1B, 1T"
    },
    {
      "code": 6006,
      "name": "invalidTicker",
      "msg": "Ticker must be 1-10 chars of A-Z or 0-9"
    },
    {
      "code": 6007,
      "name": "metadataTooLong",
      "msg": "Name or URI is too long"
    },
    {
      "code": 6008,
      "name": "oracleStale",
      "msg": "Oracle price is stale"
    },
    {
      "code": 6009,
      "name": "oracleUnreliable",
      "msg": "Oracle confidence band is too wide to price a graduation"
    },
    {
      "code": 6010,
      "name": "oracleInvalid",
      "msg": "Oracle price must be positive"
    },
    {
      "code": 6011,
      "name": "curveComplete",
      "msg": "The curve allocation is exhausted; this token is awaiting graduation"
    },
    {
      "code": 6012,
      "name": "alreadyGraduated",
      "msg": "Token has already graduated; trade it on the DEX pool"
    },
    {
      "code": 6013,
      "name": "notGraduable",
      "msg": "Token has not met a graduation trigger"
    },
    {
      "code": 6014,
      "name": "slippageExceeded",
      "msg": "Output below the caller's minimum"
    },
    {
      "code": 6015,
      "name": "zeroAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6016,
      "name": "invalidLockTerm",
      "msg": "Lock term must be one of 0, 1, 7, 30, 90, 180 or 365 days"
    },
    {
      "code": 6017,
      "name": "stillLocked",
      "msg": "Stake is still locked"
    },
    {
      "code": 6018,
      "name": "lockTermMismatch",
      "msg": "A position with a different lock term is already open; unstake first"
    },
    {
      "code": 6019,
      "name": "insufficientStake",
      "msg": "Insufficient staked balance"
    },
    {
      "code": 6020,
      "name": "nothingToClaim",
      "msg": "Nothing to claim"
    },
    {
      "code": 6021,
      "name": "notCreator",
      "msg": "Only the token creator may do this"
    },
    {
      "code": 6022,
      "name": "unauthorized",
      "msg": "Signer is not the configured authority"
    },
    {
      "code": 6023,
      "name": "baseMintMismatch",
      "msg": "Treasury vault does not match the curve's base mint"
    },
    {
      "code": 6024,
      "name": "cashbackRequiresNoDevBuy",
      "msg": "Cashback requires a zero dev buy at launch"
    },
    {
      "code": 6025,
      "name": "alreadyMigrated",
      "msg": "This coin's liquidity has already been migrated and locked"
    },
    {
      "code": 6026,
      "name": "poolAlreadyExists",
      "msg": "The DEX pool address for this migration is already in use"
    },
    {
      "code": 6027,
      "name": "poolNotCreated",
      "msg": "Meteora DLMM pool has not been created yet; call migrate_create_pool first"
    },
    {
      "code": 6028,
      "name": "noLiquidityMinted",
      "msg": "Meteora DLMM minted / locked no position liquidity for this deposit"
    },
    {
      "code": 6029,
      "name": "unsupportedTokenProgram",
      "msg": "Launched mints must use the classic SPL Token program"
    },
    {
      "code": 6030,
      "name": "pythAccountInvalid",
      "msg": "Price update is not a Pyth PriceUpdateV2 account"
    },
    {
      "code": 6031,
      "name": "pythNotFullyVerified",
      "msg": "Pyth price update is only partially verified"
    },
    {
      "code": 6032,
      "name": "pythFeedMismatch",
      "msg": "Pyth price update is for a different feed than the one pinned for this base mint"
    },
    {
      "code": 6033,
      "name": "pythFeedNotPinned",
      "msg": "No Pyth feed is pinned for this base mint"
    },
    {
      "code": 6034,
      "name": "positionMismatch",
      "msg": "Position is not this coin's locked Meteora DLMM position (wrong pool, owner or fee owner)"
    },
    {
      "code": 6035,
      "name": "notMigrated",
      "msg": "This coin's liquidity has not been migrated yet"
    },
    {
      "code": 6036,
      "name": "referralClaimsPaused",
      "msg": "Referral claims are paused"
    },
    {
      "code": 6037,
      "name": "referralSignerUnset",
      "msg": "No referral signer is configured"
    },
    {
      "code": 6038,
      "name": "referralVoucherExpired",
      "msg": "Referral voucher has expired"
    },
    {
      "code": 6039,
      "name": "referralSignatureInvalid",
      "msg": "No Ed25519 verification of this referral voucher by the configured signer precedes this instruction"
    },
    {
      "code": 6040,
      "name": "referralNothingToClaim",
      "msg": "Referral voucher does not exceed what this recipient has already claimed"
    },
    {
      "code": 6041,
      "name": "referralDailyCapExceeded",
      "msg": "Referral claim would exceed today's cap"
    },
    {
      "code": 6042,
      "name": "paramsAccountMismatch",
      "msg": "Params account is not the params PDA"
    },
    {
      "code": 6043,
      "name": "paramsFeeSplitTooLarge",
      "msg": "fee_protocol_bps + fee_ops_bps + fee_burn_bps must not exceed 10000"
    },
    {
      "code": 6044,
      "name": "paramsFeeBoundsInvalid",
      "msg": "min_fee_bps must not exceed max_fee_bps"
    },
    {
      "code": 6045,
      "name": "paramsCashbackStartInvalid",
      "msg": "cb_start_fee_bps must be between max_fee_bps and 10000"
    },
    {
      "code": 6046,
      "name": "paramsCashbackWindowInvalid",
      "msg": "cb_window_secs must be greater than zero"
    },
    {
      "code": 6047,
      "name": "paramsGradMcapInvalid",
      "msg": "grad_mcap_usd_1e6 must be greater than zero"
    }
  ],
  "types": [
    {
      "name": "baseOracle",
      "docs": [
        "A pushed USD price for one base mint."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "price1e6",
            "docs": [
              "USD per whole base token, scaled 1e6."
            ],
            "type": "u64"
          },
          {
            "name": "conf1e6",
            "docs": [
              "Confidence band in the same scale."
            ],
            "type": "u64"
          },
          {
            "name": "publishTime",
            "type": "i64"
          },
          {
            "name": "baseDecimals",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "creatorFeesClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "baseAmount",
            "type": "u64"
          },
          {
            "name": "tokenAmount",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "curve",
      "docs": [
        "One launched coin: its curve, its fee ledger, and its stake pool."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "ticker",
            "type": "string"
          },
          {
            "name": "supply",
            "type": "u64"
          },
          {
            "name": "decimals",
            "type": "u8"
          },
          {
            "name": "baseDecimals",
            "type": "u8"
          },
          {
            "name": "feeBps",
            "docs": [
              "Creator-set curve fee, 100–500 bps."
            ],
            "type": "u16"
          },
          {
            "name": "cashback",
            "type": "bool"
          },
          {
            "name": "cbStart",
            "docs": [
              "Set once by the program at creation. No instruction can move it, so the",
              "5-minute window cannot be extended by any client."
            ],
            "type": "i64"
          },
          {
            "name": "virtualBase",
            "type": "u128"
          },
          {
            "name": "virtualToken",
            "type": "u128"
          },
          {
            "name": "realBase",
            "type": "u64"
          },
          {
            "name": "realToken",
            "type": "u64"
          },
          {
            "name": "k",
            "type": "u128"
          },
          {
            "name": "initVirtualBase",
            "type": "u128"
          },
          {
            "name": "initVirtualToken",
            "type": "u128"
          },
          {
            "name": "tokensForSale",
            "type": "u64"
          },
          {
            "name": "lpReserve",
            "type": "u64"
          },
          {
            "name": "gradMcapBase",
            "docs": [
              "Base atoms equal to $69,000 at the price read when the coin launched."
            ],
            "type": "u128"
          },
          {
            "name": "creationBasePrice1e6",
            "type": "u64"
          },
          {
            "name": "complete",
            "docs": [
              "Allocation exhausted: no further buys, awaiting `graduate`."
            ],
            "type": "bool"
          },
          {
            "name": "graduated",
            "type": "bool"
          },
          {
            "name": "graduationReason",
            "type": {
              "option": {
                "defined": {
                  "name": "graduationReason"
                }
              }
            }
          },
          {
            "name": "graduatedAt",
            "type": "i64"
          },
          {
            "name": "migrated",
            "docs": [
              "Set once `migrate_seed_liquidity` has deposited reserves into the",
              "escrow-owned Meteora DLMM position. Once true, `real_base` /",
              "`lp_reserve` are zero and seeding refuses to run again."
            ],
            "type": "bool"
          },
          {
            "name": "dexPool",
            "docs": [
              "Meteora DLMM `LbPair` address. Set by `migrate_create_pool`; verifiable",
              "independently on a block explorer. Layout-compatible rename of",
              "`raydium_pool`."
            ],
            "type": "pubkey"
          },
          {
            "name": "dexPositionMeta",
            "docs": [
              "Packed migration meta: lower 32 bits = `lower_bin_id` as u32 bit pattern,",
              "upper 32 bits = position `width` as u32. Enough to re-derive the DLMM",
              "position PDA with the escrow as base. Replaces `raydium_lp_burned`."
            ],
            "type": "u64"
          },
          {
            "name": "protocolAccrued",
            "type": "u64"
          },
          {
            "name": "opsAccrued",
            "type": "u64"
          },
          {
            "name": "creatorBucketAccrued",
            "type": "u64"
          },
          {
            "name": "creatorClaimableBase",
            "docs": [
              "Claimable by the creator, base mint. Never includes protocol or ops."
            ],
            "type": "u64"
          },
          {
            "name": "creatorClaimableToken",
            "docs": [
              "Claimable by the creator, launched token. Cashback window only."
            ],
            "type": "u64"
          },
          {
            "name": "eligibleStaked",
            "docs": [
              "Staked amount with a lock of at least 1 day. FLEX is excluded so a",
              "zero-weight position cannot dilute `poolFrac`."
            ],
            "type": "u64"
          },
          {
            "name": "flexStaked",
            "docs": [
              "FLEX escrow. Parked, zero weight, excluded from `poolFrac`."
            ],
            "type": "u64"
          },
          {
            "name": "totalWeight",
            "type": "u128"
          },
          {
            "name": "accBasePerWeight",
            "type": "u128"
          },
          {
            "name": "accTokenPerWeight",
            "type": "u128"
          },
          {
            "name": "poolDustBase",
            "docs": [
              "Rewards accrued but not yet divisible across the pool. Held, not lost."
            ],
            "type": "u64"
          },
          {
            "name": "poolDustToken",
            "type": "u64"
          },
          {
            "name": "stakerAccruedBase",
            "type": "u64"
          },
          {
            "name": "stakerAccruedToken",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "dexFeesClaimed",
      "docs": [
        "Fees claimed from the escrow-held Meteora DLMM position and routed",
        "through the curve's own split. Base-side legs go to the same per-base-mint",
        "treasuries as curve fees; the launched-token side has no treasury, so its",
        "non-bucket legs are burned and only the 69% bucket (creator + stakers) is",
        "credited in tokens."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "caller",
            "docs": [
              "Whoever cranked it. Permissionless."
            ],
            "type": "pubkey"
          },
          {
            "name": "feeBase",
            "type": "u64"
          },
          {
            "name": "feeToken",
            "type": "u64"
          },
          {
            "name": "protocol",
            "type": "u64"
          },
          {
            "name": "ops",
            "type": "u64"
          },
          {
            "name": "burn",
            "type": "u64"
          },
          {
            "name": "creatorBucketBase",
            "type": "u64"
          },
          {
            "name": "creatorBucketToken",
            "type": "u64"
          },
          {
            "name": "toCreatorBase",
            "type": "u64"
          },
          {
            "name": "toStakersBase",
            "type": "u64"
          },
          {
            "name": "toCreatorToken",
            "type": "u64"
          },
          {
            "name": "toStakersToken",
            "type": "u64"
          },
          {
            "name": "tokensBurned",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "feeAccrued",
      "docs": [
        "Matches the indexer's `FeeAccrued` — the 15/10/6/69 view on its own, for",
        "reconciliation against `Trade`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "feeTotal",
            "type": "u64"
          },
          {
            "name": "protocol",
            "type": "u64"
          },
          {
            "name": "ops",
            "type": "u64"
          },
          {
            "name": "burn",
            "type": "u64"
          },
          {
            "name": "creatorBucket",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "global",
      "docs": [
        "Program-wide configuration and the pause switches.",
        "",
        "`admin`, `protocol_withdraw_authority` and `ops_withdraw_authority` are",
        "three separate keys on purpose. The admin can pause but cannot move money;",
        "the two withdraw authorities can move money but cannot pause. Neither",
        "withdraw authority may be a server hot key — see SPEC.md §4."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "pendingAdmin",
            "docs": [
              "Two-step admin handover; `Pubkey::default()` when no handover is open."
            ],
            "type": "pubkey"
          },
          {
            "name": "protocolWithdrawAuthority",
            "docs": [
              "Multisig / cold key. Withdraws protocol revenue."
            ],
            "type": "pubkey"
          },
          {
            "name": "opsWithdrawAuthority",
            "docs": [
              "Multisig / cold key, distinct from the protocol one. Withdraws ops."
            ],
            "type": "pubkey"
          },
          {
            "name": "oracleAuthority",
            "docs": [
              "Pushes base-mint USD prices. A Pyth/Switchboard crank in production."
            ],
            "type": "pubkey"
          },
          {
            "name": "migrationAuthority",
            "docs": [
              "Runs migration after a graduation: creates the Meteora DLMM pool and",
              "permanently locks the position. See SPEC.md §5."
            ],
            "type": "pubkey"
          },
          {
            "name": "dexProgram",
            "docs": [
              "Meteora `lb_clmm` program. Admin-settable via `set_meteora_config`.",
              "Layout-compatible rename of the former `raydium_program` slot."
            ],
            "type": "pubkey"
          },
          {
            "name": "dexConfig",
            "docs": [
              "Meteora `PresetParameter2` (fee / bin-step tier) every graduation pool",
              "is created under. Layout-compatible rename of `raydium_amm_config`."
            ],
            "type": "pubkey"
          },
          {
            "name": "tradingPaused",
            "docs": [
              "Halts buy and sell. Does not block claims or unstakes."
            ],
            "type": "bool"
          },
          {
            "name": "launchPaused",
            "docs": [
              "Halts create_token only."
            ],
            "type": "bool"
          },
          {
            "name": "protocolWithdrawalsPaused",
            "docs": [
              "Runbook switch: stop protocol revenue leaving, trading unaffected."
            ],
            "type": "bool"
          },
          {
            "name": "opsWithdrawalsPaused",
            "docs": [
              "Runbook switch from plan step 141: stop ops funds leaving while trading",
              "and accrual both continue."
            ],
            "type": "bool"
          },
          {
            "name": "maxOracleStaleness",
            "docs": [
              "Max age, seconds, of an oracle push before graduation pricing refuses it."
            ],
            "type": "i64"
          },
          {
            "name": "tokenCount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "graduated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "reason",
            "type": "u8"
          },
          {
            "name": "baseMigrated",
            "type": "u64"
          },
          {
            "name": "tokensMigrated",
            "type": "u64"
          },
          {
            "name": "tokensBurned",
            "docs": [
              "Unsold curve tokens burned on an early oracle-triggered graduation."
            ],
            "type": "u64"
          },
          {
            "name": "mcapBase",
            "type": "u128"
          },
          {
            "name": "mcapUsd1e6",
            "type": "u128"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "graduationReason",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "curveComplete"
          },
          {
            "name": "oraclePrice"
          }
        ]
      }
    },
    {
      "name": "liquidityMigrated",
      "docs": [
        "Emitted once per coin, when `migrate_seed_liquidity` deposits into a Meteora",
        "DLMM position and permanently locks it (owner → dead / lock_release = max).",
        "DLMM has no fungible LP mint; `position` is the PositionV2 account."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "position",
            "docs": [
              "DLMM PositionV2 account (replaces the former Raydium `lp_mint` field)."
            ],
            "type": "pubkey"
          },
          {
            "name": "baseDeposited",
            "type": "u64"
          },
          {
            "name": "tokenDeposited",
            "type": "u64"
          },
          {
            "name": "lockReleasePoint",
            "docs": [
              "`lock_release_point` on the position. `0`: DLMM's operator timelock is",
              "not available to a non-whitelisted operator (see `graduate.rs` step 4);",
              "permanence is the program escrow owning the position with no withdraw",
              "instruction."
            ],
            "type": "u64"
          },
          {
            "name": "positionLocked",
            "docs": [
              "`1` once the position is held by the per-mint escrow PDA."
            ],
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "params",
      "docs": [
        "Admin-tunable numbers, in their own PDA (`[\"params\"]`) so no existing",
        "account layout changes and the upgrade needs no migration: every reader",
        "goes through [`load_params`], which returns [`Params::defaults`] while the",
        "account does not exist yet. The curve *shape* (supply menu, 4/5 sale",
        "fraction, virtual-reserve ratios, lock tables) is deliberately not here —",
        "those are parity invariants shared with the EVM mirror, not tunables."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "feeProtocolBps",
            "docs": [
              "Platform revenue share of every fee, bps."
            ],
            "type": "u16"
          },
          {
            "name": "feeOpsBps",
            "docs": [
              "`$STONKZ` buyback share, bps (historical `ops` name on chain)."
            ],
            "type": "u16"
          },
          {
            "name": "feeBurnBps",
            "docs": [
              "RWA crate fund share, bps (historical `burn` name on chain)."
            ],
            "type": "u16"
          },
          {
            "name": "minFeeBps",
            "docs": [
              "Creator-set curve fee bounds, inclusive."
            ],
            "type": "u16"
          },
          {
            "name": "maxFeeBps",
            "type": "u16"
          },
          {
            "name": "cbStartFeeBps",
            "docs": [
              "The fee a cashback window decays down from."
            ],
            "type": "u16"
          },
          {
            "name": "cbWindowSecs",
            "docs": [
              "Cashback window length, seconds."
            ],
            "type": "u32"
          },
          {
            "name": "gradMcapUsd1e6",
            "docs": [
              "Graduation market cap, USD scaled 1e6."
            ],
            "type": "u64"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          }
        ]
      }
    },
    {
      "name": "paramsArgs",
      "docs": [
        "Everything on `Params` an admin can set. Same field order as the account",
        "minus `bump` / `_reserved`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "feeProtocolBps",
            "type": "u16"
          },
          {
            "name": "feeOpsBps",
            "type": "u16"
          },
          {
            "name": "feeBurnBps",
            "type": "u16"
          },
          {
            "name": "minFeeBps",
            "type": "u16"
          },
          {
            "name": "maxFeeBps",
            "type": "u16"
          },
          {
            "name": "cbStartFeeBps",
            "type": "u16"
          },
          {
            "name": "cbWindowSecs",
            "type": "u32"
          },
          {
            "name": "gradMcapUsd1e6",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "paramsSet",
      "docs": [
        "`set_params`: the runtime parameters after the change."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "feeProtocolBps",
            "type": "u16"
          },
          {
            "name": "feeOpsBps",
            "type": "u16"
          },
          {
            "name": "feeBurnBps",
            "type": "u16"
          },
          {
            "name": "minFeeBps",
            "type": "u16"
          },
          {
            "name": "maxFeeBps",
            "type": "u16"
          },
          {
            "name": "cbStartFeeBps",
            "type": "u16"
          },
          {
            "name": "cbWindowSecs",
            "type": "u32"
          },
          {
            "name": "gradMcapUsd1e6",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "pauserConfig",
      "docs": [
        "Who may pause. Separate from `Global` so appointing a pauser never",
        "reallocates the account every instruction reads."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "pauser",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "referralClaimState",
      "docs": [
        "Lifetime referral amount already paid to one recipient for one base mint",
        "(`[\"referral_claim\", base_mint, recipient]`). A voucher pays",
        "`cumulative_amount - claimed`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "claimed",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "referralClaimed",
      "docs": [
        "A referral voucher was redeemed: `amount` left the referral vault for",
        "`recipient`, whose lifetime claimed is now `cumulative_amount`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "cumulativeAmount",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "referralConfig",
      "docs": [
        "Referral payout configuration, appended in its own PDA",
        "(`[\"referral_config\"]`) so no existing account layout changes. Admin sets",
        "`signer` (the API's Ed25519 voucher key), `max_per_day` (base atoms, the",
        "blast radius of a leaked signer; `0` refuses every claim, `u64::MAX`",
        "uncapped) and `cluster_tag`; admin or the pauser sets `paused`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "signer",
            "type": "pubkey"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "maxPerDay",
            "type": "u64"
          },
          {
            "name": "dayStart",
            "docs": [
              "Start of the rolling day `claimed_today` counts against."
            ],
            "type": "i64"
          },
          {
            "name": "claimedToday",
            "type": "u64"
          },
          {
            "name": "clusterTag",
            "docs": [
              "8-byte cluster marker every voucher carries (`b\"mainnet\\0\"`, …)."
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          }
        ]
      }
    },
    {
      "name": "referralConfigSet",
      "docs": [
        "`set_referral_signer` / `set_referral_paused`: the config after the change."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "signer",
            "type": "pubkey"
          },
          {
            "name": "maxPerDay",
            "type": "u64"
          },
          {
            "name": "clusterTag",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "referralVaultFunded",
      "docs": [
        "`fund_referral_vault` (a `withdraw_treasury` into the vault emits",
        "`TreasuryWithdrawn` instead)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "funder",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "stakeClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "baseAmount",
            "type": "u64"
          },
          {
            "name": "tokenAmount",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "stakePosition",
      "docs": [
        "One staker's position in one coin. Seeds bind it to that coin's mint, so",
        "weight in one pool can never settle against another's accumulator."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "curve",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "lockDays",
            "type": "u16"
          },
          {
            "name": "weight",
            "type": "u128"
          },
          {
            "name": "lockUntil",
            "type": "i64"
          },
          {
            "name": "baseDebt",
            "type": "u128"
          },
          {
            "name": "tokenDebt",
            "type": "u128"
          },
          {
            "name": "unclaimedBase",
            "type": "u64"
          },
          {
            "name": "unclaimedToken",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "staked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "lockDays",
            "type": "u16"
          },
          {
            "name": "weight",
            "type": "u128"
          },
          {
            "name": "lockUntil",
            "type": "i64"
          },
          {
            "name": "eligibleStaked",
            "type": "u64"
          },
          {
            "name": "totalWeight",
            "type": "u128"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "tokenCreated",
      "docs": [
        "Matches the indexer's `TokenCreated`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "ticker",
            "type": "string"
          },
          {
            "name": "supply",
            "type": "u64"
          },
          {
            "name": "feeBps",
            "type": "u16"
          },
          {
            "name": "cashback",
            "type": "bool"
          },
          {
            "name": "cbStart",
            "type": "i64"
          },
          {
            "name": "virtualBase",
            "type": "u128"
          },
          {
            "name": "virtualToken",
            "type": "u128"
          },
          {
            "name": "tokensForSale",
            "type": "u64"
          },
          {
            "name": "lpReserve",
            "type": "u64"
          },
          {
            "name": "gradMcapBase",
            "type": "u128"
          },
          {
            "name": "basePrice1e6",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "trade",
      "docs": [
        "Matches the indexer's `Trade`. `fee_*` fields carry the settled split, so",
        "the indexer never has to recompute it."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "isBuy",
            "type": "bool"
          },
          {
            "name": "baseAmount",
            "type": "u64"
          },
          {
            "name": "tokenAmount",
            "type": "u64"
          },
          {
            "name": "effFeeBps",
            "type": "u16"
          },
          {
            "name": "inCashback",
            "type": "bool"
          },
          {
            "name": "feeTotal",
            "type": "u64"
          },
          {
            "name": "feeProtocol",
            "type": "u64"
          },
          {
            "name": "feeOps",
            "type": "u64"
          },
          {
            "name": "feeBurn",
            "docs": [
              "RWA crate fund leg (6%). Historical `burn` name."
            ],
            "type": "u64"
          },
          {
            "name": "feeCreatorBucket",
            "type": "u64"
          },
          {
            "name": "feeStakers",
            "docs": [
              "The slice of the creator bucket peeled off to this coin's stakers."
            ],
            "type": "u64"
          },
          {
            "name": "feeCreator",
            "docs": [
              "The rest of the bucket, credited to the creator."
            ],
            "type": "u64"
          },
          {
            "name": "cashbackTokens",
            "docs": [
              "Non-zero only during cashback: the bucket converted to the token."
            ],
            "type": "u64"
          },
          {
            "name": "virtualBase",
            "type": "u128"
          },
          {
            "name": "virtualToken",
            "type": "u128"
          },
          {
            "name": "realBase",
            "type": "u64"
          },
          {
            "name": "realToken",
            "type": "u64"
          },
          {
            "name": "circulating",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "treasury",
      "docs": [
        "Which treasury a withdrawal targets."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "protocol"
          },
          {
            "name": "ops"
          },
          {
            "name": "burn"
          }
        ]
      }
    },
    {
      "name": "treasuryCredit",
      "docs": [
        "Matches the indexer's `TreasuryCredit`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "protocolDelta",
            "type": "u64"
          },
          {
            "name": "opsDelta",
            "type": "u64"
          },
          {
            "name": "burnDelta",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "treasuryWithdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "which",
            "docs": [
              "0 = protocol revenue, 1 = `$STONKZ` ops."
            ],
            "type": "u8"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "unstaked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "eligibleStaked",
            "type": "u64"
          },
          {
            "name": "totalWeight",
            "type": "u128"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    }
  ]
};
