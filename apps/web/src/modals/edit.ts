import { api } from '../api/index.js';
import { SocialApiError, patchMyProfile, uploadAvatar } from '../api/social.js';
import { toast } from '../fx/toast.js';
import { paintAvatar } from '../lib/avatar.js';
import { must } from '../lib/dom.js';
import { DOT } from '../lib/fmt.js';
import { rememberIdentity } from '../lib/identity.js';
import { WALLET } from '../state/wallet.js';
import { USER, saveUser } from '../state/user.js';
import { closeScrim, isOpen, openScrim, wireBackdrop } from './scrim.js';

/**
 * Username, bio and profile picture. Live mode persists via `PATCH /me` and
 * `POST /me/avatar` (Pinata). Local `USER` mirrors what chat and the wallet
 * chip read.
 */

const USERNAME_RE = /^[A-Za-z0-9_]{1,22}$/;

function paintEditAvatar(): void {
  paintAvatar(must<HTMLCanvasElement>('#ed-av'), {
    seed: WALLET.full || WALLET.addr || WALLET.seed,
    avatarUrl: USER.avatarUrl ?? null,
    size: 96,
  });
}

export function openEdit(opener?: Element | null): void {
  must<HTMLInputElement>('#ed-name').value = USER.name || '';
  must<HTMLTextAreaElement>('#ed-bio').value = USER.bio || '';
  paintEditAvatar();
  openScrim('#editScrim', opener);
}

export function closeEdit(): void {
  closeScrim('#editScrim');
}

export function isEditOpen(): boolean {
  return isOpen('#editScrim');
}

export function initEdit(onSaved: () => void): void {
  wireBackdrop('#editScrim', closeEdit);

  must('#ed-upload').addEventListener('click', () => must<HTMLInputElement>('#ed-file').click());
  must<HTMLInputElement>('#ed-file').addEventListener('change', () => {
    const input = must<HTMLInputElement>('#ed-file');
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (api.mode !== 'live') {
      toast('AVATAR PREVIEW ' + DOT + ' LIVE MODE UPLOADS TO IPFS');
      return;
    }
    void (async () => {
      try {
        toast('UPLOADING…');
        const res = await uploadAvatar(WALLET.net, file);
        USER.avatarUrl = res.avatarUrl;
        rememberIdentity(WALLET.full, { username: USER.name ?? null, avatarUrl: res.avatarUrl });
        saveUser();
        paintEditAvatar();
        toast('AVATAR SAVED');
        onSaved();
      } catch (err) {
        toast(err instanceof SocialApiError ? err.message : 'AVATAR UPLOAD FAILED', 'red');
      }
    })();
  });

  must<HTMLFormElement>('#editForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = must<HTMLInputElement>('#ed-name').value.trim().slice(0, 22);
    const bio = must<HTMLTextAreaElement>('#ed-bio').value.trim().slice(0, 160);
    if (name && !USERNAME_RE.test(name)) {
      toast('USERNAME MUST BE 1–22 LETTERS, NUMBERS OR _', 'red');
      return;
    }
    const prev = { name: USER.name, bio: USER.bio };
    USER.name = name;
    USER.bio = bio;
    rememberIdentity(WALLET.full, { username: name || null, avatarUrl: USER.avatarUrl ?? null });
    saveUser();

    if (api.mode === 'live') {
      void patchMyProfile(WALLET.net, { username: name, bio })
        .then(() => {
          closeEdit();
          toast('PROFILE SAVED');
          onSaved();
        })
        .catch((err) => {
          USER.name = prev.name ?? '';
          USER.bio = prev.bio ?? '';
          saveUser();
          toast(err instanceof SocialApiError ? err.message : 'PROFILE SYNC FAILED', 'red');
        });
      return;
    }
    closeEdit();
    toast('PROFILE SAVED');
    onSaved();
  });
}
