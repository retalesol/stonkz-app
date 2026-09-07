import { toast } from '../fx/toast.js';
import { must } from '../lib/dom.js';
import { USER, saveUser } from '../state/user.js';
import { closeScrim, isOpen, openScrim, wireBackdrop } from './scrim.js';

/**
 * Username and bio, saved on this device. Phase 5.A moves both behind a
 * signed `PATCH /users/me`. `index.html:3529`
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
    USER.name = must<HTMLInputElement>('#ed-name').value.trim().slice(0, 22);
    USER.bio = must<HTMLTextAreaElement>('#ed-bio').value.trim().slice(0, 160);
    saveUser();
    closeEdit();
    toast('PROFILE SAVED');
    onSaved();
  });
}
