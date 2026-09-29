import { api } from '../api/index.js';
import {
  ProfileFieldError,
  SocialApiError,
  patchMyProfile,
  revokeOtherSessions,
  uploadAvatar,
  type ProfilePatch,
} from '../api/social.js';
import { toast } from '../fx/toast.js';
import { paintAvatar } from '../lib/avatar.js';
import { SquareCropper, imageNaturalSize, isSquareAspect } from '../lib/crop.js';
import { $, must } from '../lib/dom.js';
import { DOT } from '../lib/fmt.js';
import { type Html, attr, html, render } from '../lib/html.js';
import { rememberIdentity } from '../lib/identity.js';
import { WALLET } from '../state/wallet.js';
import { USER, saveUser } from '../state/user.js';
import { invalidateProfile } from '../views/profile.js';
import { checkImageFile } from './launch-rules.js';
import { closeScrim, isOpen, openScrim, refreshScrim, wireBackdrop } from './scrim.js';

/**
 * The profile settings dialog: picture (with an inline square crop and
 * explicit upload states), username, bio, links, the private toggle and
 * "sign out everywhere".
 *
 * Live mode persists through `PATCH /me` / `POST /me/avatar`; a refusal from
 * the API names the field (`ProfileFieldError`) and lands under that input
 * rather than as one generic toast. The local `USER` mirror — what the chip,
 * chat and the wall read — is only updated once the server has accepted.
 */

const USERNAME_RE = /^[A-Za-z0-9_]{1,22}$/;
const BIO_MAX = 160;

type Field = keyof ProfilePatch;

interface Draft {
  username: string;
  bio: string;
  website: string;
  xHandle: string;
  telegram: string;
  private: boolean;
}

let draft: Draft = emptyDraft();
let cropper: SquareCropper | null = null;
let cropFile: File | null = null;
let uploading = false;
let saving = false;
let signoutArmed = false;
let previewUrl: string | null = null;

function emptyDraft(): Draft {
  return { username: '', bio: '', website: '', xHandle: '', telegram: '', private: false };
}

function draftFromUser(): Draft {
  return {
    username: USER.name ?? '',
    bio: USER.bio ?? '',
    website: USER.website ?? '',
    xHandle: USER.xHandle ?? '',
    telegram: USER.telegram ? USER.telegram.replace(/^https:\/\/t\.me\//i, '') : '',
    private: !!USER.private,
  };
}

/* --------------------------------- markup --------------------------------- */

function fieldHTML(key: Field, label: string, input: Html, hint?: string, counter?: string): Html {
  return html`<div class="ed-row" data-field="${key}">
    <span class="lbl"
      >${label}${counter ? html`<span class="cnt" data-cnt="${key}">${counter}</span>` : ''}</span
    >${input}<small class="ed-err" data-err="${key}" aria-live="polite"></small>${
      hint ? html`<p class="hint">${hint}</p>` : ''
    }
  </div>`;
}

function formHTML(): Html {
  const live = api.mode === 'live';
  const hasAvatar = !!USER.avatarUrl;
  return html`<div class="ed-av">
      <canvas id="ed-av" width="96" height="96" aria-hidden="true"></canvas>
      <div>
        <span class="lbl">PROFILE PICTURE</span>
        <input type="file" id="ed-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden />
        <div class="ed-av-acts">
          <button type="button" class="wiz-btn" id="ed-upload" ${uploading ? ' disabled' : ''}>
            ${uploading ? 'UPLOADING…' : hasAvatar ? 'REPLACE PFP' : 'UPLOAD PFP'}</button
          >${
            hasAvatar
              ? html`<button
                  type="button"
                  class="wiz-btn"
                  id="ed-remove"
                  ${uploading ? ' disabled' : ''}
                >
                  REMOVE
                </button>`
              : ''
          }
        </div>
        <span class="ed-av-status" id="ed-av-status" aria-live="polite"></span>
        <small class="ed-err" data-err="avatarUrl" aria-live="polite"></small>
        <p class="hint" style="margin-top:4px">
          SQUARE PNG, JPEG, WEBP OR GIF UNDER 5 MB. NON-SQUARE IMAGES OPEN A CROP.
          ${live ? 'UPLOADS GO TO IPFS.' : 'LIVE MODE UPLOADS TO IPFS.'}
        </p>
      </div>
    </div>
    <div class="ed-crop" id="ed-crop" hidden>
      <span class="lbl">CROP YOUR PICTURE</span>
      <canvas id="ed-crop-canvas" width="512" height="512" aria-label="Crop preview"></canvas>
      <label class="crop-zoom-row"
        ><span class="lbl">ZOOM</span>
        <input type="range" id="ed-crop-zoom" min="100" max="400" value="100" aria-label="Zoom"
      /></label>
      <div class="ed-crop-acts">
        <button type="button" class="wiz-btn" id="ed-crop-cancel">CANCEL</button>
        <button type="button" class="wiz-btn go" id="ed-crop-apply">USE CROP</button>
      </div>
    </div>
    ${fieldHTML(
      'username',
      'USERNAME',
      html`<input
        class="fld"
        id="ed-name"
        maxlength="22"
        autocomplete="off"
        spellcheck="false"
        placeholder="TRENCHRAT"
        value="${attr(draft.username)}"
      />`,
      '1–22 LETTERS, NUMBERS OR _. UNIQUE ACROSS STONKZ. SHOWN IN CHAT, TRADES, HOLDER LISTS AND YOUR WALL.',
    )}
    ${fieldHTML(
      'bio',
      'BIO',
      html`<textarea
        class="fld"
        id="ed-bio"
        maxlength="${BIO_MAX}"
        rows="3"
        placeholder="say something about yourself"
      >
${draft.bio}</textarea>`,
      undefined,
      `${draft.bio.length}/${BIO_MAX}`,
    )}
    ${fieldHTML(
      'website',
      'WEBSITE',
      html`<input
        class="fld"
        id="ed-web"
        maxlength="200"
        autocomplete="off"
        spellcheck="false"
        inputmode="url"
        placeholder="https://"
        value="${attr(draft.website)}"
      />`,
    )}
    ${fieldHTML(
      'xHandle',
      'X / TWITTER',
      html`<input
        class="fld"
        id="ed-x"
        maxlength="60"
        autocomplete="off"
        spellcheck="false"
        placeholder="@handle"
        value="${attr(draft.xHandle ? '@' + draft.xHandle : '')}"
      />`,
    )}
    ${fieldHTML(
      'telegram',
      'TELEGRAM',
      html`<input
        class="fld"
        id="ed-tg"
        maxlength="200"
        autocomplete="off"
        spellcheck="false"
        placeholder="@username or t.me/…"
        value="${attr(draft.telegram)}"
      />`,
    )}
    <div class="ed-row" data-field="private">
      <span class="lbl">PRIVATE PROFILE</span>
      <div class="ed-priv">
        <button type="button" class="chipm${draft.private ? '' : ' on'}" data-priv="0">
          PUBLIC
        </button>
        <button type="button" class="chipm${draft.private ? ' on' : ''}" data-priv="1">
          PRIVATE
        </button>
      </div>
      <small class="ed-err" data-err="private"></small>
      <p class="hint" id="ed-priv-copy">
        ${
          draft.private
            ? 'ONLY YOU CAN SEE YOUR HOLDINGS, PNL, RECENT ACTIVITY, WALL AND FRIENDS. YOUR USERNAME, PICTURE, BIO, LINKS AND THE COINS YOU LAUNCHED STAY PUBLIC — CREATOR ATTRIBUTION IS ON CHAIN.'
            : 'ANYONE CAN SEE YOUR HOLDINGS, PNL, RECENT ACTIVITY, WALL AND FRIENDS. SWITCH TO PRIVATE TO KEEP THEM TO YOURSELF.'
        }
      </p>
    </div>
    <div class="ed-foot">
      <button type="submit" class="big" id="ed-save" ${saving ? ' disabled' : ''}>
        ${saving ? 'SAVING…' : 'SAVE PROFILE'}</button
      >${
        live
          ? html`<button
              type="button"
              class="ghost"
              id="ed-signout"
              title="Revoke every other device's session for this wallet"
            >
              ${signoutArmed ? 'CONFIRM SIGN OUT EVERYWHERE?' : 'SIGN OUT EVERYWHERE'}
            </button>`
          : ''
      }
    </div>`;
}

function paintEditAvatar(): void {
  paintAvatar($<HTMLCanvasElement>('#ed-av'), {
    seed: WALLET.full || WALLET.addr || WALLET.seed,
    avatarUrl: previewUrl ?? USER.avatarUrl ?? null,
    size: 96,
  });
}

function fill(): void {
  render(must('#editForm'), formHTML());
  paintEditAvatar();
  refreshScrim('#editScrim');
}

/* -------------------------------- errors ---------------------------------- */

function setError(field: Field, message: string | null): void {
  const form = must('#editForm');
  const err = form.querySelector<HTMLElement>(`[data-err="${field}"]`);
  if (err) err.textContent = message ? message.toUpperCase() : '';
  const row = form.querySelector<HTMLElement>(`[data-field="${field}"]`);
  row?.querySelector('.fld')?.classList.toggle('bad', !!message);
  if (message) {
    (row?.querySelector('.fld') as HTMLElement | null)?.focus?.();
  }
}

function clearErrors(): void {
  for (const el of must('#editForm').querySelectorAll<HTMLElement>('.ed-err')) el.textContent = '';
  for (const el of must('#editForm').querySelectorAll('.fld.bad')) el.classList.remove('bad');
}

function setAvatarStatus(text: string): void {
  const s = $('#ed-av-status');
  if (s) s.textContent = text;
}

/* ------------------------------ validation -------------------------------- */

type Check = { ok: true; value: string } | { ok: false; error: string };

function checkUsernameLocal(raw: string): Check {
  const v = raw.trim();
  if (!v) return { ok: true, value: '' };
  if (!USERNAME_RE.test(v))
    return { ok: false, error: 'USERNAME MUST BE 1–22 LETTERS, NUMBERS OR _' };
  if (/^_+$/.test(v)) return { ok: false, error: 'USERNAME NEEDS A LETTER OR A NUMBER' };
  return { ok: true, value: v };
}

function checkWebsiteLocal(raw: string): Check {
  const v = raw.trim();
  if (!v) return { ok: true, value: '' };
  if (/\s/.test(v)) return { ok: false, error: 'WEBSITE MUST NOT CONTAIN SPACES' };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : 'https://' + v;
  try {
    const u = new URL(withScheme);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname.includes('.'))
      return { ok: false, error: 'WEBSITE MUST BE AN HTTP(S) LINK' };
    return { ok: true, value: withScheme };
  } catch {
    return { ok: false, error: 'WEBSITE MUST BE AN HTTP(S) LINK' };
  }
}

function checkXLocal(raw: string): Check {
  let v = raw.trim();
  if (!v) return { ok: true, value: '' };
  const link = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([^/?#]+)/i.exec(v);
  if (link?.[1]) v = link[1];
  v = v.replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(v))
    return { ok: false, error: 'X HANDLE MUST BE 1–15 LETTERS, NUMBERS OR _' };
  return { ok: true, value: v };
}

function checkTelegramLocal(raw: string): Check {
  const v = raw.trim();
  if (!v) return { ok: true, value: '' };
  if (/\s/.test(v)) return { ok: false, error: 'TELEGRAM MUST NOT CONTAIN SPACES' };
  const isLink = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/[^?#]+/i.test(v);
  const isHandle = /^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(v);
  if (!isLink && !isHandle)
    return { ok: false, error: 'TELEGRAM MUST BE A USERNAME OR A T.ME LINK' };
  return { ok: true, value: v };
}

function readDraft(): Draft {
  return {
    username: must<HTMLInputElement>('#ed-name').value,
    bio: must<HTMLTextAreaElement>('#ed-bio').value.slice(0, BIO_MAX),
    website: must<HTMLInputElement>('#ed-web').value,
    xHandle: must<HTMLInputElement>('#ed-x').value,
    telegram: must<HTMLInputElement>('#ed-tg').value,
    private: draft.private,
  };
}

/* --------------------------------- avatar --------------------------------- */

function closeCrop(): void {
  cropper?.destroy();
  cropper = null;
  cropFile = null;
  const box = $('#ed-crop');
  if (box) box.hidden = true;
}

async function openCrop(file: File): Promise<void> {
  const box = must('#ed-crop');
  box.hidden = false;
  cropper?.destroy();
  cropper = new SquareCropper(must<HTMLCanvasElement>('#ed-crop-canvas'), {
    size: 512,
    mimeType: 'image/png',
  });
  cropFile = file;
  try {
    await cropper.loadFile(file);
  } catch {
    closeCrop();
    setError('avatarUrl', 'COULD NOT READ THAT IMAGE');
    return;
  }
  const zoom = must<HTMLInputElement>('#ed-crop-zoom');
  zoom.value = '100';
  setAvatarStatus('DRAG TO POSITION ' + DOT + ' ZOOM TO FIT');
  refreshScrim('#editScrim');
}

async function persistAvatar(blob: Blob, filename: string, onSaved: () => void): Promise<void> {
  if (api.mode !== 'live') {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    paintEditAvatar();
    setAvatarStatus('PREVIEW ONLY ' + DOT + ' LIVE MODE UPLOADS TO IPFS');
    return;
  }
  uploading = true;
  const btn = $<HTMLButtonElement>('#ed-upload');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'UPLOADING…';
  }
  setAvatarStatus('UPLOADING TO IPFS…');
  try {
    const file = new File([blob], filename, { type: blob.type || 'image/png' });
    const res = await uploadAvatar(WALLET.net, file);
    USER.avatarUrl = res.avatarUrl;
    rememberIdentity(WALLET.full, { username: USER.name ?? null, avatarUrl: res.avatarUrl });
    saveUser();
    invalidateProfile(WALLET.full);
    setAvatarStatus('SAVED ' + DOT + ' SHOWN EVERYWHERE YOUR WALLET APPEARS');
    toast('AVATAR SAVED');
    onSaved();
  } catch (err) {
    const msg =
      err instanceof SocialApiError
        ? err.code === 'rate_limited'
          ? 'TOO MANY UPLOADS ' + DOT + ' WAIT AND RETRY'
          : err.code === 'not_configured'
            ? 'IMAGE UPLOADS ARE OFF ON THIS ENV'
            : err.message
        : 'AVATAR UPLOAD FAILED';
    setError('avatarUrl', msg);
    setAvatarStatus('');
  } finally {
    uploading = false;
    const b = $<HTMLButtonElement>('#ed-upload');
    if (b) {
      b.disabled = false;
      b.textContent = USER.avatarUrl ? 'REPLACE PFP' : 'UPLOAD PFP';
    }
    paintEditAvatar();
    if (isEditOpen()) fill();
  }
}

async function handleAvatarFile(file: File, onSaved: () => void): Promise<void> {
  setError('avatarUrl', null);
  const problem = checkImageFile(file);
  if (problem) {
    setError('avatarUrl', problem);
    return;
  }
  let size: { w: number; h: number };
  try {
    size = await imageNaturalSize(file);
  } catch {
    setError('avatarUrl', 'COULD NOT READ THAT IMAGE ' + DOT + ' TRY ANOTHER FILE');
    return;
  }
  if (isSquareAspect(size.w, size.h)) {
    await persistAvatar(file, file.name || 'avatar.png', onSaved);
    return;
  }
  await openCrop(file);
}

async function removeAvatar(onSaved: () => void): Promise<void> {
  if (api.mode === 'live') {
    try {
      await patchMyProfile(WALLET.net, { avatarUrl: '' });
    } catch (err) {
      setError('avatarUrl', err instanceof SocialApiError ? err.message : 'COULD NOT REMOVE');
      return;
    }
  }
  delete USER.avatarUrl;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  rememberIdentity(WALLET.full, { username: USER.name ?? null, avatarUrl: null });
  saveUser();
  invalidateProfile(WALLET.full);
  toast('AVATAR REMOVED');
  fill();
  onSaved();
}

/* ---------------------------------- save ---------------------------------- */

async function save(onSaved: () => void): Promise<void> {
  if (saving) return;
  clearErrors();
  const d = readDraft();
  draft = d;
  const checks: Array<[Field, Check]> = [
    ['username', checkUsernameLocal(d.username)],
    ['website', checkWebsiteLocal(d.website)],
    ['xHandle', checkXLocal(d.xHandle)],
    ['telegram', checkTelegramLocal(d.telegram)],
  ];
  let bad = false;
  for (const [field, c] of checks) {
    if (!c.ok) {
      setError(field, c.error);
      bad = true;
    }
  }
  if (bad) return;
  const username = (checks[0]?.[1] as { value: string }).value;
  const website = (checks[1]?.[1] as { value: string }).value;
  const xHandle = (checks[2]?.[1] as { value: string }).value;
  const telegram = (checks[3]?.[1] as { value: string }).value;
  const bio = d.bio.trim();

  const apply = (p: {
    username: string | null;
    bio: string | null;
    website: string | null;
    xHandle: string | null;
    telegram: string | null;
    private: boolean;
  }): void => {
    if (p.username) USER.name = p.username;
    else delete USER.name;
    if (p.bio) USER.bio = p.bio;
    else delete USER.bio;
    if (p.website) USER.website = p.website;
    else delete USER.website;
    if (p.xHandle) USER.xHandle = p.xHandle;
    else delete USER.xHandle;
    if (p.telegram) USER.telegram = p.telegram;
    else delete USER.telegram;
    if (p.private) USER.private = true;
    else delete USER.private;
    rememberIdentity(WALLET.full, { username: p.username, avatarUrl: USER.avatarUrl ?? null });
    saveUser();
    invalidateProfile(WALLET.full);
  };

  if (api.mode !== 'live') {
    apply({
      username: username || null,
      bio: bio || null,
      website: website || null,
      xHandle: xHandle || null,
      telegram: telegram || null,
      private: d.private,
    });
    closeEdit();
    toast('PROFILE SAVED');
    onSaved();
    return;
  }

  saving = true;
  const btn = $<HTMLButtonElement>('#ed-save');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'SAVING…';
  }
  try {
    const res = await patchMyProfile(WALLET.net, {
      username,
      bio,
      website,
      xHandle,
      telegram,
      private: d.private,
    });
    // The server's canonical values (https:// prefix, t.me/ link, folded handle).
    apply({
      username: res.profile.username,
      bio: res.profile.bio,
      website: res.profile.website,
      xHandle: res.profile.xHandle,
      telegram: res.profile.telegram,
      private: !!res.profile.private,
    });
    closeEdit();
    toast(d.private ? 'PROFILE SAVED ' + DOT + ' PRIVATE' : 'PROFILE SAVED');
    onSaved();
  } catch (err) {
    if (err instanceof ProfileFieldError) {
      setError(err.field, err.message);
    } else {
      toast(err instanceof SocialApiError ? err.message : 'PROFILE SYNC FAILED', 'red');
    }
  } finally {
    saving = false;
    const b = $<HTMLButtonElement>('#ed-save');
    if (b) {
      b.disabled = false;
      b.textContent = 'SAVE PROFILE';
    }
  }
}

async function signOutEverywhere(): Promise<void> {
  if (!signoutArmed) {
    signoutArmed = true;
    const b = $('#ed-signout');
    if (b) b.textContent = 'CONFIRM SIGN OUT EVERYWHERE?';
    window.setTimeout(() => {
      signoutArmed = false;
      const bb = $('#ed-signout');
      if (bb) bb.textContent = 'SIGN OUT EVERYWHERE';
    }, 6000);
    return;
  }
  signoutArmed = false;
  try {
    const res = await revokeOtherSessions(WALLET.net);
    toast(
      res.revoked > 0
        ? 'SIGNED OUT ' + res.revoked + ' OTHER DEVICE' + (res.revoked === 1 ? '' : 'S')
        : 'NO OTHER DEVICES WERE SIGNED IN',
    );
  } catch (err) {
    toast(err instanceof SocialApiError ? err.message : 'SIGN OUT FAILED', 'red');
  }
  const b = $('#ed-signout');
  if (b) b.textContent = 'SIGN OUT EVERYWHERE';
}

/* --------------------------------- public --------------------------------- */

export function openEdit(opener?: Element | null): void {
  draft = draftFromUser();
  uploading = false;
  saving = false;
  signoutArmed = false;
  fill();
  openScrim('#editScrim', opener);
}

export function closeEdit(): void {
  closeCrop();
  closeScrim('#editScrim');
}

export function isEditOpen(): boolean {
  return isOpen('#editScrim');
}

export function initEdit(onSaved: () => void): void {
  wireBackdrop('#editScrim', closeEdit);
  const form = must<HTMLFormElement>('#editForm');

  form.addEventListener('click', (e) => {
    const t = e.target as Element | null;
    if (!t) return;
    if (t.closest('#ed-upload')) {
      $<HTMLInputElement>('#ed-file')?.click();
      return;
    }
    if (t.closest('#ed-remove')) {
      void removeAvatar(onSaved);
      return;
    }
    if (t.closest('#ed-crop-cancel')) {
      closeCrop();
      setAvatarStatus('');
      return;
    }
    if (t.closest('#ed-crop-apply')) {
      if (!cropper) return;
      const c = cropper;
      const name = cropFile?.name || 'avatar.png';
      const applyBtn = must<HTMLButtonElement>('#ed-crop-apply');
      applyBtn.disabled = true;
      void (async () => {
        try {
          const { blob } = await c.export();
          closeCrop();
          await persistAvatar(blob, name, onSaved);
        } catch {
          setError('avatarUrl', 'CROP FAILED ' + DOT + ' TRY ANOTHER IMAGE');
        } finally {
          applyBtn.disabled = false;
        }
      })();
      return;
    }
    const priv = t.closest<HTMLElement>('[data-priv]');
    if (priv) {
      draft = { ...readDraft(), private: priv.dataset['priv'] === '1' };
      for (const b of form.querySelectorAll<HTMLElement>('[data-priv]'))
        b.classList.toggle('on', b.dataset['priv'] === (draft.private ? '1' : '0'));
      const copy = $('#ed-priv-copy');
      if (copy)
        copy.textContent = draft.private
          ? 'ONLY YOU CAN SEE YOUR HOLDINGS, PNL, RECENT ACTIVITY, WALL AND FRIENDS. YOUR USERNAME, PICTURE, BIO, LINKS AND THE COINS YOU LAUNCHED STAY PUBLIC — CREATOR ATTRIBUTION IS ON CHAIN.'
          : 'ANYONE CAN SEE YOUR HOLDINGS, PNL, RECENT ACTIVITY, WALL AND FRIENDS. SWITCH TO PRIVATE TO KEEP THEM TO YOURSELF.';
      return;
    }
    if (t.closest('#ed-signout')) {
      void signOutEverywhere();
    }
  });

  form.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement | null;
    if (!input || input.id !== 'ed-file') return;
    const file = input.files?.[0];
    input.value = '';
    if (file) void handleAvatarFile(file, onSaved);
  });

  form.addEventListener('input', (e) => {
    const el = e.target as HTMLElement | null;
    if (!el) return;
    if (el.id === 'ed-crop-zoom' && cropper) {
      cropper.setRelativeZoom(Number((el as HTMLInputElement).value) / 100);
      return;
    }
    if (el.id === 'ed-bio') {
      const cnt = form.querySelector<HTMLElement>('[data-cnt="bio"]');
      if (cnt) cnt.textContent = `${(el as HTMLTextAreaElement).value.length}/${BIO_MAX}`;
    }
    // Typing clears that field's error.
    const row = el.closest<HTMLElement>('[data-field]');
    const key = row?.dataset['field'] as Field | undefined;
    if (key) setError(key, null);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void save(onSaved);
  });
}
