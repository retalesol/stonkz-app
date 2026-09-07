import { api } from '../api/index.js';
import { SocialApiError, patchMyProfile } from '../api/social.js';
import { toast } from '../fx/toast.js';
import { must } from '../lib/dom.js';
import { WALLET } from '../state/wallet.js';
import { USER, saveUser } from '../state/user.js';
import { closeScrim, isOpen, openScrim, wireBackdrop } from './scrim.js';

/**
 * Username and bio. Live mode persists both server-side via a signed
 * `PATCH /me` (`routes/social.ts`) so any device that later opens this
 * wallet's profile sees the real values; `USER.name`/`USER.bio` stay the
 * local mirror `renderProfile`'s `myName()`/`myBio()` read from either way.
 * `index.html:3529`
 */

export function openEdit(opener?: Element | null): void {
  must<HTMLInputElement>('#ed-name').value = USER.name || '';
  must<HTMLTextAreaElement>('#ed-bio').value = USER.bio || '';
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
  must<HTMLFormElement>('#editForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = must<HTMLInputElement>('#ed-name').value.trim().slice(0, 22);
    const bio = must<HTMLTextAreaElement>('#ed-bio').value.trim().slice(0, 160);
    USER.name = name;
    USER.bio = bio;
    saveUser();
    closeEdit();
    if (api.mode === 'live') {
      patchMyProfile(WALLET.net, { username: name, bio }).catch((err) => {
        toast(err instanceof SocialApiError ? err.message : 'PROFILE SYNC FAILED');
      });
    }
    toast('PROFILE SAVED');
    onSaved();
  });
}
