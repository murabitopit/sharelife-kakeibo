// 画面描画用のヘルパー(HTML文字列生成)。状態管理・イベントはmain.jsで行う。

const ICON_MAP = {
  '家賃': '🏠', '水道光熱費': '💡', 'ガス': '🔥', '電気': '💡', '水道': '🚿', '通信費': '📶', '保険料': '🛡️',
  '車両費': '🚗', '駐車場': '🅿️', '車検用積立金': '🔧', '自動車税積立金': '📄', '自動車保険積立金': '🚙',
  '奨学金返済': '🎓',
  '食費': '🍚', '自炊': '🍳', '外食': '🍽️',
  '日用品': '🧻',
  '交通費': '🚃', '交通費(車のガソリン代)': '⛽', '公共交通機関': '🚉',
  '交際費': '🍻', 'サブスク': '📱', '自由予算': '💸', '美容・衣服': '👗',
  '積立金': '🏦', '株式投資': '📈', '現金預金': '👛', '旅行積立金': '✈️',
  '同棲資金': '🤝', 'その他': '📁',
};

function iconFor(cat) {
  if (cat.icon) return cat.icon;
  return ICON_MAP[cat.name] || (cat.parentId ? '▫️' : '📁');
}

function yen(n) {
  return '¥' + Math.round(n).toLocaleString('ja-JP');
}

function badgeHtml(status) {
  if (status === 'over') return '<span class="badge over">貯蓄補填</span>';
  if (status === 'warning') return '<span class="badge warning">節約</span>';
  return '';
}

function autoBadgeHtml(cat) {
  return cat.auto ? '<span class="badge auto">固定引落</span>' : '';
}

function barHtml(status, spent, budget) {
  const pct = budget > 0 ? Math.min(100, Math.max(0, (spent / budget) * 100)) : (spent > 0 ? 100 : 0);
  const cls = status === 'over' ? 'over' : (status === 'warning' ? 'warning' : '');
  return `<div class="bar ${cls}"><div style="width:${pct}%"></div></div>`;
}

function summaryHtml(space, key, sharedFundSummary) {
  const t = Store.totals(space, key);
  const spent = t.spent + (sharedFundSummary ? sharedFundSummary.spent : 0);
  const remainingVsIncome = t.income - spent;
  return `
    <div class="card"><div class="label">収入</div><div class="value">${yen(t.income)}</div></div>
    <div class="card"><div class="label">支出</div><div class="value">${yen(spent)}</div></div>
    <div class="card wide">
      <div><div class="label">残り予算(収入-支出)</div><div class="value">${yen(remainingVsIncome)}</div></div>
    </div>
  `;
}

// グループの開閉シェブロン(絵文字は使わず、通常のテキスト記号を回転させる)
function chevronHtml(isExpanded) {
  return `<span class="chevron ${isExpanded ? 'open' : ''}">›</span>`;
}

// コンパクトな1項目行:アイコン+名前(+バッジ) / 支出 / 予算 / 横棒グラフ
// 予算は繰越を含めない「今月設定した予算」そのものを表示する(今月実際に使いすぎているかを見るため)
function catRowHtml(space, key, cat, isChild, group, isExpanded) {
  const spent = Store.spentOf(space, key, cat.id);
  const budget = Store.rawBudgetOf(space, cat.id);
  const status = Store.rawStatusOf(space, key, cat.id);
  const chevron = group ? chevronHtml(isExpanded) : '';
  return `
    <div class="cat-row ${isChild ? 'child' : ''}" data-cat="${cat.id}">
      <div class="row-top">
        <div class="name">${chevron}${iconFor(cat)} ${cat.name}${badgeHtml(status)}${autoBadgeHtml(cat)}</div>
        <div class="nums">${yen(spent)} / ${yen(budget)}</div>
      </div>
      ${barHtml(status, spent, budget)}
    </div>
  `;
}

// 同棲資金(personal側での合算1行表示。内訳はsharedタブで確認する前提)
function sharedFundRowHtml(summary) {
  const status = summary.spent > summary.budget ? 'over' : 'ok';
  return `
    <div class="cat-row" data-sharedfund="1">
      <div class="row-top">
        <div class="name">${iconFor({ name: '同棲資金' })} 同棲資金<span class="badge auto">固定引落</span></div>
        <div class="nums">${yen(summary.spent)} / ${yen(summary.budget)}</div>
      </div>
      ${barHtml(status, summary.spent, summary.budget)}
      <div class="hint" style="margin:6px 0 0">内訳・負担割合は「同棲」タブで確認できます</div>
    </div>
  `;
}

function catListHtml(space, key, expanded, sharedFundSummary) {
  const render = (section, title) => {
    const tops = Store.topLevel(space).filter(c => c.section === section);
    if (tops.length === 0) return '';
    let html = `<div class="section-title">${title}</div>`;
    for (const cat of tops) {
      const group = Store.isGroup(space, cat.id);
      const isExpanded = !!expanded[cat.id];
      html += catRowHtml(space, key, cat, false, group, isExpanded);
      if (group && isExpanded) {
        for (const child of Store.children(space, cat.id)) {
          html += catRowHtml(space, key, child, true, false, false);
        }
      }
    }
    return html;
  };
  let html = '';
  if (sharedFundSummary) {
    html += `<div class="section-title">同棲資金</div>${sharedFundRowHtml(sharedFundSummary)}`;
  }
  html += render('fixed', '固定費') + render('variable', '変動費') + render('savings', '貯蓄');
  return html;
}

// 固定引き落としのカテゴリは通常「収支を記録」の対象外(毎月決まった額が自動で引かれるため)。
// 一番下の「その他」からだけ選べるようにする。
function isPickable(cat) {
  return !cat.auto;
}

// 1段目: トップレベル。子がいればそのグループへ進む(›)、無ければ直接選択できるリーフ。
// opts.backRow: 他のカテゴリ木から来た場合の「戻る」行
// opts.showSharedFundLink: 個人タブから同棲資金へ進むリンクを足す
// opts.otherLeaves: 固定引き落としカテゴリの配列。あれば最後に「その他」リンクを足す
function catPickerTopHtml(space, opts) {
  opts = opts || {};
  let html = '<div class="cat-picker">';
  if (opts.backRow) html += `<div class="back-row" data-treeback="1">‹ 戻る</div>`;
  for (const cat of Store.topLevel(space)) {
    if (Store.isGroup(space, cat.id)) {
      const pickableChildren = Store.children(space, cat.id).filter(isPickable);
      if (pickableChildren.length === 0) continue;
      html += `<div class="opt parent" data-parent="${cat.id}"><span>${iconFor(cat)} ${cat.name}</span><span class="chevron">›</span></div>`;
    } else {
      if (!isPickable(cat)) continue;
      html += `<div class="opt" data-leaf="${cat.id}">${iconFor(cat)} ${cat.name}</div>`;
    }
  }
  if (opts.showSharedFundLink) {
    html += `<div class="opt parent" data-parent="__sharedfund__"><span>${iconFor({ name: '同棲資金' })} 同棲資金</span><span class="chevron">›</span></div>`;
  }
  if (opts.otherLeaves && opts.otherLeaves.length) {
    html += `<div class="opt parent" data-parent="__other__"><span>${iconFor({ name: 'その他' })} その他(固定引き落とし)</span><span class="chevron">›</span></div>`;
  }
  html += '</div>';
  return html;
}

// 2段目: 選んだ親の子カテゴリ一覧
function catPickerChildHtml(space, parentId) {
  const parent = space.categories.find(c => c.id === parentId);
  let html = '<div class="cat-picker">';
  html += `<div class="back-row" data-back="1">‹ 戻る(${parent.name})</div>`;
  for (const cat of Store.children(space, parentId).filter(isPickable)) {
    html += `<div class="opt" data-leaf="${cat.id}">${iconFor(cat)} ${cat.name}</div>`;
  }
  html += '</div>';
  return html;
}

// 「その他」: 固定引き落としカテゴリをあえて選ぶための平らなリスト
function catPickerOtherHtml(leaves) {
  let html = '<div class="cat-picker">';
  html += `<div class="back-row" data-back="1">‹ 戻る(その他)</div>`;
  for (const cat of leaves) {
    html += `<div class="opt" data-leaf="${cat.id}">${iconFor(cat)} ${cat.name}</div>`;
  }
  html += '</div>';
  return html;
}

// --- 円グラフ(カテゴリ別支出、上位6+その他) ---

function polarToCartesian(cx, cy, r, angleDeg) {
  const a = (angleDeg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function arcPath(cx, cy, r, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? 0 : 1;
  return `M ${cx} ${cy} L ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 0 ${end.x.toFixed(2)} ${end.y.toFixed(2)} Z`;
}

const PIE_COLOR_COUNT = 12;

// idから「できれば使いたい」色番号(0〜11)を決める(表示される項目の増減や並び順に左右されず、
// 同じ項目はなるべく常に同じ色になるようにするため、配列中の位置ではなくidのハッシュで決める)
function colorIndexFor(id) {
  const s = String(id == null ? '' : id);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % PIE_COLOR_COUNT;
}

// items: [{id,name,icon,order,value}] (value>0のみ渡す想定)。「その他」にまとめず全項目を個別に表示する。
// 色はidごとのハッシュで決めるが、同じグラフ内で別項目同士が同じ色にならないよう、
// 既に使われている番号なら次の空いている番号へずらす(=同一グラフ内では必ず色が被らない)。
// 各スライスの開始/終了/中間角度(0度=12時方向、時計回り)も付与する。
function buildPieSlices(items) {
  const total = items.reduce((s, c) => s + c.value, 0);
  if (total === 0) return null;
  const ordered = items.slice().sort((a, b) => a.order - b.order);
  const usedColorIdx = new Set();
  const slices = ordered.map(c => {
    let idx = colorIndexFor(c.id);
    for (let tries = 0; usedColorIdx.has(idx) && tries < PIE_COLOR_COUNT; tries++) {
      idx = (idx + 1) % PIE_COLOR_COUNT;
    }
    usedColorIdx.add(idx);
    return { ...c, colorVar: `var(--series-${idx + 1})` };
  });
  let angle = 0;
  for (const s of slices) {
    const sweep = (s.value / total) * 360;
    s.startAngle = angle;
    s.endAngle = angle + sweep;
    s.midAngle = angle + sweep / 2;
    angle += sweep;
  }
  return { total, slices };
}

function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 選んだスライスの縁から線を引いた先に、金額・割合を示す吹き出し(SVG上のrect+text)を描く
function calloutSvg(s, total) {
  const pct = Math.round((s.value / total) * 100);
  const edge = polarToCartesian(100, 100, 90, s.midAngle);
  const outer = polarToCartesian(100, 100, 112, s.midAngle);
  const isRight = outer.x >= 100;
  const boxW = 96, boxH = 34;
  let boxX = isRight ? outer.x + 6 : outer.x - boxW - 6;
  let boxY = outer.y - boxH / 2;
  boxX = Math.max(2, Math.min(200 - boxW - 2, boxX));
  boxY = Math.max(2, Math.min(200 - boxH - 2, boxY));
  const lineEndX = isRight ? boxX : boxX + boxW;
  const lineEndY = boxY + boxH / 2;
  const label = escapeAttr(`${s.icon || ''} ${s.name}`);
  const valueLabel = escapeAttr(`${yen(s.value)}(${pct}%)`);
  return `
    <g class="pie-callout">
      <line x1="${edge.x.toFixed(1)}" y1="${edge.y.toFixed(1)}" x2="${outer.x.toFixed(1)}" y2="${outer.y.toFixed(1)}" stroke="var(--text)" stroke-width="1.2" />
      <line x1="${outer.x.toFixed(1)}" y1="${outer.y.toFixed(1)}" x2="${lineEndX.toFixed(1)}" y2="${lineEndY.toFixed(1)}" stroke="var(--text)" stroke-width="1.2" />
      <circle cx="${edge.x.toFixed(1)}" cy="${edge.y.toFixed(1)}" r="2.5" fill="var(--text)" />
      <rect x="${boxX.toFixed(1)}" y="${boxY.toFixed(1)}" width="${boxW}" height="${boxH}" rx="6" fill="var(--card)" stroke="var(--border)" />
      <text x="${(boxX + boxW / 2).toFixed(1)}" y="${(boxY + 14).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="700" fill="var(--text)">${label}</text>
      <text x="${(boxX + boxW / 2).toFixed(1)}" y="${(boxY + 26).toFixed(1)}" text-anchor="middle" font-size="8.5" fill="var(--muted)">${valueLabel}</text>
    </g>
  `;
}

function pieSvg(slices, total, selectedName) {
  let paths = '';
  for (const s of slices) {
    const pct = Math.round((s.value / total) * 100);
    const isSel = selectedName != null && s.name === selectedName;
    const attrs = `data-pie-name="${escapeAttr(s.name)}" data-pie-icon="${escapeAttr(s.icon || '')}" data-pie-value="${s.value}" data-pie-pct="${pct}"`;
    const strokeW = isSel ? 3 : 2;
    const stroke = isSel ? 'var(--text)' : 'var(--chart-surface)';
    if (s.endAngle - s.startAngle >= 359.99) {
      paths += `<circle cx="100" cy="100" r="90" fill="${s.colorVar}" stroke="${stroke}" stroke-width="${strokeW}" ${attrs} />`;
    } else {
      paths += `<path d="${arcPath(100, 100, 90, s.startAngle, s.endAngle)}" fill="${s.colorVar}" stroke="${stroke}" stroke-width="${strokeW}" ${attrs} />`;
    }
  }
  let callout = '';
  if (selectedName != null) {
    const sel = slices.find(s => s.name === selectedName);
    if (sel) callout = calloutSvg(sel, total);
  }
  return `<svg class="pie" viewBox="0 0 200 200">${paths}${callout}</svg>`;
}

function pieLegendHtml(slices, total, selectedName) {
  return slices.map(s => {
    const pct = Math.round((s.value / total) * 100);
    const sel = selectedName != null && s.name === selectedName;
    return `
    <div class="legend-row ${sel ? 'selected' : ''}" data-pie-name="${escapeAttr(s.name)}" data-pie-icon="${escapeAttr(s.icon || '')}" data-pie-value="${s.value}" data-pie-pct="${pct}">
      <span class="swatch" style="background:${s.colorVar}"></span>
      <span class="legend-label">${s.icon} ${s.name}</span>
      <span class="legend-value">${yen(s.value)}<span class="legend-pct">(${pct}%)</span></span>
    </div>
  `;
  }).join('');
}

// タップした項目に線+吹き出しで詳細を表示する円グラフ一式(合計額の見出し+円グラフ本体+凡例)
function pieBlockHtml(built, chartId, selectedName) {
  if (!built) return '';
  return `
    <div class="pie-group" data-pie-chart="${chartId}">
      <div class="pie-total">合計 ${yen(built.total)}</div>
      ${pieSvg(built.slices, built.total, selectedName)}
      <div class="legend">${pieLegendHtml(built.slices, built.total, selectedName)}</div>
    </div>
  `;
}

function pieChartHtml(space, key, sharedFundSummary, selectedName) {
  const tops = Store.topLevel(space)
    .map(c => ({ id: c.id, name: c.name, icon: iconFor(c), order: c.order, value: Store.spentOf(space, key, c.id) }))
    .filter(c => c.value > 0);

  if (sharedFundSummary && sharedFundSummary.spent > 0) {
    tops.push({ id: '__sharedfund__', name: '同棲資金', icon: iconFor({ name: '同棲資金' }), order: -1, value: sharedFundSummary.spent });
  }

  const built = buildPieSlices(tops);
  if (!built) return '<div class="empty-note">まだ今月の支出がありません</div>';

  return pieBlockHtml(built, 'budget', selectedName);
}

function attentionListHtml(space, key) {
  const items = Store.leafCategories(space)
    .map(cat => ({ cat, status: Store.rawStatusOf(space, key, cat.id), remaining: Store.rawRemainingOf(space, key, cat.id) }))
    .filter(x => x.status !== 'ok')
    .sort((a, b) => a.remaining - b.remaining);
  if (items.length === 0) return '<div class="empty-note">今月は順調です 👍</div>';
  return items.map(x => `
    <div class="cat-row">
      <div class="row-top">
        <div class="name">${iconFor(x.cat)} ${x.cat.name} ${badgeHtml(x.status)}</div>
        <div class="nums"><b>${yen(x.remaining)}</b></div>
      </div>
    </div>
  `).join('');
}

// 「今月の予算」タブ = サマリー + 円グラフ + カテゴリ別横棒グラフ一覧
function budgetTabHtml(space, key, expanded, sharedFundSummary, pieSelected) {
  pieSelected = pieSelected || {};
  return `
    <div class="summary">${summaryHtml(space, key, sharedFundSummary)}</div>
    <div class="section-title">カテゴリ別支出</div>
    <div class="card chart-card">${pieChartHtml(space, key, sharedFundSummary, pieSelected.budget)}</div>
    <div class="section-title">要注意の項目</div>
    ${attentionListHtml(space, key)}
    ${catListHtml(space, key, expanded, sharedFundSummary)}
  `;
}

// 各項目の「繰越金」「今月の予算の余り」を太字見出し(合計つき・開閉可能)+それぞれ専用の円グラフ+
// 細線区切りの一覧にする。株式投資は資産合計に含めないため、ここでも表示しない。
function assetBreakdownHtml(space, key, assetExpanded, pieSelected) {
  assetExpanded = assetExpanded || { carried: true, remaining: true };
  pieSelected = pieSelected || {};
  const month = space.months[key];
  const stockId = Store.findLeafByName(space, '株式投資');
  // 固定引き落としの項目は通常繰越金を持たないが、万一繰越金があれば除外せずグラフに出す
  // (今月の予算の余りは固定引き落としなら常に0になるため、自動的に表示対象から外れる)
  const leaves = Store.leafCategories(space).filter(c => c.id !== stockId);
  const carriedRows = leaves.map(c => ({ cat: c, amount: (month.carriedIn[c.id]) || 0 })).filter(x => x.amount !== 0);
  // 繰越金(上の行)と二重計上しないよう、今月の予算の余りは繰越を含まない「今月分のみ」で見る
  const remainingRows = leaves.map(c => ({ cat: c, amount: Store.rawRemainingOf(space, key, c.id) })).filter(x => x.amount !== 0);
  const carriedTotal = carriedRows.reduce((s, x) => s + x.amount, 0);
  const remainingTotal = remainingRows.reduce((s, x) => s + x.amount, 0);
  const piePart = (rows, chartId) => {
    const items = rows.filter(x => x.amount > 0).map(x => ({ id: x.cat.id, name: x.cat.name, icon: iconFor(x.cat), order: x.cat.order, value: x.amount }));
    const built = buildPieSlices(items);
    return built ? `<div class="card chart-card">${pieBlockHtml(built, chartId, pieSelected[chartId])}</div>` : '';
  };
  const groupHtml = (toggleKey, title, total, rows, expanded) => `
    <div class="asset-group-title" data-assettoggle="${toggleKey}">
      <span>${chevronHtml(expanded)} ${title}</span>
      <b>${yen(total)}</b>
    </div>
    ${expanded ? (rows.length ? piePart(rows, toggleKey) : '<div class="empty-note">まだありません</div>') : ''}
  `;
  return `
    ${groupHtml('remaining', '今月の予算の余り', remainingTotal, remainingRows, assetExpanded.remaining)}
    ${groupHtml('carried', '繰越金', carriedTotal, carriedRows, assetExpanded.carried)}
    <div class="asset-group-title asset-grand-total"><span>合計</span><b>${yen(carriedTotal + remainingTotal)}</b></div>
  `;
}

function assetsHtml(space, key, data, assetExpanded, pieSelected) {
  const month = space.months[key];
  const isPersonalType = space !== data.spaces.shared;
  const sharedShare = !isPersonalType ? 0
    : (space === data.spaces.partner ? Store.partnerSharedShare(data) : Store.personalSharedShare(data));
  const allocated = Store.totalLeafBudget(space) + sharedShare;
  const pending = month.income - allocated;

  const spaceTotal = Store.totalAssets(space);

  const unresolved = space.unresolvedBackfills || [];
  const unresolvedTotal = unresolved.reduce((s, bf) => s + bf.amount, 0);
  const unresolvedWarning = unresolved.length ? `
    <div class="warning-banner">
      ⚠️ 現金貯蓄から一時的に補填したまま未解決の分が${yen(unresolvedTotal)}あります。
      設定→予算設定から「配分し直す」を行ってください。
    </div>
  ` : '';

  return `
    ${unresolvedWarning}
    <div class="summary">
      <div class="card wide">
        <div><div class="label">合計(今月の予算の余り＋繰越金)</div><div class="value">${yen(spaceTotal)}</div></div>
      </div>
    </div>
    <button class="btn secondary" id="editTotalBtn">現在の合計金額を修正</button>
    <div class="allocation-box" style="margin-top:12px">
      <div class="row"><span>今月の収入</span><span>${yen(month.income)}</span></div>
      <div class="row"><span>カテゴリ配分合計${isPersonalType ? '(同棲資金の負担分込み)' : ''}</span><span>${yen(allocated)}</span></div>
      <div class="row"><span>今月の繰越見込み(月末確定)</span><span class="${pending < 0 ? 'over-note' : ''}">${yen(pending)}</span></div>
    </div>
    <div class="section-title">内訳</div>
    ${assetBreakdownHtml(space, key, assetExpanded, pieSelected)}
  `;
}

// --- 電卓式キーパッド ---
function keypadHtml(digits) {
  const display = yen(Number(digits || '0'));
  return `
    <div class="amount-display" id="amountDisplay">${display}</div>
    <div class="keypad">
      <button data-key="7">7</button><button data-key="8">8</button><button data-key="9">9</button>
      <button data-key="4">4</button><button data-key="5">5</button><button data-key="6">6</button>
      <button data-key="1">1</button><button data-key="2">2</button><button data-key="3">3</button>
      <button class="key-util" data-key="clear">C</button><button data-key="0">0</button><button class="key-util" data-key="del">⌫</button>
    </div>
  `;
}

function typeToggleHtml(type) {
  return `
    <div class="pill-toggle" id="typeToggle">
      <button class="pill ${type === 'expense' ? 'active' : ''}" data-type="expense">支出</button>
      <button class="pill ${type === 'income' ? 'active' : ''}" data-type="income">収入</button>
    </div>
  `;
}

function payerToggleHtml(payer) {
  return `
    <div class="pill-toggle" id="payerToggle">
      <button class="pill ${payer === 'self' ? 'active' : ''}" data-payer="self">🧑 自分</button>
      <button class="pill ${payer === 'partner' ? 'active' : ''}" data-payer="partner">👩 パートナー</button>
    </div>
  `;
}

// --- 収支カレンダー ---

function calendarHtml(space, key) {
  const [y, m] = key.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const startWeekday = first.getDay();
  const todayStr = new Date().toISOString().slice(0, 10);

  let cells = '';
  for (let i = 0; i < startWeekday; i++) cells += '<div class="cal-cell empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const t = Store.dayTotals(space, key, dateStr);
    const isToday = dateStr === todayStr;
    cells += `
      <div class="cal-cell ${isToday ? 'today' : ''}" data-date="${dateStr}">
        <div class="cal-day">${d}</div>
        ${t.expense > 0 ? `<div class="cal-expense">-${yen(t.expense)}</div>` : ''}
        ${t.income > 0 ? `<div class="cal-income">+${yen(t.income)}</div>` : ''}
      </div>
    `;
  }

  return `
    <div class="cal-weekdays">
      <div>日</div><div>月</div><div>火</div><div>水</div><div>木</div><div>金</div><div>土</div>
    </div>
    <div class="cal-grid">${cells}</div>
    <div class="cal-legend">
      <span><span class="dot expense-dot"></span>支出</span>
      <span><span class="dot income-dot"></span>収入</span>
    </div>
  `;
}

// 登録順(新しい順)の収支履歴一覧。タップで編集できる(main.js側で処理)。
function historyListHtml(space, monthKey_, categoryLookup) {
  const txs = Store.transactionsInMonth(space, monthKey_).slice().reverse();
  if (txs.length === 0) return '<div class="empty-note">この月の記録はありません</div>';
  return txs.map(t => {
    const cat = t.type === 'income' ? null : categoryLookup(t.catId);
    const label = t.type === 'income' ? '💰 収入' : (cat ? `${iconFor(cat)} ${cat.name}` : '(削除された項目)');
    const payerTag = t.payer ? (t.payer === 'self' ? '🧑自分' : '👩パートナー') : '';
    return `
      <div class="tx-item" data-tx="${t.id}">
        <span>${t.date} ${label}${t.memo ? '・' + t.memo : ''}${payerTag ? '・' + payerTag : ''}</span>
        <span class="${t.type === 'income' ? 'tx-income' : ''}">${t.type === 'income' ? '+' : '-'}${yen(t.amount)}</span>
      </div>
    `;
  }).join('');
}

// 月末の精算内訳(予算超過分がどこからどう補填されたか・食費の黒字が旅行積立金に回った分)。
// その月を締めた時だけ記録がある。
function settlementHtml(space, monthKey_, categoryLookup) {
  const settlement = Store.settlementOf(space, monthKey_);
  if (!settlement) return '';
  const deficits = settlement.deficit.filter(d => d.amount > 0.5);
  const travelRows = settlement.slack.filter(s => s.toTravelSaving > 0.5);
  if (deficits.length === 0 && travelRows.length === 0) return '';

  const nameOf = (catId) => {
    const cat = categoryLookup(catId);
    return cat ? `${iconFor(cat)} ${cat.name}` : '(削除された項目)';
  };

  const deficitRows = deficits.map(d => {
    const parts = [];
    if (d.coveredByGroupPool > 0.5) parts.push(`同じグループの兄弟項目の余りから${yen(d.coveredByGroupPool)}`);
    if (d.usedOwnCarry > 0.5) parts.push(`自分の繰越金から${yen(d.usedOwnCarry)}`);
    if (d.coveredBySiblingCarry > 0.5) parts.push(`同じグループの兄弟項目の繰越金から${yen(d.coveredBySiblingCarry)}`);
    if (d.coveredByFreeBudget > 0.5) parts.push(`自由予算の余りから${yen(d.coveredByFreeBudget)}`);
    if (d.coveredByPool > 0.5) parts.push(`今月の他項目の余り(全体プール)から${yen(d.coveredByPool)}`);
    if (d.coveredByFreeBudgetCarry > 0.5) parts.push(`自由予算の繰越金から${yen(d.coveredByFreeBudgetCarry)}`);
    if (d.reserveUsed > 0.5) parts.push(`現金貯蓄(予備費)から一時的に${yen(d.reserveUsed)}`);
    return `
      <div class="settlement-row">
        <div class="settlement-head"><span>${nameOf(d.catId)}</span><span class="over-note">${yen(d.amount)}超過</span></div>
        <div class="settlement-detail">${parts.join(' / ')}</div>
      </div>
    `;
  }).join('');

  const groupPoolRows = (settlement.groupPools || []).filter(g => g.used > 0.5).map(g => `
    <div class="settlement-row">
      <div class="settlement-head"><span>${g.parentName || '(グループ)'}内での兄弟補填</span><span>${yen(g.used)}</span></div>
      <div class="settlement-detail">グループ内の黒字項目でまず埋め合わせます</div>
    </div>
  `).join('');

  const freeBudgetRow = (settlement.freeBudgetUsed > 0.5) ? `
    <div class="settlement-row">
      <div class="settlement-head"><span>${nameOf(settlement.freeBudgetId)}の余りからの優先補填</span><span>${yen(settlement.freeBudgetUsed)}</span></div>
      <div class="settlement-detail">空間全体のプールより先に、自由予算の今月分の余りから補填しています</div>
    </div>
  ` : '';

  const freeBudgetCarryRow = (settlement.freeBudgetCarryUsed > 0.5) ? `
    <div class="settlement-row">
      <div class="settlement-head"><span>${nameOf(settlement.freeBudgetId)}の繰越金からの優先補填</span><span>${yen(settlement.freeBudgetCarryUsed)}</span></div>
      <div class="settlement-detail">自由予算の今月分の余りでも埋まらなかった分を、自由予算の繰越金から補填しています(現金貯蓄より先)</div>
    </div>
  ` : '';

  const poolSources = settlement.slack.filter(s => s.usedByPool > 0.5);
  const poolSourceHtml = poolSources.length ? `
    <div class="settlement-row">
      <div class="settlement-head"><span>全体プールの出どころ</span><span>${yen(settlement.poolUsed)}</span></div>
      <div class="settlement-detail">${poolSources.map(s => `${nameOf(s.catId)}の余りから${yen(s.usedByPool)}`).join(' / ')}</div>
    </div>
  ` : '';

  const siblingCarrySources = settlement.slack.filter(s => s.givenToSiblingCarry > 0.5);
  const siblingCarryHtml = siblingCarrySources.length ? `
    <div class="settlement-row">
      <div class="settlement-head"><span>兄弟の繰越金の出どころ</span></div>
      <div class="settlement-detail">${siblingCarrySources.map(s => `${nameOf(s.catId)}の繰越金から${yen(s.givenToSiblingCarry)}`).join(' / ')}</div>
    </div>
  ` : '';

  const travelHtml = travelRows.length ? `
    <div class="settlement-row">
      <div class="settlement-head"><span>食費の黒字→旅行積立金</span></div>
      <div class="settlement-detail">${travelRows.map(s => `${nameOf(s.catId)}の余りの半分、${yen(s.toTravelSaving)}を旅行積立金へ`).join(' / ')}</div>
    </div>
  ` : '';

  const hintChain = settlement.freeBudgetId
    ? '同じグループの兄弟項目→自分の繰越金→兄弟項目の繰越金→自由予算の余り→全体プール→自由予算の繰越金→現金貯蓄(予備費)の順で補填しています。'
    : '同じグループの兄弟項目→自分の繰越金→兄弟項目の繰越金→全体プール→現金貯蓄(予備費)の順で補填しています。';

  const deficitSection = deficits.length ? `
    <div class="section-title">予算超過分の補填内訳</div>
    <div class="hint">${hintChain}</div>
    ${groupPoolRows}
    ${deficitRows}
    ${siblingCarryHtml}
    ${freeBudgetRow}
    ${poolSourceHtml}
    ${freeBudgetCarryRow}
  ` : '';

  return `
    ${deficitSection}
    ${travelHtml}
  `;
}

// 「収支履歴」タブ = 月送りカレンダー + その月の履歴一覧
function calendarTabHtml(space, monthKey_, categoryLookup) {
  return `
    <div class="cal-nav">
      <button class="nav-btn" id="calPrev">‹</button>
      <div class="cal-month-label">${monthKey_}</div>
      <button class="nav-btn" id="calNext">›</button>
    </div>
    ${calendarHtml(space, monthKey_)}
    ${settlementHtml(space, monthKey_, categoryLookup)}
    <div class="section-title">履歴</div>
    ${historyListHtml(space, monthKey_, categoryLookup)}
  `;
}

function dayDetailHtml(space, key, dateStr, categoryLookup) {
  const txs = Store.transactionsOnDay(space, key, dateStr);
  const rows = txs.map(t => {
    const cat = t.type === 'income' ? null : categoryLookup(t.catId);
    const label = t.type === 'income' ? '💰 収入' : `${cat ? iconFor(cat) + ' ' + cat.name : ''}`;
    const payerTag = t.payer ? (t.payer === 'self' ? '🧑 自分' : '👩 パートナー') : '';
    return `
      <div class="tx-item">
        <span>${label} ${t.memo ? '・' + t.memo : ''} ${payerTag ? '・' + payerTag : ''}</span>
        <span class="${t.type === 'income' ? '' : ''}">${t.type === 'income' ? '+' : '-'}${yen(t.amount)}</span>
      </div>
    `;
  }).join('') || '<div class="tx-item">この日の記録はありません</div>';

  return `<h2>${dateStr}</h2>${rows}`;
}

window.UI = {
  yen, iconFor, badgeHtml, autoBadgeHtml, barHtml, chevronHtml, summaryHtml, catRowHtml, catListHtml,
  catPickerTopHtml, catPickerChildHtml, catPickerOtherHtml, keypadHtml, typeToggleHtml, payerToggleHtml,
  pieChartHtml, attentionListHtml, budgetTabHtml, assetsHtml, calendarHtml, calendarTabHtml,
  historyListHtml, dayDetailHtml,
};
