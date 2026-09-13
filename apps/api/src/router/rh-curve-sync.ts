/** Re-exports — prefer `./curve-sync.js` for new code. */
export {
  COINS_REAL_BASE_WORD,
  COINS_REAL_TOKEN_WORD,
  fetchRhCurveReserves,
  parseCoinsReserves,
  syncRhCurveReserves,
  type CurveReserves as RhCurveReserves,
  type CurveSyncRow as RhCurveSyncRow,
  type EthCaller,
} from './curve-sync.js';
