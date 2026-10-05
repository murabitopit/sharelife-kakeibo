// 同棲スペースの端末間リアルタイム同期(Firebase Firestore)。
//
// 設計方針:
// - 同期するのは「同棲」空間(categories/months/reserve/unresolvedBackfills)と
//   負担割合(ratioSelf)だけ。🧑自分・👩彼女それぞれの個人空間は各端末のlocalStorageに
//   閉じたままで同期しない(ロック画面の意味を保つため。詳しくはlock.js参照)。
// - 2人だけが知るペアリングコードをFirestoreのドキュメントIDとして使う、簡易的な仕組み。
//   本格的なログイン機能は持たないため、匿名認証(Authentication>Sign-in method>匿名)を
//   有効にした上で「ログイン済みなら読み書き可」という緩いルールを使う想定(js/firebase-config.js参照)。
//   → コードさえ知っていれば誰でも読み書きできてしまうので、コードは他人に教えないこと。
// - js/firebase-config.js が未設定(プレースホルダのまま)の場合は全てno-opになり、
//   今まで通り1台のみでの利用に一切影響しない。

const SYNC_PUSH_DEBOUNCE_MS = 600;
const DEVICE_ID_KEY = 'kakeibo_device_id';

let fbApp = null;
let fbDb = null;
let authReadyPromise = null;
let unsubscribeFn = null;
let pushTimer = null;
let currentCode = null;
let currentOnRemoteUpdate = null;

function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch (e) {
    return 'unknown-device';
  }
}

function configured() {
  const c = window.FIREBASE_CONFIG;
  return !!(c && c.apiKey && c.apiKey !== 'YOUR_API_KEY');
}

function available() {
  return configured() && !!window.firebase;
}

function ensureApp() {
  if (!available()) return null;
  if (!fbApp) {
    fbApp = firebase.initializeApp(window.FIREBASE_CONFIG);
    fbDb = firebase.firestore();
  }
  return fbApp;
}

function ensureAuth() {
  if (!ensureApp()) return Promise.resolve(false);
  if (!authReadyPromise) {
    authReadyPromise = firebase.auth().signInAnonymously()
      .then(() => true)
      .catch((err) => { console.error('同期用の匿名サインインに失敗', err); return false; });
  }
  return authReadyPromise;
}

function makeCode() {
  const seg = () => Math.random().toString(36).slice(2, 6);
  return `${seg()}-${seg()}`;
}

// 新しい同棲グループを作成し、今の端末が持っている「同棲」空間の内容をアップロードする。
// 戻り値: 生成されたペアリングコード(相手に伝えて参加してもらう)
async function createHousehold(data, onRemoteUpdate) {
  const ok = await ensureAuth();
  if (!ok) throw new Error('Firebaseへの接続に失敗しました');
  const code = makeCode();
  await fbDb.collection('households').doc(code).set({
    shared: data.spaces.shared,
    ratioSelf: data.settings.ratioSelf,
    updatedBy: getDeviceId(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  data.settings.sync.code = code;
  subscribe(data, code, onRemoteUpdate);
  return code;
}

// 既存のペアリングコードに参加する。相手が作った内容で自分の「同棲」空間を上書きする。
async function joinHousehold(data, code, onRemoteUpdate) {
  const ok = await ensureAuth();
  if (!ok) throw new Error('Firebaseへの接続に失敗しました');
  const snap = await fbDb.collection('households').doc(code).get();
  if (!snap.exists) throw new Error('そのコードの同棲グループが見つかりませんでした');
  const remote = snap.data();
  data.spaces.shared = remote.shared;
  data.settings.ratioSelf = remote.ratioSelf;
  data.settings.sync.code = code;
  subscribe(data, code, onRemoteUpdate);
}

// 既に参加済みのコードがある状態でアプリを開いた時、購読を再開する
function resume(data, onRemoteUpdate) {
  const code = data.settings.sync && data.settings.sync.code;
  if (!code || !available()) return;
  ensureAuth().then((ok) => { if (ok) subscribe(data, code, onRemoteUpdate); });
}

function subscribe(data, code, onRemoteUpdate) {
  if (unsubscribeFn) { unsubscribeFn(); unsubscribeFn = null; }
  currentCode = code;
  currentOnRemoteUpdate = onRemoteUpdate;
  unsubscribeFn = fbDb.collection('households').doc(code).onSnapshot((snap) => {
    if (!snap.exists) return;
    const remote = snap.data();
    if (remote.updatedBy === getDeviceId()) return; // 自分自身の書き込みのechoは無視
    data.spaces.shared = remote.shared;
    data.settings.ratioSelf = remote.ratioSelf;
    if (currentOnRemoteUpdate) currentOnRemoteUpdate();
  }, (err) => {
    console.error('同期の購読でエラー', err);
  });
}

// 同棲空間に変更があった際に呼ぶ(main.jsのpersist()から毎回呼んでOK。
// 参加していない/未設定の場合は何もしない。短時間の連続呼び出しはまとめて1回だけ送信する)
function push(data) {
  const code = data.settings.sync && data.settings.sync.code;
  if (!code || !available()) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    ensureAuth().then((ok) => {
      if (!ok) return;
      fbDb.collection('households').doc(code).set({
        shared: data.spaces.shared,
        ratioSelf: data.settings.ratioSelf,
        updatedBy: getDeviceId(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }).catch((err) => console.error('同期への書き込みに失敗', err));
    });
  }, SYNC_PUSH_DEBOUNCE_MS);
}

// 同期をやめる(ローカルの同棲データはそのまま残す。コードを知っていればいつでも再参加できる)
function leaveHousehold(data) {
  if (unsubscribeFn) { unsubscribeFn(); unsubscribeFn = null; }
  data.settings.sync.code = null;
}

window.Sync = {
  available,
  createHousehold,
  joinHousehold,
  resume,
  push,
  leaveHousehold,
};
