let data = Store.init();
let spaceKey = 'personal';
let activeTab = 'budget'; // 'budget' | 'calendar' | 'assets' | 'settings'
let expanded = {}; // グループカテゴリの開閉状態(catId -> bool)
let settingsSubTab = 'budget'; // 'budget' | 'dev'
let calendarViewKey = null; // 収支履歴タブで表示中の月(nullなら現在の月)
let assetExpanded = { carried: true, remaining: true }; // 資産タブの内訳の開閉状態
let editingTxId = null; // 収支履歴から編集中の取引ID
let pieSelected = {}; // 円グラフでタップ中の項目名(chartId -> name)。'budget'/'carried'/'remaining'

// 画面ロック関連
let sessionUnlocked = new Set(); // このページ読み込み中に解除済みの空間('personal'/'partner')。リロードでリセット
let pendingSpaceKey = null; // ロック画面を解除した後に切り替える予定の空間

// 収支記録シートのウィザード状態
let quickAddTree = 'own'; // 'own'(現在のタブの自分のカテゴリ) | 'sharedfund'(個人タブから同棲資金へ寄り道)
let quickAddParentId = null; // 子カテゴリ選択中の親。'__other__'は固定引き落とし一覧
let pendingCatId = null; // 最終的に選択したカテゴリ
let amountDigits = ''; // 電卓キーパッドで入力中の金額(文字列)
let txType = 'expense'; // 'expense' | 'income' (個人側のみ切替可)
let txPayer = 'self'; // 'self' | 'partner' (同棲資金の項目のみ使用)

// 連打(同じボタンへの重複クリックイベント)による二重登録を防ぐためのガード。
// 保存/削除系のボタンがクリックされた瞬間、そのDOM要素自体にフラグを立てる。
// 再描画されると要素ごと作り直されるため、別の操作(別ボタン・再描画後の同じボタン)は
// ブロックされない。同じ要素に短時間で2回イベントが届いた場合だけ2回目をブロックする。
function guardOnce(target) {
  if (target.dataset.firing === '1') return true;
  target.dataset.firing = '1';
  return false;
}

const el = {
  tabs: document.getElementById('spaceTabs'),
  monthLabel: document.getElementById('monthLabel'),
  tabContent: document.getElementById('tabContent'),
  addBtn: document.getElementById('addBtn'),
  bottomTabs: document.getElementById('bottomTabs'),
  sheetOverlay: document.getElementById('sheetOverlay'),
  sheet: document.getElementById('sheet'),
  lockOverlay: document.getElementById('lockOverlay'),
  lockContent: document.getElementById('lockContent'),
};

function space() { return data.spaces[spaceKey]; }
function key() { return space().currentMonth; }

function persist() { Store.save(data); Sync.push(data); }

// 同期先(Firebase)で相手の端末が同棲空間を更新した時に呼ばれる
function onRemoteSharedUpdate() {
  Store.save(data);
  renderApp();
}

// 'personal'(🧑自分)・'partner'(👩彼女)それぞれの同棲資金負担分を返す。同棲タブではnull。
function sharedFundSummary() {
  if (spaceKey === 'shared') return null;
  const share = spaceKey === 'partner' ? Store.partnerSharedShare(data) : Store.personalSharedShare(data);
  return { budget: share, spent: share };
}

// レポートが「自分」として扱う空間key。この端末の持ち主(Lock.getDeviceOwner)が優先、
// 未設定なら現在開いているタブで判断する。相方の個人空間は常に除外する(ロックの意味を保つため)。
function reportOwnKey() {
  const owner = Lock.getDeviceOwner();
  if (owner === 'personal' || owner === 'partner') return owner;
  return spaceKey === 'partner' ? 'partner' : 'personal';
}

function renderApp() {
  el.tabs.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.space === spaceKey));
  el.tabs.querySelectorAll('.tab').forEach(b => {
    if (b.dataset.space === 'personal' || b.dataset.space === 'partner') {
      b.textContent = Store.spaceLabel(data, b.dataset.space);
    }
  });
  el.bottomTabs.querySelectorAll('.bottom-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === activeTab));
  el.monthLabel.textContent = `${key()} ${spaceKey === 'shared' ? '(共有)' : '(自分のみ閲覧可)'}`;
  el.addBtn.hidden = (activeTab === 'assets' || activeTab === 'settings' || activeTab === 'report');

  if (activeTab === 'budget') {
    const sf = sharedFundSummary();
    el.tabContent.innerHTML = UI.budgetTabHtml(space(), key(), expanded, sf, pieSelected);
  } else if (activeTab === 'calendar') {
    const vk = calendarViewKey || key();
    const lookup = (catId) => space().categories.find(c => c.id === catId);
    el.tabContent.innerHTML = UI.calendarTabHtml(space(), vk, lookup);
  } else if (activeTab === 'assets') {
    el.tabContent.innerHTML = UI.assetsHtml(space(), key(), data, assetExpanded, pieSelected);
  } else if (activeTab === 'report') {
    el.tabContent.innerHTML = Report.reportTabHtml(data, reportOwnKey());
  } else {
    el.tabContent.innerHTML = settingsTabHtml();
  }
}

function openSheet(html) {
  el.sheet.innerHTML = html;
  el.sheetOverlay.classList.add('open');
}
function closeSheet() {
  el.sheetOverlay.classList.remove('open');
  quickAddTree = 'own';
  pendingCatId = null;
  quickAddParentId = null;
  amountDigits = '';
  txType = 'expense';
  txPayer = 'self';
  editingTxId = null;
}
// 画面ロック:呼べる空間('personal'/'partner')への切り替えをロック経由にする。
// ロック不要ならそのまま切り替え、ロックが必要ならロック画面を出して結果を待つ。
function requestSpace(target) {
  if (Lock.isSpaceLocked(data, target, sessionUnlocked)) {
    pendingSpaceKey = target;
    openLockScreen(target);
    return;
  }
  spaceKey = target;
  calendarViewKey = null;
  renderApp();
}

function openLockScreen(targetSpaceKey) {
  el.lockContent.innerHTML = Lock.lockScreenHtml(targetSpaceKey, data);
  el.lockOverlay.classList.add('open');
  if (Lock.hasWebauthn(data, targetSpaceKey)) {
    Lock.tryWebauthnUnlock(data, targetSpaceKey).then(ok => {
      if (ok && pendingSpaceKey === targetSpaceKey) completeUnlock(targetSpaceKey);
    });
  }
}
function closeLockScreen() {
  el.lockOverlay.classList.remove('open');
  pendingSpaceKey = null;
}
function completeUnlock(targetSpaceKey) {
  sessionUnlocked.add(targetSpaceKey);
  closeLockScreen();
  spaceKey = targetSpaceKey;
  calendarViewKey = null;
  renderApp();
}
function showLockError(msg) {
  const box = document.getElementById('lockError');
  if (box) box.textContent = msg;
}

function updateAllocationBox() {
  const box = document.getElementById('allocationBox');
  if (box) box.innerHTML = allocationBoxHtml(space());
}

// --- 収支を記録(親→子カテゴリ選択 → 電卓キーパッドで金額入力) ---

function quickAddHtml() {
  const isPersonalType = spaceKey !== 'shared';
  const isIncomeStep = isPersonalType && txType === 'income';

  if (pendingCatId || isIncomeStep) {
    const today = new Date().toISOString().slice(0, 10);
    let catRow = '';
    let belongsToShared = false;
    if (pendingCatId) {
      belongsToShared = data.spaces.shared.categories.some(c => c.id === pendingCatId);
      const cat = (belongsToShared ? data.spaces.shared : space()).categories.find(c => c.id === pendingCatId);
      catRow = `
        <div class="field">
          <label>カテゴリ</label>
          <div class="cat-picker"><div class="opt parent selected"><span>${UI.iconFor(cat)} ${cat.name}</span><button class="mini-link" data-changecat="1">変更</button></div></div>
        </div>
      `;
    }
    const payerRow = (pendingCatId && (spaceKey === 'shared' || belongsToShared)) ? UI.payerToggleHtml(txPayer) : '';
    return `
      <h2>収支を記録</h2>
      ${isPersonalType ? UI.typeToggleHtml(txType) : ''}
      ${catRow}
      ${payerRow}
      ${UI.keypadHtml(amountDigits)}
      <div class="field"><label>メモ(任意)</label><input type="text" id="txMemo" /></div>
      <div class="field"><label>日付</label><input type="date" id="txDate" value="${today}" /></div>
      <button class="btn" id="txSave">保存</button>
      <button class="btn secondary" id="txCancel">キャンセル</button>
    `;
  }

  if (quickAddParentId === '__other__') {
    const vs = quickAddTree === 'sharedfund' ? data.spaces.shared : space();
    return `
      <h2>収支を記録</h2>
      ${isPersonalType ? UI.typeToggleHtml(txType) : ''}
      <div class="field"><label>カテゴリを選択</label>${UI.catPickerOtherHtml(vs.categories.filter(c => c.auto))}</div>
      <button class="btn secondary" id="txCancel">キャンセル</button>
    `;
  }

  if (quickAddParentId) {
    const vs = quickAddTree === 'sharedfund' ? data.spaces.shared : space();
    return `
      <h2>収支を記録</h2>
      ${isPersonalType ? UI.typeToggleHtml(txType) : ''}
      <div class="field"><label>カテゴリを選択</label>${UI.catPickerChildHtml(vs, quickAddParentId)}</div>
      <button class="btn secondary" id="txCancel">キャンセル</button>
    `;
  }

  const vs = quickAddTree === 'sharedfund' ? data.spaces.shared : space();
  const opts = {
    backRow: quickAddTree !== 'own',
    showSharedFundLink: quickAddTree === 'own' && isPersonalType,
    otherLeaves: vs.categories.filter(c => c.auto),
  };
  return `
    <h2>収支を記録</h2>
    ${isPersonalType ? UI.typeToggleHtml(txType) : ''}
    <div class="field"><label>カテゴリを選択</label>${UI.catPickerTopHtml(vs, opts)}</div>
    <button class="btn secondary" id="txCancel">キャンセル</button>
  `;
}

function detailHtml(catId) {
  const cat = space().categories.find(c => c.id === catId);
  const month = space().months[key()];
  const txs = month.transactions.filter(t => t.catId === catId).slice().reverse();
  const today = new Date().toISOString().slice(0, 10);
  let txHtml = txs.map(t => {
    const payerTag = t.payer ? (t.payer === 'self' ? '🧑' + Store.spaceName(data, 'personal') : '👩' + Store.spaceName(data, 'partner')) : '';
    return `
      <div class="tx-item">
        <span>${t.date} ${t.memo ? '・' + t.memo : ''} ${payerTag ? '・' + payerTag : ''}</span>
        <span>${UI.yen(t.amount)} <button class="del" data-tx="${t.id}">削除</button></span>
      </div>
    `;
  }).join('') || '<div class="tx-item">まだ記録がありません</div>';

  if (cat.auto) {
    return `
      <h2 data-cat="${catId}">${UI.iconFor(cat)} ${cat.name} ${UI.autoBadgeHtml(cat)}</h2>
      <p class="hint">毎月決まった金額が自動で引き落とされる項目です。支払いの記録は不要です(予算=支出として自動計算されます)。</p>
      <div class="field"><label>月の予算(引き落とし額)</label><div class="readout" style="padding:10px 0;text-align:left;font-weight:700">${UI.yen(cat.budget)}</div></div>
      <button class="btn secondary" id="txCancel" style="margin-top:16px">閉じる</button>
    `;
  }

  const payerRow = spaceKey === 'shared' ? UI.payerToggleHtml(txPayer) : '';
  return `
    <h2 data-cat="${catId}">${UI.iconFor(cat)} ${cat.name}</h2>
    <div class="field"><label>月の予算</label><div class="readout" style="padding:10px 0;text-align:left;font-weight:700">${UI.yen(cat.budget)}</div></div>
    <h3>支出</h3>
    ${payerRow}
    ${UI.keypadHtml(amountDigits)}
    <div class="field"><label>メモ(任意)</label><input type="text" id="txMemo" /></div>
    <div class="field"><label>日付</label><input type="date" id="txDate" value="${today}" /></div>
    <button class="btn" id="txSaveDetail" data-cat="${catId}">追加する</button>
    <h3>今月の記録</h3>
    ${txHtml}
    <button class="btn secondary" id="txCancel" style="margin-top:16px">閉じる</button>
  `;
}

function addTransaction(targetSpace, catId, amount, memo, date, extra) {
  const tx = { id: Store.uid(), catId, amount, memo, date, type: 'expense', ...extra };
  targetSpace.months[targetSpace.currentMonth].transactions.push(tx);
  persist();
}

function escapeAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 収支履歴タブから取引を編集するシート(カテゴリ変更は不可。金額/メモ/日付/支払者のみ)
function editTxSheetHtml(sp, tx) {
  const cat = tx.catId ? sp.categories.find(c => c.id === tx.catId) : null;
  const label = tx.type === 'income' ? '💰 収入' : (cat ? `${UI.iconFor(cat)} ${cat.name}` : '(削除された項目)');
  const payerRow = tx.payer ? UI.payerToggleHtml(txPayer) : '';
  return `
    <h2>記録を編集</h2>
    <div class="field"><label>カテゴリ</label><div class="readout" style="padding:10px 0">${label}</div></div>
    ${payerRow}
    ${UI.keypadHtml(amountDigits)}
    <div class="field"><label>メモ(任意)</label><input type="text" id="txMemo" value="${escapeAttr(tx.memo)}" /></div>
    <div class="field"><label>日付</label><input type="date" id="txDate" value="${tx.date}" /></div>
    <button class="btn" id="txEditSave">保存</button>
    <button class="btn danger" id="txEditDelete">削除</button>
    <button class="btn secondary" id="txCancel">キャンセル</button>
  `;
}

function editTotalSheetHtml() {
  const total = Store.totalAssets(space());
  return `
    <h2>現在の合計金額を修正</h2>
    <div class="field"><label>新しい合計金額</label><input type="number" id="newTotal" value="${Math.round(total)}" /></div>
    <button class="btn" id="saveTotalBtn">保存</button>
    <button class="btn secondary" id="txCancel">キャンセル</button>
  `;
}

function setPinSheetHtml(spaceKey_) {
  const label = Store.spaceLabel(data, spaceKey_);
  return `
    <h2>${label}のPINコードを設定</h2>
    <div class="field"><label>新しいPIN(4〜8桁の数字)</label><input type="password" inputmode="numeric" pattern="[0-9]*" id="newPin1" maxlength="8" /></div>
    <div class="field"><label>確認のため、もう一度</label><input type="password" inputmode="numeric" pattern="[0-9]*" id="newPin2" maxlength="8" /></div>
    <div class="hint" id="setPinError" style="color:var(--over); min-height:16px"></div>
    <button class="btn" id="setPinSave" data-space="${spaceKey_}">保存</button>
    <button class="btn secondary" id="txCancel">キャンセル</button>
  `;
}

// --- 設定タブ ---

function allocationBoxHtml(sp) {
  const income = sp.months[key()].income;
  const share = sp === data.spaces.partner ? Store.partnerSharedShare(data) : Store.personalSharedShare(data);
  const allocated = Store.totalLeafBudget(sp) + share;
  const unallocated = income - allocated;
  const targetId = Store.leftoverTargetId(sp);
  const targetCat = sp.categories.find(c => c.id === targetId);
  const targetLabel = targetCat ? targetCat.name : '予備費';
  return `
    <div class="row"><span>今月の収入</span><span>${UI.yen(income)}</span></div>
    <div class="row"><span>カテゴリへの配分合計(同棲資金の負担分込み)</span><span>${UI.yen(allocated)}</span></div>
    <div class="row"><span>未配分(月末に${targetLabel}へ)</span><span class="${unallocated < 0 ? 'over-note' : ''}">${UI.yen(unallocated)}</span></div>
  `;
}

function categoryRowsHtml(sp) {
  return sp.categories.slice().sort((a, b) => a.order - b.order).map(c => {
    const parent = sp.categories.find(p => p.id === c.parentId);
    const indent = parent ? '　└ ' : '';
    if (Store.isGroup(sp, c.id)) {
      const total = Store.children(sp, c.id).reduce((s2, ch) => s2 + (ch.budget || 0), 0);
      return `
        <div class="item">
          <span class="name-cell">${indent}${UI.iconFor(c)} ${c.name}</span>
          <span class="readout" style="font-weight:700;color:var(--text)">${UI.yen(total)}</span>
        </div>
      `;
    }
    return `
      <div class="item">
        <span class="name-cell"><input type="text" class="catIconEdit" data-cat="${c.id}" value="${UI.iconFor(c)}" maxlength="4" style="width:36px;text-align:center;flex-shrink:0" />${indent}${c.name}</span>
        <span class="item-controls" style="display:flex;align-items:center;gap:6px">
          <label class="auto-toggle">固定引き落とし<input type="checkbox" class="catAutoEdit" data-cat="${c.id}" ${c.auto ? 'checked' : ''} /></label>
          <input type="number" class="catBudgetEdit" data-cat="${c.id}" value="${c.budget}" />
        </span>
      </div>
    `;
  }).join('');
}

// readOnly=true: 個人タブ(自分 or 彼女)からの表示専用版。ratioはその人自身の負担割合。
// readOnly=false: 同棲タブからの編集版。自分・彼女両方の負担額を表示する。
function sharedFundRowsHtml(readOnly, ratio) {
  const shared = data.spaces.shared;
  // 旅行積立金は「予算を設定する枠」ではなく余り金の繰越先そのものなので、ここには出さない
  return shared.categories.filter(c => c.name !== '旅行積立金').slice().sort((a, b) => a.order - b.order).map(c => {
    const parent = shared.categories.find(p => p.id === c.parentId);
    const indent = parent ? '　└ ' : '';
    if (Store.isGroup(shared, c.id)) {
      const total = Store.children(shared, c.id).reduce((s, ch) => s + (ch.budget || 0), 0);
      return `
        <div class="item">
          <span class="name-cell">${indent}${UI.iconFor(c)} ${c.name}</span>
          <span class="readout" style="font-weight:700;color:var(--text)">${UI.yen(total)}</span>
        </div>
      `;
    }
    if (readOnly) {
      const selfShare = (c.budget || 0) * (ratio == null ? data.settings.ratioSelf : ratio);
      return `
        <div class="item sf-item">
          <span class="name-cell">${indent}${UI.iconFor(c)} ${c.name}${UI.autoBadgeHtml(c)}</span>
          <span class="sf-amounts">
            <span class="sf-amount"><span class="sf-label">2人分</span><span>${UI.yen(c.budget || 0)}</span></span>
            <span class="sf-amount"><span class="sf-label">自身の負担額</span><span>${UI.yen(selfShare)}</span></span>
          </span>
        </div>
      `;
    }
    const selfShare = (c.budget || 0) * data.settings.ratioSelf;
    const partnerShare = (c.budget || 0) * (1 - data.settings.ratioSelf);
    return `
      <div class="item">
        <span class="name-cell"><input type="text" class="sfIconEdit" data-cat="${c.id}" value="${UI.iconFor(c)}" maxlength="4" style="width:32px;text-align:center;flex-shrink:0" />${indent}${c.name}</span>
        <span class="item-controls" style="display:flex;align-items:center;gap:6px">
          <label class="auto-toggle">固定引き落とし<input type="checkbox" class="sfAutoEdit" data-cat="${c.id}" ${c.auto ? 'checked' : ''} /></label>
          <input type="number" class="sfBudgetEdit" data-cat="${c.id}" value="${c.budget}" style="width:84px" />
          <span class="readout" style="width:68px">🧑${UI.yen(selfShare)}</span>
          <span class="readout" style="width:68px">👩${UI.yen(partnerShare)}</span>
        </span>
      </div>
    `;
  }).join('');
}

function sharedFundTotalsHtml(ratio) {
  const total = Store.totalLeafBudget(data.spaces.shared);
  const selfShare = total * (ratio == null ? data.settings.ratioSelf : ratio);
  return `
    <div class="item sf-item sf-total">
      <span class="name-cell"><b>合計</b></span>
      <span class="sf-amounts">
        <span class="sf-amount"><span class="sf-label">2人分</span><span><b>${UI.yen(total)}</b></span></span>
        <span class="sf-amount"><span class="sf-label">自身の負担額</span><span><b>${UI.yen(selfShare)}</b></span></span>
      </span>
    </div>
  `;
}

// 未解決の貯蓄補填(③: ひとまず現金貯蓄から補填された分)の一覧。配分し直すこともできる。
function unresolvedBackfillsHtml(sp) {
  if (!sp.unresolvedBackfills || sp.unresolvedBackfills.length === 0) return '';
  const rows = sp.unresolvedBackfills.map(bf => {
    const cat = sp.categories.find(c => c.id === bf.catId);
    return `
      <div class="item">
        <span class="name-cell">${cat ? UI.iconFor(cat) + ' ' + cat.name : '(削除された項目)'}<span class="hint" style="margin:0 0 0 6px">${bf.monthKey}</span></span>
        <span style="display:flex;align-items:center;gap:6px">
          <span class="readout">${UI.yen(bf.amount)}</span>
          <button class="mini-link" data-resolvebf="${bf.id}">配分し直す</button>
        </span>
      </div>
    `;
  }).join('');
  return `
    <h3>未解決の貯蓄補填</h3>
    <p class="hint">月末に現金貯蓄から一時的に補填された分です。他の項目の繰越残高から充当し直すこともできます。</p>
    <div class="settings-list">${rows}</div>
  `;
}

function resolveBackfillSheetHtml(bfId) {
  const sp = space();
  const bf = (sp.unresolvedBackfills || []).find(b => b.id === bfId);
  if (!bf) return '<h2>補填を配分し直す</h2><p class="hint">対象が見つかりません(すでに解決済みの可能性があります)</p><button class="btn secondary" id="txCancel">閉じる</button>';
  const cat = sp.categories.find(c => c.id === bf.catId);
  const month = sp.months[sp.currentMonth];
  const candidates = Store.leafCategories(sp).filter(c => !c.auto && c.id !== bf.catId);
  const rows = candidates.map(c => {
    const carry = Math.max(0, (month.carriedIn[c.id]) || 0);
    return `
      <div class="item">
        <span class="name-cell">${UI.iconFor(c)} ${c.name}<span class="hint" style="margin:0 0 0 6px">繰越${UI.yen(carry)}</span></span>
        <span class="item-controls" style="display:flex;align-items:center;gap:6px">
          <button type="button" class="mini-link bfMaxBtn" data-cat="${c.id}" data-max="${carry}" data-bf="${bfId}">残り(max)</button>
          <input type="number" class="bfAllocInput" data-cat="${c.id}" data-max="${carry}" value="0" min="0" max="${carry}" style="width:90px" />
        </span>
      </div>
    `;
  }).join('');
  return `
    <h2>補填を配分し直す</h2>
    <p class="hint">${cat ? UI.iconFor(cat) + ' ' + cat.name : ''} の不足額 <b>${UI.yen(bf.amount)}</b> を、他の項目の繰越残高から充当します(選んだ項目の繰越がマイナスにならない範囲で、合計が不足額と一致するように入力してください)。</p>
    <div class="settings-list">${rows}</div>
    <div class="field" style="margin-top:10px"><b>配分済み合計: <span id="bfAllocatedSum">${UI.yen(0)}</span> / ${UI.yen(bf.amount)}</b></div>
    <button class="btn" id="bfSaveAlloc" data-bf="${bfId}">この内容で配分する</button>
    <button class="btn secondary" id="bfAcceptReserve" data-bf="${bfId}" style="margin-top:8px">現金貯蓄からの補填のままにする</button>
    <button class="btn secondary" id="txCancel">キャンセル</button>
  `;
}

// 同棲タブの設定に表示する、端末間同期(Firebase)の状態・操作UI
function syncSettingsHtml() {
  if (!Sync.available()) {
    return `
      <h3>端末間の同期(2人で共有)</h3>
      <p class="hint">js/firebase-config.jsが未設定のため、同期機能はまだ使えません。設定方法は同ファイルのコメントを参照してください。設定するまでは今まで通り、この端末だけでの利用になります。</p>
    `;
  }
  const code = data.settings.sync.code;
  if (code) {
    return `
      <h3>端末間の同期(2人で共有)</h3>
      <p class="hint">同期中です。相手の端末での同棲タブの変更がこの端末にも反映されます。</p>
      <div class="field"><label>ペアリングコード(他人に教えないこと)</label><div class="readout" style="padding:10px 0;text-align:left;font-weight:700">${code}</div></div>
      <button class="btn danger" id="syncLeave">この端末の同期をやめる</button>
    `;
  }
  return `
    <h3>端末間の同期(2人で共有)</h3>
    <p class="hint">同棲タブの内容を、2人それぞれの携帯でリアルタイムに確認・追加できるようにします。どちらか一方がグループを作り、発行されたコードをもう一方が入力してください。</p>
    <button class="btn secondary" id="syncCreate">新しい同棲グループを作る</button>
    <div class="field" style="margin-top:10px"><label>招待されたコードを入力して参加</label><input type="text" id="syncJoinCode" placeholder="xxxx-xxxx" /></div>
    <button class="btn secondary" id="syncJoin">参加する</button>
    <div class="hint" id="syncError" style="color:var(--over); min-height:16px"></div>
  `;
}

function budgetSettingsHtml() {
  const isSharedSpace = spaceKey === 'shared';
  let html = '<h2>予算設定</h2>';
  html += unresolvedBackfillsHtml(space());

  if (!isSharedSpace) {
    const sp = space();
    const myRatio = spaceKey === 'partner' ? (1 - data.settings.ratioSelf) : data.settings.ratioSelf;
    html += `
      <h3>1人用の予算設定(${Store.spaceLabel(data, spaceKey)})</h3>
      <div class="field"><label>今月の収入</label><input type="number" id="incomeEdit" value="${sp.months[key()].income}" /></div>
      <div class="allocation-box" id="allocationBox">${allocationBoxHtml(sp)}</div>
      <div class="settings-list">${categoryRowsHtml(sp)}</div>

      <h3>同棲資金(表示のみ)</h3>
      <p class="hint">金額・割合の編集は「同棲」タブの設定から行います。</p>
      <div class="settings-list">${sharedFundRowsHtml(true, myRatio)}${sharedFundTotalsHtml(myRatio)}</div>

      ${Lock.lockSettingsHtml(data, spaceKey)}
    `;
  } else {
    html += `
      ${syncSettingsHtml()}
      <h3>同棲資金の予算設定(2人分の合計金額)</h3>
      <p class="hint">ここで設定した金額・割合は${Store.spaceLabel(data, 'personal')}・${Store.spaceLabel(data, 'partner')}の両タブから同じ値として扱われます。予算は2人分の合計金額を入力してください。</p>
      <div class="field"><label>${Store.spaceLabel(data, 'personal')}の負担割合(%)</label><input type="number" id="ratioSelf" value="${Math.round(data.settings.ratioSelf * 100)}" min="0" max="100" /></div>
      <button class="btn secondary" id="ratioSave">割合を保存</button>
      <div class="settings-list" style="margin-top:12px">${sharedFundRowsHtml(false)}</div>
    `;
  }

  html += `
    <h3>カテゴリ管理</h3>
    <button class="btn secondary" id="openAddCat">＋ カテゴリを追加</button>
    <button class="btn secondary" id="openDelCat" style="margin-top:8px">－ カテゴリを削除</button>
    <button class="btn secondary" id="openReorderCat" style="margin-top:8px">⇅ 並び順を変更</button>
  `;

  return html;
}

function addCategorySheetHtml(target) {
  target = target || 'personal';
  const targetSpace = data.spaces[target] || data.spaces.personal;
  const catOptions = Store.topLevel(targetSpace).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  const sectionOptions = target === 'shared'
    ? `<option value="fixed">固定費</option><option value="variable">変動費</option>`
    : `<option value="fixed">固定費</option><option value="variable">変動費</option><option value="savings">貯蓄</option>`;
  return `
    <h2>カテゴリを追加</h2>
    <div class="field"><label>どちらに追加しますか</label>
      <select id="newCatTarget">
        <option value="personal" ${target === 'personal' ? 'selected' : ''}>自身用(${Store.spaceLabel(data, 'personal')})</option>
        <option value="partner" ${target === 'partner' ? 'selected' : ''}>自身用(${Store.spaceLabel(data, 'partner')})</option>
        <option value="shared" ${target === 'shared' ? 'selected' : ''}>同棲資金</option>
      </select>
    </div>
    <div class="field"><label>アイコン(絵文字)</label><input type="text" id="newCatIcon" placeholder="📁" maxlength="4" /></div>
    <div class="field"><label>名前</label><input type="text" id="newCatName" /></div>
    <div class="field"><label>区分</label>
      <select id="newCatSection">${sectionOptions}</select>
    </div>
    <div class="field"><label>親カテゴリ(任意・グループ化)</label>
      <select id="newCatParent"><option value="">なし</option>${catOptions}</select>
    </div>
    <div class="field"><label>月の予算</label><input type="number" id="newCatBudget" value="0" /></div>
    <div class="field"><label><input type="checkbox" id="newCatAuto" /> 固定引き落とし(毎月同額・支払いの記録不要)</label></div>
    <button class="btn" id="newCatSave">追加する</button>
    <button class="btn secondary" id="txCancel">キャンセル</button>
  `;
}

function deleteCategorySheetHtml() {
  const renderGroup = (sp, label, spaceAttr) => {
    const rows = sp.categories.slice().sort((a, b) => a.order - b.order).map(c => {
      const parent = sp.categories.find(p => p.id === c.parentId);
      const indent = parent ? '　└ ' : '';
      return `
        <div class="item">
          <span class="name-cell">${indent}${UI.iconFor(c)} ${c.name}</span>
          <button class="del" data-delcat="${c.id}" data-delspace="${spaceAttr}">削除</button>
        </div>
      `;
    }).join('');
    return `<h3>${label}</h3><div class="settings-list">${rows}</div>`;
  };
  return `
    <h2>カテゴリを削除</h2>
    ${renderGroup(data.spaces.personal, `自身用(${Store.spaceLabel(data, 'personal')})`, 'personal')}
    ${renderGroup(data.spaces.partner, `自身用(${Store.spaceLabel(data, 'partner')})`, 'partner')}
    ${renderGroup(data.spaces.shared, '同棲資金', 'shared')}
    <button class="btn secondary" id="txCancel" style="margin-top:16px">閉じる</button>
  `;
}

// カテゴリの並び順を変更するシート(☰ハンドルをドラッグして自由な位置へ移動)。
// トップレベル同士は1つの並び替えリストに、各グループの子はそのグループ専用の並び替えリストに分ける
// (「どちらの兄弟グループに属するか」を越えて移動できないようにするため)。
function dragRowHtml(cat, isChild) {
  const indent = isChild ? '　└ ' : '';
  return `
    <div class="item drag-row">
      <span class="drag-handle" data-draghandle="1">☰</span>
      <span class="name-cell">${indent}${UI.iconFor(cat)} ${cat.name}</span>
    </div>
  `;
}

function reorderCategorySheetHtml() {
  const renderGroup = (sp, label, spaceAttr) => {
    const tops = Store.topLevel(sp).slice().sort((a, b) => a.order - b.order);
    let html = `<h3>${label}</h3><div class="settings-list drag-list" data-space="${spaceAttr}">`;
    for (const top of tops) {
      if (Store.isGroup(sp, top.id)) {
        const kids = Store.children(sp, top.id).slice().sort((a, b) => a.order - b.order);
        html += `<div class="drag-unit" data-cat="${top.id}">`;
        html += dragRowHtml(top, false);
        html += `<div class="settings-list drag-list drag-list-nested" data-space="${spaceAttr}">`;
        html += kids.map(c => `<div class="item drag-row" data-cat="${c.id}"><span class="drag-handle" data-draghandle="1">☰</span><span class="name-cell">　└ ${UI.iconFor(c)} ${c.name}</span></div>`).join('');
        html += `</div></div>`;
      } else {
        html += `<div class="drag-unit" data-cat="${top.id}">${dragRowHtml(top, false)}</div>`;
      }
    }
    html += `</div>`;
    return html;
  };
  return `
    <h2>並び順を変更</h2>
    <p class="hint">☰ を掴んで自由な位置にドラッグすると、同じグループ内で並び替えられます。</p>
    ${renderGroup(data.spaces.personal, `自身用(${Store.spaceLabel(data, 'personal')})`, 'personal')}
    ${renderGroup(data.spaces.partner, `自身用(${Store.spaceLabel(data, 'partner')})`, 'partner')}
    ${renderGroup(data.spaces.shared, '同棲資金', 'shared')}
    <button class="btn secondary" id="txCancel" style="margin-top:16px">閉じる</button>
  `;
}

// --- カテゴリ並び替え(☰ドラッグ) ---
// dragState: ドラッグ中の { list(直近の.drag-list), unit(動かしている要素), startClientY }
let dragState = null;

function onDragPointerDown(e) {
  const handle = e.target.closest('[data-draghandle]');
  if (!handle) return;
  const list = handle.closest('.drag-list');
  if (!list) return;
  let unit = handle;
  while (unit && unit.parentElement !== list) unit = unit.parentElement;
  if (!unit) return;
  e.preventDefault();
  dragState = { list, unit, startClientY: e.clientY };
  unit.classList.add('dragging');
  document.addEventListener('pointermove', onDragPointerMove);
  document.addEventListener('pointerup', onDragPointerUp, { once: true });
}

function onDragPointerMove(e) {
  if (!dragState) return;
  const { list, unit } = dragState;
  let dy = e.clientY - dragState.startClientY;
  unit.style.transform = `translateY(${dy}px)`;

  const draggedCenter = unit.offsetTop + unit.offsetHeight / 2 + dy;
  const siblings = Array.from(list.children).filter(c => c !== unit);
  const prev = siblings.filter(s => s.offsetTop < unit.offsetTop).pop();
  const next = siblings.find(s => s.offsetTop > unit.offsetTop);

  if (prev && draggedCenter < prev.offsetTop + prev.offsetHeight / 2) {
    const oldTop = unit.offsetTop;
    list.insertBefore(unit, prev);
    dragState.startClientY += (unit.offsetTop - oldTop);
  } else if (next && draggedCenter > next.offsetTop + next.offsetHeight / 2) {
    const oldTop = unit.offsetTop;
    list.insertBefore(unit, next.nextSibling);
    dragState.startClientY += (unit.offsetTop - oldTop);
  }
  dy = e.clientY - dragState.startClientY;
  unit.style.transform = `translateY(${dy}px)`;
}

function onDragPointerUp() {
  if (!dragState) return;
  const { list, unit } = dragState;
  unit.style.transform = '';
  unit.classList.remove('dragging');
  document.removeEventListener('pointermove', onDragPointerMove);

  const targetSpace = data.spaces[list.dataset.space];
  const orderedIds = Array.from(list.children).map(c => c.dataset.cat);
  if (targetSpace) {
    Store.reorderSiblings(targetSpace, orderedIds);
    persist();
  }
  dragState = null;
  renderApp();
  openSheet(reorderCategorySheetHtml());
}

// 開発用タブ:個人タブの表示名の変更(絵文字は固定)
function spaceLabelRowsHtml() {
  return `
    <h3>名前の変更</h3>
    <p class="hint">タブの見出しなど、アプリ内の表示名を変更できます(絵文字は変更できません)。</p>
    <div class="settings-list">
      <div class="item">
        <span class="name-cell">🧑</span>
        <input type="text" class="spaceLabelEdit" data-space="personal" value="${data.settings.labels.personal}" maxlength="10" style="width:140px" />
      </div>
      <div class="item">
        <span class="name-cell">👩</span>
        <input type="text" class="spaceLabelEdit" data-space="partner" value="${data.settings.labels.partner}" maxlength="10" style="width:140px" />
      </div>
    </div>
  `;
}

// 開発用タブ:デフォルトの収入(🧑自分・👩彼女)の編集
function defaultIncomeRowsHtml() {
  const inc = data.settings.defaultTemplate.income;
  return `
    <h3>デフォルトの収入</h3>
    <div class="settings-list">
      <div class="item">
        <span class="name-cell">${Store.spaceLabel(data, 'personal')}</span>
        <input type="number" class="defTmplIncome" data-who="personal" value="${inc.personal}" style="width:120px" />
      </div>
      <div class="item">
        <span class="name-cell">${Store.spaceLabel(data, 'partner')}</span>
        <input type="number" class="defTmplIncome" data-who="partner" value="${inc.partner}" style="width:120px" />
      </div>
    </div>
  `;
}

// 開発用タブ:デフォルト予算額(data.settings.defaultTemplate)の編集リスト
function defaultTemplateRowsHtml(groupKey, label) {
  const tmpl = data.settings.defaultTemplate[groupKey];
  const names = Object.keys(tmpl);
  return `
    <h3>${label}</h3>
    <div class="settings-list">
      ${names.map(name => `
        <div class="item">
          <span class="name-cell">${name}</span>
          <span class="item-controls" style="display:flex;align-items:center;gap:6px">
            <label class="auto-toggle">固定引き落とし<input type="checkbox" class="defTmplAuto" data-group="${groupKey}" data-name="${name}" ${tmpl[name].auto ? 'checked' : ''} /></label>
            <input type="number" class="defTmplBudget" data-group="${groupKey}" data-name="${name}" value="${tmpl[name].budget}" style="width:90px" />
          </span>
        </div>
      `).join('')}
    </div>
  `;
}

function devSettingsHtml() {
  return `
    <h2>開発用</h2>
    <button class="btn secondary" id="forceClose">当月を締めて翌月へ進める(${Store.spaceLabel(data, 'personal')}・${Store.spaceLabel(data, 'partner')}・🤝同棲すべて・テスト用)</button>
    <button class="btn secondary" id="resetToDefaults" style="margin-top:8px">予算設定をデフォルトに戻して金額もリセット(テスト用)</button>
    <button class="btn danger" id="resetAll" style="margin-top:12px">金額をすべてリセットする(テスト用)</button>

    ${spaceLabelRowsHtml()}

    <h3 style="margin-top:20px">デフォルト予算額の編集</h3>
    <p class="hint">「予算設定をデフォルトに戻して金額もリセット」ボタンで適用される金額です。ここで自由に変更できます。</p>
    ${defaultIncomeRowsHtml()}
    ${defaultTemplateRowsHtml('personal', `個人用(${Store.spaceLabel(data, 'personal')})`)}
    ${defaultTemplateRowsHtml('partner', `個人用(${Store.spaceLabel(data, 'partner')})`)}
    ${defaultTemplateRowsHtml('shared', '同棲資金(2人分の合計金額)')}
  `;
}

function settingsTabHtml() {
  const pills = `
    <div class="subtabs">
      <button class="subtab ${settingsSubTab === 'budget' ? 'active' : ''}" data-subtab="budget">予算設定</button>
      <button class="subtab ${settingsSubTab === 'dev' ? 'active' : ''}" data-subtab="dev">開発用</button>
    </div>
  `;
  return pills + (settingsSubTab === 'dev' ? devSettingsHtml() : budgetSettingsHtml());
}

// --- イベント ---

el.tabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  requestSpace(btn.dataset.space);
});

el.bottomTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.bottom-tab');
  if (!btn) return;
  activeTab = btn.dataset.tab;
  renderApp();
});

el.addBtn.addEventListener('click', () => {
  quickAddTree = 'own';
  pendingCatId = null;
  quickAddParentId = null;
  amountDigits = '';
  txType = 'expense';
  txPayer = 'self';
  openSheet(quickAddHtml());
});

el.tabContent.addEventListener('click', (e) => {
  if (e.target.id === 'editTotalBtn') {
    openSheet(editTotalSheetHtml());
    return;
  }

  if (e.target.id === 'reportExportExcel') {
    if (guardOnce(e.target)) return;
    Report.exportExcel(data, reportOwnKey());
    return;
  }

  if (e.target.id === 'reportOverallPdf') {
    if (guardOnce(e.target)) return;
    Report.renderHtmlToPdf(Report.overallReportHtml(data, reportOwnKey()), `資産管理レポート_全期間.pdf`);
    return;
  }

  const reportPdfBtn = e.target.closest('[data-reportpdf]');
  if (reportPdfBtn) {
    if (guardOnce(reportPdfBtn)) return;
    const mk = reportPdfBtn.dataset.reportpdf;
    Report.renderHtmlToPdf(Report.monthReportHtml(data, mk, reportOwnKey()), `資産管理レポート_${mk}.pdf`);
    return;
  }

  if (e.target.id === 'lockSetPin') {
    openSheet(setPinSheetHtml(e.target.dataset.space));
    return;
  }
  if (e.target.id === 'lockClear') {
    if (guardOnce(e.target)) return;
    if (!confirm('画面ロックを解除します。よろしいですか?')) return;
    Lock.clearLock(data, e.target.dataset.space);
    persist();
    renderApp();
    return;
  }
  if (e.target.id === 'lockSetWebauthn') {
    if (guardOnce(e.target)) return;
    const sp = e.target.dataset.space;
    const label = Store.spaceLabel(data, sp);
    Lock.registerWebauthn(data, sp, label).then(() => {
      persist();
      renderApp();
    }).catch(() => {
      alert('Face ID/指紋の登録に失敗しました(キャンセルされたか、この端末では使えない可能性があります)');
      e.target.dataset.firing = '';
    });
    return;
  }

  const sfRow = e.target.closest('[data-sharedfund]');
  if (sfRow) {
    spaceKey = 'shared';
    renderApp();
    return;
  }

  const dayCell = e.target.closest('.cal-cell[data-date]');
  if (dayCell) {
    const dateStr = dayCell.dataset.date;
    const vk = calendarViewKey || key();
    const lookup = (catId) => space().categories.find(c => c.id === catId);
    openSheet(UI.dayDetailHtml(space(), vk, dateStr, lookup) + '<button class="btn secondary" id="txCancel" style="margin-top:16px">閉じる</button>');
    return;
  }

  if (e.target.id === 'calPrev') { calendarViewKey = Store.addMonths(calendarViewKey || key(), -1); renderApp(); return; }
  if (e.target.id === 'calNext') { calendarViewKey = Store.addMonths(calendarViewKey || key(), 1); renderApp(); return; }

  const histItem = e.target.closest('.tx-item[data-tx]');
  if (histItem && activeTab === 'calendar') {
    const vk = calendarViewKey || key();
    const month = space().months[vk];
    const tx = month && month.transactions.find(t => t.id === histItem.dataset.tx);
    if (tx) {
      editingTxId = tx.id;
      amountDigits = String(tx.amount);
      txPayer = tx.payer || 'self';
      openSheet(editTxSheetHtml(space(), tx));
    }
    return;
  }

  const pieTarget = e.target.closest('[data-pie-name]');
  if (pieTarget) {
    const group = pieTarget.closest('.pie-group');
    const chartId = group && group.dataset.pieChart;
    if (chartId) {
      const name = pieTarget.dataset.pieName;
      // 同じ項目を再タップすると吹き出しを閉じる
      pieSelected[chartId] = (pieSelected[chartId] === name) ? null : name;
      renderApp();
    }
    return;
  }

  const assetToggle = e.target.closest('[data-assettoggle]');
  if (assetToggle) {
    const k = assetToggle.dataset.assettoggle;
    assetExpanded[k] = !assetExpanded[k];
    renderApp();
    return;
  }

  const resolveBf = e.target.closest('[data-resolvebf]');
  if (resolveBf) {
    openSheet(resolveBackfillSheetHtml(resolveBf.dataset.resolvebf));
    return;
  }

  const subtab = e.target.closest('[data-subtab]');
  if (subtab) {
    settingsSubTab = subtab.dataset.subtab;
    renderApp();
    return;
  }

  if (e.target.id === 'openAddCat') { openSheet(addCategorySheetHtml(spaceKey)); return; }
  if (e.target.id === 'openDelCat') { openSheet(deleteCategorySheetHtml()); return; }
  if (e.target.id === 'openReorderCat') { openSheet(reorderCategorySheetHtml()); return; }

  if (e.target.id === 'ratioSave') {
    if (guardOnce(e.target)) return;
    data.settings.ratioSelf = (Number(document.getElementById('ratioSelf').value) || 0) / 100;
    persist();
    renderApp();
    return;
  }

  if (e.target.id === 'syncCreate') {
    if (guardOnce(e.target)) return;
    Sync.createHousehold(data, onRemoteSharedUpdate).then(() => {
      Store.save(data);
      renderApp();
    }).catch((err) => {
      alert('同期グループの作成に失敗しました: ' + err.message);
      e.target.dataset.firing = '';
    });
    return;
  }

  if (e.target.id === 'syncJoin') {
    if (guardOnce(e.target)) return;
    const codeInput = document.getElementById('syncJoinCode');
    const errBox = document.getElementById('syncError');
    const code = codeInput.value.trim();
    if (!code) { errBox.textContent = 'コードを入力してください'; e.target.dataset.firing = ''; return; }
    Sync.joinHousehold(data, code, onRemoteSharedUpdate).then(() => {
      Store.save(data);
      renderApp();
    }).catch((err) => {
      errBox.textContent = err.message;
      e.target.dataset.firing = '';
    });
    return;
  }

  if (e.target.id === 'syncLeave') {
    if (guardOnce(e.target)) return;
    if (!confirm('この端末の同期をやめます。よろしいですか?(今の同棲データはこの端末に残ります)')) {
      e.target.dataset.firing = '';
      return;
    }
    Sync.leaveHousehold(data);
    persist();
    renderApp();
    return;
  }

  if (e.target.id === 'forceClose') {
    if (guardOnce(e.target)) return;
    // 同棲資金の自己負担分の計算がずれないよう、同棲→個人→彼女の順で3スペースまとめて締める
    Store.closeMonth(data.spaces.shared, data.spaces.shared.currentMonth, 0);
    Store.syncSharedIncome(data);
    Store.closeMonth(data.spaces.personal, data.spaces.personal.currentMonth, Store.personalSharedShare(data));
    Store.closeMonth(data.spaces.partner, data.spaces.partner.currentMonth, Store.partnerSharedShare(data));
    persist();
    renderApp();
    return;
  }

  if (e.target.id === 'resetToDefaults') {
    if (guardOnce(e.target)) return;
    if (!confirm('予算設定をデフォルトに戻し、今月の収入・記録・繰越などの金額もリセットします。よろしいですか?(元に戻せません)')) return;
    Store.applyDefaultTemplate(data);
    const inc = data.settings.defaultTemplate.income;
    Store.resetSpaceAmounts(data.spaces.personal, inc.personal);
    Store.resetSpaceAmounts(data.spaces.partner, inc.partner);
    Store.resetSpaceAmounts(data.spaces.shared);
    Store.syncSharedIncome(data);
    persist();
    renderApp();
    return;
  }

  if (e.target.id === 'resetAll') {
    if (!confirm('本当にすべての金額・記録をリセットしますか?(元に戻せません)')) return;
    Store.resetAll();
    location.reload();
    return;
  }

  const row = e.target.closest('.cat-row[data-cat]');
  if (!row || activeTab !== 'budget') return;
  const catId = row.dataset.cat;
  if (Store.isGroup(space(), catId)) {
    expanded[catId] = !expanded[catId];
    renderApp();
  } else {
    amountDigits = '';
    openSheet(detailHtml(catId));
  }
});

el.tabContent.addEventListener('change', (e) => {
  if (e.target.id === 'lockDeviceOwner') {
    const sp = e.target.dataset.space;
    Lock.setDeviceOwner(e.target.checked ? sp : null);
    renderApp();
    return;
  }
  if (e.target.id === 'incomeEdit') {
    space().months[key()].income = Number(e.target.value) || 0;
    persist();
    updateAllocationBox();
    return;
  }
  if (e.target.classList.contains('catBudgetEdit')) {
    const cat = space().categories.find(c => c.id === e.target.dataset.cat);
    cat.budget = Number(e.target.value) || 0;
    persist();
    updateAllocationBox();
    return;
  }
  if (e.target.classList.contains('catIconEdit')) {
    const cat = space().categories.find(c => c.id === e.target.dataset.cat);
    cat.icon = e.target.value.trim() || null;
    persist();
    return;
  }
  if (e.target.classList.contains('catAutoEdit')) {
    const cat = space().categories.find(c => c.id === e.target.dataset.cat);
    cat.auto = e.target.checked;
    persist();
    return;
  }
  if (e.target.classList.contains('sfBudgetEdit')) {
    const cat = data.spaces.shared.categories.find(c => c.id === e.target.dataset.cat);
    cat.budget = Number(e.target.value) || 0;
    Store.syncSharedIncome(data);
    persist();
    renderApp();
    return;
  }
  if (e.target.classList.contains('sfIconEdit')) {
    const cat = data.spaces.shared.categories.find(c => c.id === e.target.dataset.cat);
    cat.icon = e.target.value.trim() || null;
    persist();
    return;
  }
  if (e.target.classList.contains('sfAutoEdit')) {
    const cat = data.spaces.shared.categories.find(c => c.id === e.target.dataset.cat);
    cat.auto = e.target.checked;
    Store.syncSharedIncome(data);
    persist();
    renderApp();
    return;
  }
  if (e.target.classList.contains('defTmplBudget')) {
    const g = e.target.dataset.group, n = e.target.dataset.name;
    data.settings.defaultTemplate[g][n].budget = Number(e.target.value) || 0;
    persist();
    return;
  }
  if (e.target.classList.contains('defTmplAuto')) {
    const g = e.target.dataset.group, n = e.target.dataset.name;
    data.settings.defaultTemplate[g][n].auto = e.target.checked;
    persist();
    return;
  }
  if (e.target.classList.contains('defTmplIncome')) {
    data.settings.defaultTemplate.income[e.target.dataset.who] = Number(e.target.value) || 0;
    persist();
    return;
  }
  if (e.target.classList.contains('spaceLabelEdit')) {
    const sp = e.target.dataset.space;
    const fallback = sp === 'partner' ? '彼女' : '自分';
    data.settings.labels[sp] = e.target.value.trim() || fallback;
    persist();
    renderApp();
    return;
  }
});

el.sheetOverlay.addEventListener('click', (e) => {
  if (e.target === el.sheetOverlay) closeSheet();
});

el.sheet.addEventListener('pointerdown', onDragPointerDown);

el.sheet.addEventListener('click', (e) => {
  if (e.target.id === 'txCancel') { closeSheet(); return; }

  if (e.target.id === 'setPinSave') {
    if (guardOnce(e.target)) return;
    const sp = e.target.dataset.space;
    const p1 = document.getElementById('newPin1').value;
    const p2 = document.getElementById('newPin2').value;
    const errBox = document.getElementById('setPinError');
    const fail = (msg) => { errBox.textContent = msg; e.target.dataset.firing = ''; };
    if (!/^[0-9]{4,8}$/.test(p1)) { fail('4〜8桁の数字で入力してください'); return; }
    if (p1 !== p2) { fail('確認用のPINが一致しません'); return; }
    Lock.setPin(data, sp, p1).then(() => {
      persist();
      closeSheet();
      renderApp();
    });
    return;
  }

  const keyBtn = e.target.closest('[data-key]');
  if (keyBtn) {
    const k = keyBtn.dataset.key;
    if (k === 'clear') amountDigits = '';
    else if (k === 'del') amountDigits = amountDigits.slice(0, -1);
    else if (amountDigits.length < 9) amountDigits += k;
    const disp = document.getElementById('amountDisplay');
    if (disp) disp.textContent = UI.yen(Number(amountDigits || '0'));
    return;
  }

  const typeBtn = e.target.closest('[data-type]');
  if (typeBtn) {
    txType = typeBtn.dataset.type;
    pendingCatId = null;
    quickAddParentId = null;
    quickAddTree = 'own';
    openSheet(quickAddHtml());
    return;
  }

  const payerBtn = e.target.closest('[data-payer]');
  if (payerBtn) {
    txPayer = payerBtn.dataset.payer;
    if (editingTxId) {
      const vk = calendarViewKey || key();
      const month = space().months[vk];
      const tx = month && month.transactions.find(t => t.id === editingTxId);
      if (tx) openSheet(editTxSheetHtml(space(), tx));
      return;
    }
    const isDetail = !!el.sheet.querySelector('#txSaveDetail');
    openSheet(isDetail ? detailHtml(el.sheet.querySelector('h2[data-cat]').dataset.cat) : quickAddHtml());
    return;
  }

  const changeCat = e.target.closest('[data-changecat]');
  if (changeCat) {
    pendingCatId = null;
    quickAddParentId = null;
    amountDigits = '';
    openSheet(quickAddHtml());
    return;
  }

  const treeBack = e.target.closest('[data-treeback]');
  if (treeBack) {
    quickAddTree = 'own';
    quickAddParentId = null;
    openSheet(quickAddHtml());
    return;
  }

  const parentOpt = e.target.closest('[data-parent]');
  if (parentOpt) {
    const pid = parentOpt.dataset.parent;
    if (pid === '__sharedfund__') { quickAddTree = 'sharedfund'; quickAddParentId = null; }
    else if (pid === '__other__') { quickAddParentId = '__other__'; }
    else { quickAddParentId = pid; }
    openSheet(quickAddHtml());
    return;
  }

  const backOpt = e.target.closest('[data-back]');
  if (backOpt) {
    quickAddParentId = null;
    openSheet(quickAddHtml());
    return;
  }

  const leafOpt = e.target.closest('[data-leaf]');
  if (leafOpt) {
    pendingCatId = leafOpt.dataset.leaf;
    amountDigits = '';
    openSheet(quickAddHtml());
    return;
  }

  if (e.target.id === 'txEditSave') {
    if (guardOnce(e.target)) return;
    const amount = Number(amountDigits);
    if (!amount || amount <= 0) { alert('金額を入力してください'); return; }
    const memo = document.getElementById('txMemo').value;
    const date = document.getElementById('txDate').value;
    const vk = calendarViewKey || key();
    const month = space().months[vk];
    const tx = month && month.transactions.find(t => t.id === editingTxId);
    if (tx) {
      tx.amount = amount;
      tx.memo = memo;
      tx.date = date;
      if (tx.payer) tx.payer = txPayer;
      persist();
    }
    closeSheet();
    renderApp();
    return;
  }

  if (e.target.id === 'txEditDelete') {
    if (guardOnce(e.target)) return;
    if (!confirm('この記録を削除しますか?')) return;
    const vk = calendarViewKey || key();
    const month = space().months[vk];
    if (month) month.transactions = month.transactions.filter(t => t.id !== editingTxId);
    persist();
    closeSheet();
    renderApp();
    return;
  }

  const maxBtn = e.target.closest('.bfMaxBtn');
  if (maxBtn) {
    const catId = maxBtn.dataset.cat;
    const rowMax = Number(maxBtn.dataset.max) || 0;
    const bf = (space().unresolvedBackfills || []).find(b => b.id === maxBtn.dataset.bf);
    const target = bf ? bf.amount : 0;
    const others = Array.from(el.sheet.querySelectorAll('.bfAllocInput'))
      .filter(i => i.dataset.cat !== catId)
      .reduce((s, i) => s + (Number(i.value) || 0), 0);
    const stillNeeded = Math.max(0, target - others);
    const fill = Math.min(rowMax, stillNeeded);
    const input = el.sheet.querySelector(`.bfAllocInput[data-cat="${catId}"]`);
    if (input) input.value = fill;
    const sumEl = document.getElementById('bfAllocatedSum');
    if (sumEl) {
      const sum = Array.from(el.sheet.querySelectorAll('.bfAllocInput')).reduce((s, i) => s + (Number(i.value) || 0), 0);
      sumEl.textContent = UI.yen(sum);
    }
    return;
  }

  if (e.target.id === 'bfSaveAlloc') {
    if (guardOnce(e.target)) return;
    const bfId = e.target.dataset.bf;
    const inputs = Array.from(el.sheet.querySelectorAll('.bfAllocInput'));
    const allocations = {};
    let sum = 0;
    for (const inp of inputs) {
      const amt = Number(inp.value) || 0;
      const max = Number(inp.dataset.max) || 0;
      if (amt < 0 || amt > max) { alert('繰越残高を超える金額、またはマイナスの金額は指定できません'); return; }
      if (amt > 0) allocations[inp.dataset.cat] = amt;
      sum += amt;
    }
    const bf = (space().unresolvedBackfills || []).find(b => b.id === bfId);
    if (!bf) { closeSheet(); renderApp(); return; }
    if (Math.round(sum) !== Math.round(bf.amount)) { alert(`配分済み合計が不足額(${UI.yen(bf.amount)})と一致している必要があります`); return; }
    Store.reassignBackfill(space(), bfId, allocations);
    persist();
    closeSheet();
    renderApp();
    return;
  }

  if (e.target.id === 'bfAcceptReserve') {
    if (guardOnce(e.target)) return;
    Store.acceptBackfillFromReserve(space(), e.target.dataset.bf);
    persist();
    closeSheet();
    renderApp();
    return;
  }

  if (e.target.id === 'txSave') {
    if (guardOnce(e.target)) return;
    const amount = Number(amountDigits);
    const memo = document.getElementById('txMemo').value;
    const date = document.getElementById('txDate').value;
    const isIncome = spaceKey !== 'shared' && txType === 'income';
    if (!isIncome && !pendingCatId) { alert('カテゴリを選択してください'); return; }
    if (!amount || amount <= 0) { alert('金額を入力してください'); return; }
    const belongsToShared = !isIncome && data.spaces.shared.categories.some(c => c.id === pendingCatId);
    const targetSpace = belongsToShared ? data.spaces.shared : space();
    const extra = { type: isIncome ? 'income' : 'expense' };
    if (belongsToShared) extra.payer = txPayer;
    addTransaction(targetSpace, isIncome ? null : pendingCatId, amount, memo, date, extra);
    closeSheet();
    renderApp();
    return;
  }

  if (e.target.id === 'txSaveDetail') {
    if (guardOnce(e.target)) return;
    const catId = e.target.dataset.cat;
    const amount = Number(amountDigits);
    const memo = document.getElementById('txMemo').value;
    const date = document.getElementById('txDate').value;
    if (!amount || amount <= 0) { alert('金額を入力してください'); return; }
    const extra = { type: 'expense' };
    if (spaceKey === 'shared') extra.payer = txPayer;
    addTransaction(space(), catId, amount, memo, date, extra);
    amountDigits = '';
    openSheet(detailHtml(catId));
    renderApp();
    return;
  }

  if (e.target.id === 'saveTotalBtn') {
    if (guardOnce(e.target)) return;
    const newTotal = Number(document.getElementById('newTotal').value) || 0;
    const current = Store.totalAssets(space());
    space().reserve.balance += (newTotal - current);
    persist();
    closeSheet();
    renderApp();
    return;
  }

  if (e.target.id === 'newCatSave') {
    if (guardOnce(e.target)) return;
    const target = document.getElementById('newCatTarget').value;
    const targetSpace = data.spaces[target] || data.spaces.personal;
    const icon = document.getElementById('newCatIcon').value.trim();
    const name = document.getElementById('newCatName').value.trim();
    const section = document.getElementById('newCatSection').value;
    const parentId = document.getElementById('newCatParent').value || null;
    const budget = Number(document.getElementById('newCatBudget').value) || 0;
    const auto = document.getElementById('newCatAuto').checked;
    if (!name) { alert('名前を入力してください'); return; }
    const order = Math.max(0, ...targetSpace.categories.map(c => c.order)) + 1;
    targetSpace.categories.push({ id: Store.uid(), name, section, parentId, budget, order, icon: icon || null, auto });
    if (target === 'shared') Store.syncSharedIncome(data);
    persist();
    closeSheet();
    renderApp();
    return;
  }

  const delcat = e.target.closest('[data-delcat]');
  if (delcat) {
    if (guardOnce(delcat)) return;
    const catId = delcat.dataset.delcat;
    const targetSpace = data.spaces[delcat.dataset.delspace] || data.spaces.personal;
    if (!confirm('このカテゴリを削除しますか?(子カテゴリも削除されます)')) return;
    const idsToRemove = new Set([catId, ...targetSpace.categories.filter(c => c.parentId === catId).map(c => c.id)]);
    targetSpace.categories = targetSpace.categories.filter(c => !idsToRemove.has(c.id));
    if (delcat.dataset.delspace === 'shared') Store.syncSharedIncome(data);
    persist();
    openSheet(deleteCategorySheetHtml());
    renderApp();
    return;
  }

  const del = e.target.closest('[data-tx]');
  if (del) {
    const txId = del.dataset.tx;
    const openCatId = el.sheet.querySelector('h2[data-cat]')?.dataset.cat;
    const month = space().months[key()];
    month.transactions = month.transactions.filter(t => t.id !== txId);
    persist();
    renderApp();
    if (openCatId) openSheet(detailHtml(openCatId));
    return;
  }
});

el.sheet.addEventListener('change', (e) => {
  if (e.target.id === 'newCatTarget') {
    openSheet(addCategorySheetHtml(e.target.value));
  }
});

el.sheet.addEventListener('input', (e) => {
  if (e.target.classList.contains('bfAllocInput')) {
    const sumEl = document.getElementById('bfAllocatedSum');
    if (!sumEl) return;
    const sum = Array.from(el.sheet.querySelectorAll('.bfAllocInput')).reduce((s, el2) => s + (Number(el2.value) || 0), 0);
    sumEl.textContent = UI.yen(sum);
  }
});

el.lockOverlay.addEventListener('click', async (e) => {
  if (e.target.id === 'lockCancelBtn') { closeLockScreen(); return; }

  if (e.target.id === 'lockWebauthnBtn') {
    if (guardOnce(e.target)) return;
    const ok = await Lock.tryWebauthnUnlock(data, pendingSpaceKey);
    if (ok) completeUnlock(pendingSpaceKey);
    else showLockError('認証できませんでした。PINコードをお試しください。');
    e.target.dataset.firing = '';
    return;
  }

  if (e.target.id === 'lockPinSubmit') {
    if (guardOnce(e.target)) return;
    const input = document.getElementById('lockPinInput');
    const ok = await Lock.verifyPin(data, pendingSpaceKey, input.value);
    e.target.dataset.firing = '';
    if (ok) { completeUnlock(pendingSpaceKey); return; }
    showLockError('PINコードが違います');
    input.value = '';
  }
});

el.lockOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'lockPinInput') {
    document.getElementById('lockPinSubmit').click();
  }
});

// 同期先(Firebase)に既に参加済みなら、起動時に購読を再開する(未設定なら何もしない)
Sync.resume(data, onRemoteSharedUpdate);

// 起動直後、初期表示の空間(🧑自分)がロック対象ならロック画面を先に出す
if (Lock.isSpaceLocked(data, spaceKey, sessionUnlocked)) {
  pendingSpaceKey = spaceKey;
  openLockScreen(spaceKey);
} else {
  renderApp();
}
