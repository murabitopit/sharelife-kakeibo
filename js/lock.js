// 端末ロック(PINコード / Face ID・指紋)。
// これは「同じ端末を2人で共有していて、相手のタブをうっかり/気軽に見られたくない」場合の
// 簡易的なのぞき見防止であり、暗号学的な安全性は無い(サーバー側での検証が存在しないPWAのため、
// 開発者ツール等でlocalStorageを直接見られた場合までは防げない)。

const DEVICE_OWNER_KEY = 'kakeibo_device_owner'; // この端末が誰のものかは端末ごとのローカル設定(データ本体とは別管理)

function getDeviceOwner() {
  try { return localStorage.getItem(DEVICE_OWNER_KEY); } catch (e) { return null; }
}
function setDeviceOwner(value) {
  try {
    if (value) localStorage.setItem(DEVICE_OWNER_KEY, value);
    else localStorage.removeItem(DEVICE_OWNER_KEY);
  } catch (e) { /* no-op */ }
}

async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(byteLen) {
  const arr = new Uint8Array(byteLen);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}
function b64encode(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b64decode(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

function ensureLockSettings(data) {
  if (!data.settings.lock) data.settings.lock = { personal: null, partner: null };
  return data.settings.lock;
}

function hasPin(data, spaceKey) {
  const cfg = data.settings.lock && data.settings.lock[spaceKey];
  return !!(cfg && cfg.hashHex);
}
function hasWebauthn(data, spaceKey) {
  const cfg = data.settings.lock && data.settings.lock[spaceKey];
  return !!(cfg && cfg.webauthnCredId);
}
function hasAnyLock(data, spaceKey) {
  return hasPin(data, spaceKey) || hasWebauthn(data, spaceKey);
}

async function setPin(data, spaceKey, pin) {
  const lock = ensureLockSettings(data);
  const saltHex = randomHex(16);
  const hashHex = await sha256Hex(saltHex + ':' + pin);
  lock[spaceKey] = { ...(lock[spaceKey] || {}), saltHex, hashHex };
}
async function verifyPin(data, spaceKey, pin) {
  const cfg = data.settings.lock && data.settings.lock[spaceKey];
  if (!cfg || !cfg.hashHex) return false;
  const hashHex = await sha256Hex(cfg.saltHex + ':' + pin);
  return hashHex === cfg.hashHex;
}
function clearLock(data, spaceKey) {
  ensureLockSettings(data);
  data.settings.lock[spaceKey] = null;
}

function webauthnAvailable() {
  return !!(window.PublicKeyCredential && navigator.credentials);
}

// Face ID/指紋などプラットフォーム認証器をこの端末にこの空間用として登録する。
// 公開鍵は保存するがサーバーが無いため署名検証はできない。get()が成功すること自体
// (=端末のOSが生体認証/端末パスコードを突破できた)を「解除できた」とみなす簡易的な仕組み。
async function registerWebauthn(data, spaceKey, label) {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: '資産管理アプリ' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: label, displayName: label },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
      timeout: 60000,
    },
  });
  if (!cred) throw new Error('登録に失敗しました');
  const lock = ensureLockSettings(data);
  lock[spaceKey] = { ...(lock[spaceKey] || {}), webauthnCredId: b64encode(cred.rawId) };
}

async function tryWebauthnUnlock(data, spaceKey) {
  const cfg = data.settings.lock && data.settings.lock[spaceKey];
  if (!cfg || !cfg.webauthnCredId) return false;
  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: b64decode(cfg.webauthnCredId) }],
        userVerification: 'required',
        timeout: 60000,
      },
    });
    return !!assertion;
  } catch (e) {
    return false;
  }
}

// 同棲タブは常にロック対象外。個人タブ(自分/彼女)は、ロック設定済み・この端末がその人の端末として
// 記憶されていない・まだ今回のセッションで解除していない、の3条件がそろった時だけロックされる。
function isSpaceLocked(data, spaceKey, sessionUnlocked) {
  if (spaceKey === 'shared') return false;
  if (!hasAnyLock(data, spaceKey)) return false;
  if (getDeviceOwner() === spaceKey) return false;
  if (sessionUnlocked && sessionUnlocked.has(spaceKey)) return false;
  return true;
}

function lockScreenHtml(spaceKey, data) {
  const label = Store.spaceLabel(data, spaceKey);
  const webauthnOn = hasWebauthn(data, spaceKey);
  return `
    <div class="lock-box">
      <div class="lock-icon">🔒</div>
      <h2>${label}はロックされています</h2>
      ${webauthnOn ? `<button class="btn" id="lockWebauthnBtn">Face ID / 指紋で解除</button>` : ''}
      <div class="field" style="margin-top:14px">
        <label>PINコード</label>
        <input type="password" inputmode="numeric" pattern="[0-9]*" id="lockPinInput" maxlength="8" autocomplete="off" />
      </div>
      <div class="hint" id="lockError" style="color:var(--over); min-height:16px"></div>
      <button class="btn" id="lockPinSubmit">解除する</button>
      <button class="btn secondary" id="lockCancelBtn" style="margin-top:8px">キャンセル</button>
    </div>
  `;
}

function lockSettingsHtml(data, spaceKey) {
  const label = Store.spaceLabel(data, spaceKey);
  const owner = getDeviceOwner();
  const pinOn = hasPin(data, spaceKey);
  const webauthnOn = hasWebauthn(data, spaceKey);
  return `
    <h3 style="margin-top:20px">画面ロック(${label})</h3>
    <p class="hint">この端末を2人で共有している場合に、${label}のタブを気軽に見られないようにします。開発者ツール等までは防げない簡易的なものです。</p>
    <div class="settings-list">
      <div class="item">
        <span class="name-cell">PINコード</span>
        <span class="item-controls" style="display:flex;gap:6px">
          <button class="btn secondary" id="lockSetPin" data-space="${spaceKey}">${pinOn ? '変更' : '設定'}</button>
          ${pinOn ? `<button class="btn danger" id="lockClear" data-space="${spaceKey}">解除</button>` : ''}
        </span>
      </div>
      ${webauthnAvailable() ? `
      <div class="item">
        <span class="name-cell">Face ID / 指紋</span>
        <span class="item-controls">
          <button class="btn secondary" id="lockSetWebauthn" data-space="${spaceKey}" ${pinOn ? '' : 'disabled'}>${webauthnOn ? '再登録' : '登録'}</button>
        </span>
      </div>
      ${!pinOn ? '<div class="hint">先にPINコードを設定すると登録できます(生体認証が使えない時の控えとして必要です)</div>' : ''}
      ` : ''}
      <div class="item">
        <span class="name-cell">この端末を${label}の端末として記憶(パスワード省略)</span>
        <span class="item-controls">
          <input type="checkbox" id="lockDeviceOwner" data-space="${spaceKey}" ${owner === spaceKey ? 'checked' : ''} />
        </span>
      </div>
    </div>
  `;
}

window.Lock = {
  getDeviceOwner, setDeviceOwner,
  hasPin, hasWebauthn, hasAnyLock, webauthnAvailable,
  setPin, verifyPin, clearLock,
  registerWebauthn, tryWebauthnUnlock,
  isSpaceLocked, lockScreenHtml, lockSettingsHtml,
};
