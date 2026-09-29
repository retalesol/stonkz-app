import { describe, expect, it } from 'vitest';
import {
  type ChatAccess,
  composerState,
  exactUsd,
  holderNotice,
  isPrivateRoom,
  liveRoomKey,
  privateRoomOf,
  roomLabel,
  roomSym,
  roomTitle,
  volumeNotice,
} from './chat-access.js';
import { type ChatState, bumpUnread, clearUnread, unreadIn } from '../state/chat.js';

function access(over: Partial<ChatAccess> = {}): ChatAccess {
  return {
    room: 'GLOBAL',
    kind: 'global',
    sym: null,
    signedIn: true,
    canRead: true,
    canPost: true,
    reason: null,
    volumeUsd: 250,
    volumeRequiredUsd: 100,
    holdingUsd: null,
    holdingRequiredUsd: 5,
    ...over,
  };
}

describe('room names', () => {
  it('derives the three rooms of a token and their labels', () => {
    expect(privateRoomOf('wojak')).toBe('$WOJAK:PRIVATE');
    expect(isPrivateRoom('$WOJAK:PRIVATE')).toBe(true);
    expect(isPrivateRoom('$WOJAK')).toBe(false);
    expect(roomSym('GLOBAL')).toBeNull();
    expect(roomSym('$WOJAK')).toBe('WOJAK');
    expect(roomSym('$WOJAK:PRIVATE')).toBe('WOJAK');
    expect(roomLabel('GLOBAL')).toBe('GLOBAL');
    expect(roomLabel('$WOJAK')).toBe('$WOJAK');
    expect(roomLabel('$WOJAK:PRIVATE')).toBe('$WOJAK (PRIVATE)');
    expect(roomTitle('$WOJAK:PRIVATE')).toBe('$WOJAK PRIVATE CHAT');
    expect(roomTitle('GLOBAL')).toBe('GLOBAL CHAT');
  });

  it('maps a web room onto the server key', () => {
    expect(liveRoomKey('GLOBAL')).toBe('GLOBAL');
    expect(liveRoomKey('$wojak')).toBe('WOJAK');
    expect(liveRoomKey('$WOJAK:PRIVATE')).toBe('WOJAK:PRIVATE');
  });
});

describe('gate copy', () => {
  it('prints exact dollars, never the abbreviated $1.2K', () => {
    expect(exactUsd(0)).toBe('$0');
    expect(exactUsd(42.5)).toBe('$42.5');
    expect(exactUsd(42.55)).toBe('$42.55');
    expect(exactUsd(100)).toBe('$100');
    expect(exactUsd(1234)).toBe('$1234');
    expect(exactUsd(Number.NaN)).toBe('$0');
  });

  it('spells the two locks the product owner asked for', () => {
    expect(volumeNotice({ volumeUsd: 42.5, volumeRequiredUsd: 100 })).toBe(
      'TRADE $100 TO UNLOCK CHAT · $42.5 SO FAR',
    );
    expect(volumeNotice({ volumeUsd: null, volumeRequiredUsd: 100 })).toBe(
      'TRADE $100 TO UNLOCK CHAT · $0 SO FAR',
    );
    expect(holderNotice('wojak')).toBe('HOLD $5 OF $WOJAK TO ENTER');
  });
});

describe('composer state', () => {
  it('is always live in sim mode', () => {
    const s = composerState({ room: '$WOJAK:PRIVATE', live: false, walletOn: false, access: null });
    expect(s).toMatchObject({ mode: 'ready', disabled: false, notice: null, hidesLog: false });
  });

  it('asks for a wallet before anything else', () => {
    expect(
      composerState({ room: 'GLOBAL', live: true, walletOn: false, access: null }),
    ).toMatchObject({ mode: 'connect', disabled: true, placeholder: 'CONNECT A WALLET TO CHAT' });
    const priv = composerState({
      room: '$WOJAK:PRIVATE',
      live: true,
      walletOn: false,
      access: null,
    });
    expect(priv).toMatchObject({ mode: 'connect', hidesLog: true });
    expect(priv.notice).toBe('HOLD $5 OF $WOJAK TO ENTER');
  });

  it('waits for the access call with the input disabled', () => {
    expect(
      composerState({ room: 'GLOBAL', live: true, walletOn: true, access: null }),
    ).toMatchObject({ mode: 'loading', disabled: true, hidesLog: false });
    expect(
      composerState({ room: '$WOJAK:PRIVATE', live: true, walletOn: true, access: null }),
    ).toMatchObject({ mode: 'loading', disabled: true, hidesLog: true });
  });

  it('shows the volume progress and keeps the log readable under $100', () => {
    const s = composerState({
      room: 'GLOBAL',
      live: true,
      walletOn: true,
      access: access({ canPost: false, reason: 'volume_required', volumeUsd: 42.5 }),
    });
    expect(s.mode).toBe('volume');
    expect(s.disabled).toBe(true);
    expect(s.hidesLog).toBe(false);
    expect(s.notice).toBe('TRADE $100 TO UNLOCK CHAT · $42.5 SO FAR');
    expect(s.progress).toBeCloseTo(0.425);
  });

  it('clamps the progress bar and opens up at exactly the gate', () => {
    const over = composerState({
      room: '$WOJAK',
      live: true,
      walletOn: true,
      access: access({ kind: 'token', sym: 'WOJAK', canPost: false, volumeUsd: 260 }),
    });
    expect(over.progress).toBe(1);
    const at = composerState({
      room: '$WOJAK',
      live: true,
      walletOn: true,
      access: access({ kind: 'token', sym: 'WOJAK', canPost: true, volumeUsd: 100 }),
    });
    expect(at).toMatchObject({ mode: 'ready', disabled: false, notice: null, progress: null });
  });

  it('locks the private room, log included, for a non-holder', () => {
    const s = composerState({
      room: '$WOJAK:PRIVATE',
      live: true,
      walletOn: true,
      access: access({
        kind: 'private',
        sym: 'WOJAK',
        canRead: false,
        canPost: false,
        reason: 'holder_required',
        holdingUsd: 1.2,
      }),
    });
    expect(s).toMatchObject({ mode: 'locked', disabled: true, hidesLog: true, progress: null });
    expect(s.notice).toBe('HOLD $5 OF $WOJAK TO ENTER');
  });

  it('uses the server threshold for the lock line', () => {
    const s = composerState({
      room: '$WOJAK:PRIVATE',
      live: true,
      walletOn: true,
      access: access({
        kind: 'private',
        sym: 'WOJAK',
        canRead: false,
        canPost: false,
        reason: 'holder_required',
        holdingRequiredUsd: 7.5,
      }),
    });
    expect(s.notice).toBe('HOLD $7.5 OF $WOJAK TO ENTER');
  });

  it('opens the private room for a holder without any volume requirement', () => {
    const s = composerState({
      room: '$WOJAK:PRIVATE',
      live: true,
      walletOn: true,
      access: access({
        kind: 'private',
        sym: 'WOJAK',
        canRead: true,
        canPost: true,
        volumeUsd: 0,
        holdingUsd: 9,
      }),
    });
    expect(s).toMatchObject({ mode: 'ready', disabled: false, hidesLog: false });
  });

  it('marks a private room for an unindexed token as unavailable', () => {
    const s = composerState({
      room: '$NOPE:PRIVATE',
      live: true,
      walletOn: true,
      access: access({
        kind: 'private',
        sym: 'NOPE',
        canRead: false,
        canPost: false,
        reason: 'unknown_token',
      }),
    });
    expect(s).toMatchObject({ mode: 'unavailable', disabled: true, hidesLog: true });
  });
});

describe('per-room unread counts', () => {
  function state(): ChatState {
    return {
      room: 'GLOBAL',
      token: { sym: 'WOJAK', seed: 1 },
      logs: {},
      unread: 0,
      unreadByRoom: {},
      access: {},
      open: false,
    };
  }

  it('counts each room on its own and sums them for the tab', () => {
    const s = state();
    bumpUnread(s, 'GLOBAL');
    bumpUnread(s, '$WOJAK');
    bumpUnread(s, '$WOJAK');
    bumpUnread(s, '$WOJAK:PRIVATE');
    expect(unreadIn(s, 'GLOBAL')).toBe(1);
    expect(unreadIn(s, '$WOJAK')).toBe(2);
    expect(unreadIn(s, '$WOJAK:PRIVATE')).toBe(1);
    expect(s.unread).toBe(4);
  });

  it('opening one room clears only that room', () => {
    const s = state();
    bumpUnread(s, 'GLOBAL');
    bumpUnread(s, '$WOJAK');
    bumpUnread(s, '$WOJAK');
    expect(clearUnread(s, '$WOJAK')).toBe(1);
    expect(unreadIn(s, '$WOJAK')).toBe(0);
    expect(unreadIn(s, 'GLOBAL')).toBe(1);
    // Clearing an already-clear room changes nothing and never goes negative.
    expect(clearUnread(s, '$WOJAK')).toBe(1);
    expect(clearUnread(s, '$NEVER')).toBe(1);
  });
});
