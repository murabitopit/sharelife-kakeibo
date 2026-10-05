// データモデル & 永続化(localStorage) & 予算計算ロジック
// 次段階でFirestoreに差し替える前提で、永続化部分(load/save)だけ分離している。
//
// 同棲資金について:
// 「家賃・車両費・食費・日用品・水道光熱費・車」は2人で共有する費用のため、
// それらのカテゴリ(combined=2人分の合計金額)は同棲スペース(shared)側だけに実体として持たせる。
// 個人スペース(personal)側では、そこから自分の負担割合(ratioSelf)だけを自動的に
// 引き落とされるものとして「同棲資金」1行にまとめて表示する(内訳はui.js側で合成)。

const STORAGE_KEY = 'kakeibo_v2';

function monthKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function addMonths(key, diff) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + diff, 1);
  return monthKey(d);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 🧑自分個人のデフォルト予算額・固定引き落とし設定
// (data.settings.defaultTemplate.personal と同じ内容。開発用タブから編集・再適用できる)
function defaultSelfBudgets() {
  return {
    '保険料': { budget: 5000, auto: true },
    '奨学金返済': { budget: 30000, auto: true },
    '通信費': { budget: 5000, auto: true },
    '公共交通機関': { budget: 2000, auto: false },
    '美容・衣服': { budget: 10000, auto: false },
    '交際費': { budget: 12000, auto: false },
    'サブスク': { budget: 2000, auto: true },
    '自由予算': { budget: 20000, auto: false },
    '株式投資': { budget: 30000, auto: true },
  };
}

// 👩彼女個人のデフォルト予算額・固定引き落とし設定(奨学金返済なし)
// (data.settings.defaultTemplate.partner と同じ内容。開発用タブから編集・再適用できる)
function defaultPartnerBudgets() {
  return {
    '保険料': { budget: 5000, auto: true },
    '通信費': { budget: 5000, auto: true },
    '公共交通機関': { budget: 2000, auto: false },
    '美容・衣服': { budget: 15000, auto: false },
    '交際費': { budget: 12000, auto: false },
    'サブスク': { budget: 2000, auto: true },
    '自由予算': { budget: 15000, auto: false },
    '株式投資': { budget: 30000, auto: true },
  };
}

// 開発用タブで編集できるデフォルトの月収入(🧑自分・👩彼女それぞれ)
function defaultIncomeTemplate() {
  return { personal: 0, partner: 0 };
}

// 同棲資金のデフォルト予算額・固定引き落とし設定(2人分の合計金額)
function defaultSharedBudgets() {
  return {
    '家賃': { budget: 85000, auto: true },
    '駐車場': { budget: 8000, auto: true },
    '車検用積立金': { budget: 5000, auto: true },
    '自動車税積立金': { budget: 1000, auto: true },
    '自動車保険積立金': { budget: 13000, auto: true },
    '自炊': { budget: 40000, auto: false },
    '外食': { budget: 20000, auto: false },
    '日用品': { budget: 15000, auto: false },
    'ガス': { budget: 8000, auto: false },
    '電気': { budget: 10000, auto: false },
    '水道': { budget: 5000, auto: false },
    '交通費(車のガソリン代)': { budget: 10000, auto: false },
  };
}

function defaultBudgetTemplate() {
  return {
    personal: defaultSelfBudgets(),
    partner: defaultPartnerBudgets(),
    shared: defaultSharedBudgets(),
    income: defaultIncomeTemplate(),
  };
}

// 🧑自分個人のカテゴリ構成(奨学金返済あり)
function defaultSelfCategories() {
  const cats = [];
  let order = 0;
  const tmpl = defaultSelfBudgets();
  function add(name, section, parentId) {
    const id = uid();
    const t = tmpl[name];
    cats.push({ id, name, section, parentId: parentId || null, budget: (t && t.budget) || 0, auto: !!(t && t.auto), order: order++ });
    return id;
  }

  // 固定費
  add('保険料', 'fixed', null);
  add('奨学金返済', 'fixed', null);

  // 変動費
  add('通信費', 'variable', null);
  const transport = add('交通費', 'variable', null);
  add('公共交通機関', 'variable', transport);
  add('美容・衣服', 'variable', null);
  add('交際費', 'variable', null);
  add('サブスク', 'variable', null);
  add('自由予算', 'variable', null);
  const savings = add('積立金', 'savings', null);
  add('株式投資', 'savings', savings);
  add('現金預金', 'savings', savings); // 予算を設定しない特別枠(余り金の繰越先)

  return cats;
}

// 👩彼女個人のカテゴリ構成(奨学金返済なし)
function defaultPartnerCategories() {
  const cats = [];
  let order = 0;
  const tmpl = defaultPartnerBudgets();
  function add(name, section, parentId) {
    const id = uid();
    const t = tmpl[name];
    cats.push({ id, name, section, parentId: parentId || null, budget: (t && t.budget) || 0, auto: !!(t && t.auto), order: order++ });
    return id;
  }

  // 固定費
  add('保険料', 'fixed', null);

  // 変動費
  add('通信費', 'variable', null);
  const transport = add('交通費', 'variable', null);
  add('公共交通機関', 'variable', transport);
  add('美容・衣服', 'variable', null);
  add('交際費', 'variable', null);
  add('サブスク', 'variable', null);
  add('自由予算', 'variable', null);
  const savings = add('積立金', 'savings', null);
  add('株式投資', 'savings', savings);
  add('現金預金', 'savings', savings); // 予算を設定しない特別枠(余り金の繰越先)

  return cats;
}

// 同棲資金(2人分の合計金額で予算を設定するカテゴリ群)
function defaultSharedCategories() {
  const cats = [];
  let order = 0;
  const tmpl = defaultSharedBudgets();
  function add(name, section, parentId) {
    const id = uid();
    const t = tmpl[name];
    cats.push({ id, name, section, parentId: parentId || null, budget: (t && t.budget) || 0, auto: !!(t && t.auto), order: order++ });
    return id;
  }

  add('家賃', 'fixed', null);
  const vehicle = add('車両費', 'fixed', null);
  add('駐車場', 'fixed', vehicle);
  add('車検用積立金', 'fixed', vehicle);
  add('自動車税積立金', 'fixed', vehicle);
  add('自動車保険積立金', 'fixed', vehicle);

  const food = add('食費', 'variable', null);
  add('自炊', 'variable', food);
  add('外食', 'variable', food);
  add('日用品', 'variable', null);
  const utility = add('水道光熱費', 'variable', null);
  add('ガス', 'variable', utility);
  add('電気', 'variable', utility);
  add('水道', 'variable', utility);
  add('交通費(車のガソリン代)', 'variable', null);
  add('旅行積立金', 'savings', null); // 予算を設定しない特別枠(同棲側の余り金の繰越先)

  return cats;
}

// 過去バージョンのカテゴリ名を新名称へ軽く移行する(「とりあえず」運用中のための簡易対応)
function migrateCategoryNames(data) {
  const renameTop = (space, oldName, newName) => {
    const cat = space.categories.find(c => c.name === oldName && !c.parentId);
    if (cat) cat.name = newName;
  };
  renameTop(data.spaces.shared, '車', '交通費(車のガソリン代)');
  const vehicleChildRename = (space) => {
    const old = space.categories.find(c => c.name === '自動車保険');
    if (old) old.name = '自動車保険積立金';
  };
  vehicleChildRename(data.spaces.shared);
  // 彼女用の個人スペースが無い古いデータへの追加(3スペース構成への移行)
  if (!data.spaces.partner) {
    data.spaces.partner = newSpace('partner');
  }
  for (const key of ['personal', 'partner', 'shared']) {
    const sp = data.spaces[key];
    if (sp && !sp.unresolvedBackfills) sp.unresolvedBackfills = [];
  }
  if (!data.settings.lock) {
    data.settings.lock = { personal: null, partner: null };
  }
  if (!data.settings.defaultTemplate) {
    data.settings.defaultTemplate = defaultBudgetTemplate();
  }
  if (!data.settings.defaultTemplate.income) {
    data.settings.defaultTemplate.income = defaultIncomeTemplate();
  }
  if (!data.settings.defaultTemplate.partner) {
    data.settings.defaultTemplate.partner = defaultPartnerBudgets();
  }
  // 既存の保存データに残っているdefaultTemplateは、後から追加した項目(美容・衣服など)を
  // 持っていないことがあるので、コード側の最新デフォルトにある項目のうち無いものだけ補う
  // (既にユーザーが編集済みの値は上書きしない)
  const canonical = defaultBudgetTemplate();
  for (const key of ['personal', 'partner', 'shared']) {
    const tmplMap = data.settings.defaultTemplate[key];
    const canonicalMap = canonical[key];
    for (const name of Object.keys(canonicalMap)) {
      if (!tmplMap[name]) tmplMap[name] = canonicalMap[name];
    }
  }
  // 同棲側に旅行積立金(見える繰越先)が無い古いデータへの追加
  const shared = data.spaces.shared;
  if (shared && !shared.categories.some(c => c.name === '旅行積立金')) {
    const order = Math.max(0, ...shared.categories.map(c => c.order)) + 1;
    shared.categories.push({ id: uid(), name: '旅行積立金', section: 'savings', parentId: null, budget: 0, order });
  }
  // 自分・彼女双方に「美容・衣服」が無い古いデータへの追加(それぞれのデフォルト予算額を使う)
  const beautyBudgets = { personal: defaultSelfBudgets()['美容・衣服'], partner: defaultPartnerBudgets()['美容・衣服'] };
  for (const key of ['personal', 'partner']) {
    const sp = data.spaces[key];
    if (sp && !sp.categories.some(c => c.name === '美容・衣服')) {
      const order = Math.max(0, ...sp.categories.map(c => c.order)) + 1;
      const t = beautyBudgets[key];
      sp.categories.push({ id: uid(), name: '美容・衣服', section: 'variable', parentId: null, budget: (t && t.budget) || 0, auto: !!(t && t.auto), order });
    }
  }
}

// 兄弟カテゴリ(同じ親を持つカテゴリ群)の並び順を、渡されたid配列の順番通りに一括更新する
// (ドラッグによる並び替えの確定時に使う。他の親グループの並び順には影響しない)
function reorderSiblings(space, orderedIds) {
  orderedIds.forEach((id, i) => {
    const cat = space.categories.find(c => c.id === id);
    if (cat) cat.order = i;
  });
}

// data.settings.defaultTemplateの内容を、personal/partner/shared各空間の
// 同名カテゴリに適用する(budget・auto固定引き落としフラグのみ。取引や収入・繰越は変更しない)
function applyDefaultTemplate(data) {
  const tmpl = data.settings.defaultTemplate || defaultBudgetTemplate();
  const applyTo = (space, map) => {
    for (const cat of space.categories) {
      const t = map[cat.name];
      if (t) {
        cat.budget = t.budget || 0;
        cat.auto = !!t.auto;
      }
    }
  };
  applyTo(data.spaces.personal, tmpl.personal);
  applyTo(data.spaces.partner, tmpl.partner);
  applyTo(data.spaces.shared, tmpl.shared);
}

// 指定空間の「金額」(今月の収入・取引・繰越・予備費・未解決の貯蓄補填)を、
// カテゴリ構成はそのままに初期状態へ戻す(テスト用)。incomeを渡すと今月の収入の初期値にする。
function resetSpaceAmounts(space, income) {
  space.reserve.balance = 0;
  space.unresolvedBackfills = [];
  space.currentMonth = monthKey(new Date());
  space.months = { [space.currentMonth]: emptyMonth(income || 0) };
}

function newSpace(kind) {
  const generators = { shared: defaultSharedCategories, partner: defaultPartnerCategories, personal: defaultSelfCategories };
  return {
    categories: (generators[kind] || defaultSelfCategories)(),
    reserve: { balance: 0 },
    currentMonth: monthKey(new Date()),
    months: {},
    unresolvedBackfills: [],
  };
}

function defaultData() {
  return {
    settings: {
      ratioSelf: 0.6, // 同棲資金のうち自分(🧑)が負担する割合。彼女(👩)の割合は1-ratioSelf
      defaultTemplate: defaultBudgetTemplate(), // 開発用タブで編集・再適用できるデフォルト予算額
      lock: { personal: null, partner: null }, // 個人タブの画面ロック設定(PIN/Face ID)。同棲タブは対象外
    },
    spaces: {
      personal: newSpace('personal'), // 🧑自分
      partner: newSpace('partner'),   // 👩彼女
      shared: newSpace('shared'),     // 🤝同棲
    },
  };
}

function emptyMonth(prevIncome) {
  return {
    income: prevIncome || 0,
    carriedIn: {},
    transactions: [],
    closed: false,
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultData();
    return JSON.parse(raw);
  } catch (e) {
    console.error('load failed', e);
    return defaultData();
  }
}

function save(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function resetAll() {
  localStorage.removeItem(STORAGE_KEY);
}

// --- 計算ロジック ---

function leafCategories(space) {
  const childIds = new Set(space.categories.filter(c => c.parentId).map(c => c.parentId));
  return space.categories.filter(c => !childIds.has(c.id));
}

function isGroup(space, catId) {
  return space.categories.some(c => c.parentId === catId);
}

function children(space, catId) {
  return space.categories.filter(c => c.parentId === catId);
}

function topLevel(space) {
  return space.categories.filter(c => !c.parentId);
}

// 指定月・指定カテゴリの支出合計(リーフのみ直接、グループは子の合計)
// 自動引き落とし(cat.auto)のカテゴリは毎月必ず予算どおり使い切る前提にする
// 収入として記録した取引(type==='income')は支出集計に含めない
function spentOf(space, monthKey_, catId) {
  const month = space.months[monthKey_];
  if (!month) return 0;
  if (isGroup(space, catId)) {
    return children(space, catId).reduce((s, c) => s + spentOf(space, monthKey_, c.id), 0);
  }
  const cat = space.categories.find(c => c.id === catId);
  if (cat && cat.auto) return cat.budget || 0;
  return month.transactions
    .filter(t => t.catId === catId && t.type !== 'income')
    .reduce((s, t) => s + t.amount, 0);
}

// 自動引き落としのカテゴリは繰越(貯まる)の対象外なので、carriedInを無視して予算そのものを返す
function effectiveBudgetOf(space, monthKey_, catId) {
  const month = space.months[monthKey_];
  const cat = space.categories.find(c => c.id === catId);
  if (isGroup(space, catId)) {
    return children(space, catId).reduce((s, c) => s + effectiveBudgetOf(space, monthKey_, c.id), 0);
  }
  if (cat && cat.auto) return cat.budget || 0;
  const carried = (month && month.carriedIn[catId]) || 0;
  return (cat.budget || 0) + carried;
}

function remainingOf(space, monthKey_, catId) {
  return effectiveBudgetOf(space, monthKey_, catId) - spentOf(space, monthKey_, catId);
}

// リーフ自身、またはグループの子カテゴリが全て固定引き落としかどうか
// (全て固定引き落としのグループは「使い切って当然」なので節約表示の対象外にする)
function allAuto(space, catId) {
  if (!isGroup(space, catId)) {
    const cat = space.categories.find(c => c.id === catId);
    return !!(cat && cat.auto);
  }
  return children(space, catId).every(c => allAuto(space, c.id));
}

// 節約マークの判定(実際の資金繰り用。繰越を含めた「実質の残り」で判定): 'over'(貯蓄から補填) | 'warning'(余裕が少ない) | 'ok'
function statusOf(space, monthKey_, catId) {
  if (allAuto(space, catId)) return 'ok';
  const budget = effectiveBudgetOf(space, monthKey_, catId);
  const remaining = remainingOf(space, monthKey_, catId);
  if (remaining < 0) return 'over';
  if (budget > 0 && remaining / budget <= 0.15) return 'warning';
  return 'ok';
}

// 表示用:繰越を含めない「今月設定した予算」そのもの(今月実際に使いすぎているかどうかを見るため)
function rawBudgetOf(space, catId) {
  if (isGroup(space, catId)) {
    return children(space, catId).reduce((s, c) => s + rawBudgetOf(space, c.id), 0);
  }
  const cat = space.categories.find(c => c.id === catId);
  return cat ? (cat.budget || 0) : 0;
}

function rawRemainingOf(space, monthKey_, catId) {
  return rawBudgetOf(space, catId) - spentOf(space, monthKey_, catId);
}

// 表示用の節約マーク判定(繰越を含めない「今月の予算」だけで判定する版)
function rawStatusOf(space, monthKey_, catId) {
  if (allAuto(space, catId)) return 'ok';
  const budget = rawBudgetOf(space, catId);
  const remaining = rawRemainingOf(space, monthKey_, catId);
  if (remaining < 0) return 'over';
  if (budget > 0 && remaining / budget <= 0.15) return 'warning';
  return 'ok';
}

// 月末の余り金の繰越先となるカテゴリのid(現金預金 優先。無ければ同棲側の旅行積立金)。
// どちらも無ければnull(その場合は従来通り見えない予備費に保持する)。
function leftoverTargetId(space) {
  return findLeafByName(space, '現金預金') || findLeafByName(space, '旅行積立金');
}

// 余り金の繰越先(現金預金/旅行積立金)を除いた各リーフの予算合計。
// それらは「予算を設定する枠」ではなく月末の余り金の繰越先そのものなので、配分合計には含めない。
function totalLeafBudget(space) {
  const targetId = leftoverTargetId(space);
  return leafCategories(space).reduce((s, c) => (c.id === targetId ? s : s + (c.budget || 0)), 0);
}

function findLeafByName(space, name) {
  const cat = space.categories.find(c => c.name === name && !isGroup(space, c.id));
  return cat ? cat.id : null;
}

function totals(space, monthKey_) {
  const month = space.months[monthKey_];
  const tops = topLevel(space);
  const budget = tops.reduce((s, c) => s + effectiveBudgetOf(space, monthKey_, c.id), 0);
  const spent = tops.reduce((s, c) => s + spentOf(space, monthKey_, c.id), 0);
  return {
    income: (month && month.income) || 0,
    budget,
    spent,
    remaining: budget - spent,
  };
}

// その空間が現在保有している実質資産
// = 現金貯蓄(予備費) + 各カテゴリの繰越残高(繰越金) + 各カテゴリの今月まだ使っていない予算(今月の予算の余り)
// 今月分はまだ現金預金等へ繰越されていないだけで、使っていなければ手元にあるお金なので資産に含める。
// 株式投資は(市場価値と拠出額が一致しないため)資産合計には含めない
function totalAssets(space) {
  const key = space.currentMonth;
  const stockId = findLeafByName(space, '株式投資');
  let sum = space.reserve.balance;
  for (const c of leafCategories(space)) {
    if (c.id === stockId) continue;
    sum += (space.months[key].carriedIn[c.id]) || 0;
    sum += rawRemainingOf(space, key, c.id);
  }
  return sum;
}

// 同棲資金(shared側カテゴリ予算)の合計 = 2人分の合計金額 = 同棲スペースの収入相当
function sharedFundTotal(data) {
  return totalLeafBudget(data.spaces.shared);
}

// 自分(🧑)の負担額(同棲資金の合計 × 自分の割合)
function personalSharedShare(data) {
  return sharedFundTotal(data) * data.settings.ratioSelf;
}

// 彼女(👩)の負担額(同棲資金の合計 × (1-自分の割合))
function partnerSharedShare(data) {
  return sharedFundTotal(data) * (1 - data.settings.ratioSelf);
}

// 同棲スペースの当月収入を同棲資金合計に同期する(予算を編集するたびに呼ぶ)
function syncSharedIncome(data) {
  const sp = data.spaces.shared;
  const m = sp.months[sp.currentMonth];
  if (m) m.income = sharedFundTotal(data);
}

// 指定日の支出合計・収入合計(収支カレンダー用)
function dayTotals(space, monthKey_, dateStr) {
  const month = space.months[monthKey_];
  if (!month) return { expense: 0, income: 0 };
  let expense = 0;
  let income = 0;
  for (const t of month.transactions) {
    if (t.date !== dateStr) continue;
    if (t.type === 'income') income += t.amount;
    else expense += t.amount;
  }
  return { expense, income };
}

function transactionsOnDay(space, monthKey_, dateStr) {
  const month = space.months[monthKey_];
  if (!month) return [];
  return month.transactions.filter(t => t.date === dateStr);
}

// 指定月の全取引(収支履歴タブ用)
function transactionsInMonth(space, monthKey_) {
  const month = space.months[monthKey_];
  return month ? month.transactions : [];
}

// 指定月の精算内訳(予算超過分がどこから補填されたか)。月を締めた時にcloseMonthが記録する。
// 締めていない月(今月など)はまだ存在しないのでnull。
function settlementOf(space, monthKey_) {
  const month = space.months[monthKey_];
  return (month && month.settlement) || null;
}

// レポート用:自分・彼女・同棲のいずれかに記録がある月のキーを全て集め、新しい月が先頭になるよう降順で返す
function allMonthKeys(data) {
  const set = new Set();
  for (const spKey of ['personal', 'partner', 'shared']) {
    const sp = data.spaces[spKey];
    if (!sp) continue;
    for (const mk of Object.keys(sp.months)) set.add(mk);
  }
  return Array.from(set).sort().reverse();
}

// レポート用:指定月のトップレベルカテゴリ別支出(0円は除く)。円グラフ・表に使う。
function categorySpendBreakdown(space, monthKey_) {
  if (!space.months[monthKey_]) return [];
  return topLevel(space)
    .map(c => ({ id: c.id, name: c.name, value: spentOf(space, monthKey_, c.id) }))
    .filter(x => x.value > 0);
}

// 当月を締めて翌月へ繰越
// 1) 各カテゴリの黒字/赤字を「貯蓄補填の優先順位」で解決する(自動引き落としは対象外):
//    ①-a     同じ親カテゴリを持つ兄弟の今月分の黒字を優先して赤字に充てる(例:自炊が赤字なら外食の黒字を優先して使う)
//    ①       それでも足りなければ、そのカテゴリ自身の繰越残高から補填
//    ①       それでも足りなければ、同じ親カテゴリを持つ兄弟の繰越残高から優先して補填
//    ①-free   それでも足りなければ、「自由予算」の今月分の黒字があればそれを優先して充てる(無い空間では何もしない)
//    ①-b     それでも足りなければ、空間全体の今月分の黒字(他カテゴリの今月分の余り)から補填
//    ②''free  それでも足りなければ、「自由予算」の繰越残高があればそれを優先して充てる(無い/使い切っている場合は何も起きない)
//    ③       それでも0円にならなければ、ひとまず現金貯蓄(予備費)から一時的に補填し、
//            unresolvedBackfillsに記録しておく(設定画面から後で他カテゴリの繰越残高へ配分し直せる)
// 2) 今月の収入 - (現金預金を除いた)カテゴリ予算合計 - extraObligation(同棲資金の自己負担分など、
//    このspace自身のカテゴリ予算には現れない追加の支出義務) = 余り金。これを全額、現金預金として繰越す
//    (現金預金が無い空間では、従来通り予備費として保持する)
// 3) 食費特例:食費グループ(自炊・外食)の①で使われず残った今月分の黒字は、半分を旅行積立金へ、
//    残り半分はそのままそのカテゴリ自身の繰越金にする(現状旅行積立金が全く貯まらないための措置。同棲側のみ該当)
function closeMonth(space, key, extraObligation) {
  const month = space.months[key];
  if (!month || month.closed) return;
  const nextKey = addMonths(key, 1);
  const carriedIn = {};

  const nonAutoLeaves = leafCategories(space).filter(c => !c.auto);
  for (const cat of leafCategories(space)) {
    if (cat.auto) carriedIn[cat.id] = 0;
  }

  // remainingRaw: 今月分の黒字(+)/赤字(-)。各フェーズで0に近づけていく(どの資金源で埋めても減らす)
  // carryRemaining: そのカテゴリが持つ繰越残高の残り(他カテゴリへ提供するたびに減っていく)
  const info = nonAutoLeaves.map(cat => ({
    cat,
    rawRemaining0: (cat.budget || 0) - spentOf(space, key, cat.id), // 今月分のみ(繰越を含まない)。元の値を保持
    remainingRaw: (cat.budget || 0) - spentOf(space, key, cat.id),
    carryRemaining: (month.carriedIn[cat.id]) || 0,
  }));

  // 兄弟グループ(同じ親を持つ非自動引き落としリーフ)をまとめる。親が無い/兄弟が1人のみなら対象外。
  const groups = new Map();
  for (const x of info) {
    if (!x.cat.parentId) continue;
    if (!groups.has(x.cat.parentId)) groups.set(x.cat.parentId, []);
    groups.get(x.cat.parentId).push(x);
  }

  // ①-a 兄弟カテゴリの今月分の黒字を優先して赤字に充てる
  const groupPools = [];
  for (const [parentId, members] of groups) {
    if (members.length < 2) continue;
    const slackM = members.filter(x => x.remainingRaw > 0);
    const deficitM = members.filter(x => x.remainingRaw < 0);
    if (slackM.length === 0 || deficitM.length === 0) continue;
    const groupPool = slackM.reduce((s, x) => s + x.remainingRaw, 0);
    const groupDeficit = deficitM.reduce((s, x) => s + (-x.remainingRaw), 0);
    const used = Math.min(groupPool, groupDeficit);
    for (const x of slackM) {
      const usedFromThis = groupPool > 0 ? x.remainingRaw * (used / groupPool) : 0;
      x.remainingRaw -= usedFromThis;
      x.usedByGroupPool = usedFromThis;
    }
    for (const x of deficitM) {
      const need = -x.remainingRaw;
      const covered = groupDeficit > 0 ? need * (used / groupDeficit) : 0;
      x.remainingRaw += covered;
      x.coveredByGroupPool = covered;
    }
    const parentCat = space.categories.find(c => c.id === parentId);
    groupPools.push({ parentId, parentName: parentCat ? parentCat.name : '', pool: groupPool, used });
  }

  // ① 自分の繰越残高で補填(①-aでまだ埋まらない赤字だけ対象)
  for (const x of info) {
    if (x.remainingRaw < -0.0001) {
      const need = -x.remainingRaw;
      const used = Math.min(x.carryRemaining, need);
      x.remainingRaw += used;
      x.carryRemaining -= used;
      x.usedOwnCarry = used;
    }
  }

  // ① それでも足りない分は、同じ親カテゴリの兄弟の繰越残高から優先して補填
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const needers = members.filter(x => x.remainingRaw < -0.0001);
    if (needers.length === 0) continue;
    const providers = members.filter(x => x.carryRemaining > 0.0001);
    const groupCarryPool = providers.reduce((s, x) => s + x.carryRemaining, 0);
    const groupCarryNeed = needers.reduce((s, x) => s + (-x.remainingRaw), 0);
    const used = Math.min(groupCarryPool, groupCarryNeed);
    if (used <= 0.0001) continue;
    for (const x of providers) {
      const give = groupCarryPool > 0 ? x.carryRemaining * (used / groupCarryPool) : 0;
      x.carryRemaining -= give;
      x.givenToSiblingCarry = give;
    }
    for (const x of needers) {
      const need = -x.remainingRaw;
      const take = groupCarryNeed > 0 ? need * (used / groupCarryNeed) : 0;
      x.remainingRaw += take;
      x.coveredBySiblingCarry = take;
    }
  }

  // ①-free 兄弟・繰越残高で埋めきれなかった分は、空間全体のプールより先に
  // 「自由予算」の今月分の黒字があればそれを優先して充てる(無い空間では何もしない)
  const freeBudgetId = findLeafByName(space, '自由予算');
  let freeBudgetUsed = 0;
  const freeEntry = freeBudgetId ? info.find(x => x.cat.id === freeBudgetId) : null;
  if (freeEntry && freeEntry.remainingRaw > 0) {
    const needers = info.filter(x => x.remainingRaw < -0.0001 && x.cat.id !== freeBudgetId);
    const totalNeed = needers.reduce((s, x) => s + (-x.remainingRaw), 0);
    const used = Math.min(freeEntry.remainingRaw, totalNeed);
    if (used > 0.0001) {
      for (const x of needers) {
        const need = -x.remainingRaw;
        const covered = totalNeed > 0 ? need * (used / totalNeed) : 0;
        x.remainingRaw += covered;
        x.coveredByFreeBudget = covered;
      }
      freeEntry.remainingRaw -= used;
      freeEntry.usedByFreeBudget = used;
      freeBudgetUsed = used;
    }
  }

  // ①-b 自由予算でも埋めきれなかった分は、空間全体の今月分の黒字から補填
  const slack = info.filter(x => x.remainingRaw > 0);
  const deficit = info.filter(x => x.remainingRaw < 0);
  const totalPool = slack.reduce((s, x) => s + x.remainingRaw, 0);
  const totalRawDeficit = deficit.reduce((s, x) => s + (-x.remainingRaw), 0);
  const usedFromPool = Math.min(totalPool, totalRawDeficit);
  for (const x of slack) {
    const usedFromThis = totalPool > 0 ? x.remainingRaw * (usedFromPool / totalPool) : 0;
    x.remainingRaw -= usedFromThis;
    x.usedByPool = usedFromThis;
  }
  for (const x of deficit) {
    const need = -x.remainingRaw;
    const covered = totalRawDeficit > 0 ? need * (usedFromPool / totalRawDeficit) : 0;
    x.remainingRaw += covered;
    x.coveredByPool = covered;
  }

  // ②''free それでも足りなければ、「自由予算」の繰越残高があればそれを優先して充てる
  let freeBudgetCarryUsed = 0;
  if (freeEntry && freeEntry.carryRemaining > 0.0001) {
    const needers = info.filter(x => x.remainingRaw < -0.0001 && x.cat.id !== freeBudgetId);
    const totalNeed = needers.reduce((s, x) => s + (-x.remainingRaw), 0);
    const used = Math.min(freeEntry.carryRemaining, totalNeed);
    if (used > 0.0001) {
      for (const x of needers) {
        const need = -x.remainingRaw;
        const covered = totalNeed > 0 ? need * (used / totalNeed) : 0;
        x.remainingRaw += covered;
        x.coveredByFreeBudgetCarry = covered;
      }
      freeEntry.carryRemaining -= used;
      freeEntry.usedByFreeBudgetCarry = used; // 繰越金を他へ渡した分(表示用)
      freeBudgetCarryUsed = used;
    }
  }

  // ③ それでも埋まらない分は、ひとまず現金貯蓄(予備費)から一時的に補填し、
  //   unresolvedBackfillsに記録しておく(設定画面から後で他カテゴリの繰越残高へ配分し直せる)
  for (const x of info) {
    if (x.remainingRaw < -0.0001) {
      const remain = -x.remainingRaw;
      x.reserveUsed = remain;
      space.reserve.balance -= remain;
      space.unresolvedBackfills.push({ id: uid(), monthKey: key, catId: x.cat.id, amount: remain });
    } else {
      x.reserveUsed = 0;
    }
  }

  // 食費特例: 食費グループ(自炊・外食)の、ここまでのフェーズで使われず残った今月分の黒字は
  // 半分を旅行積立金へ、残り半分はそのままそのカテゴリ自身の繰越金にする
  const travelId = findLeafByName(space, '旅行積立金');
  const foodGroup = space.categories.find(c => c.name === '食費' && isGroup(space, c.id));
  const foodGroupId = foodGroup ? foodGroup.id : null;
  let travelBonus = 0;
  for (const x of info) {
    const kept = Math.max(0, x.remainingRaw);
    let selfKept = kept;
    if (foodGroupId && travelId && x.cat.parentId === foodGroupId) {
      selfKept = kept / 2;
      x.toTravelSaving = kept / 2;
      travelBonus += kept / 2;
    }
    carriedIn[x.cat.id] = (x.carryRemaining || 0) + selfKept;
  }
  if (travelBonus > 0 && travelId) {
    carriedIn[travelId] = (carriedIn[travelId] || 0) + travelBonus;
  }

  // 補填がどこからどう行われたかを後から確認できるよう、月ごとに記録しておく(settlement)
  const settlement = {
    groupPools, pool: totalPool, poolUsed: usedFromPool,
    freeBudgetId, freeBudgetUsed, freeBudgetCarryUsed,
    slack: [], deficit: [],
  };
  for (const x of info) {
    if (x.rawRemaining0 >= -0.0001) {
      settlement.slack.push({
        catId: x.cat.id,
        amount: x.rawRemaining0,
        usedByGroupPool: x.usedByGroupPool || 0,
        usedByPool: x.usedByPool || 0,
        usedByFreeBudget: x.usedByFreeBudget || 0,
        usedByFreeBudgetCarry: x.usedByFreeBudgetCarry || 0,
        givenToSiblingCarry: x.givenToSiblingCarry || 0,
        toTravelSaving: x.toTravelSaving || 0,
      });
    } else {
      settlement.deficit.push({
        catId: x.cat.id,
        amount: -x.rawRemaining0,
        coveredByGroupPool: x.coveredByGroupPool || 0,
        usedOwnCarry: x.usedOwnCarry || 0,
        coveredBySiblingCarry: x.coveredBySiblingCarry || 0,
        coveredByPool: x.coveredByPool || 0,
        coveredByFreeBudget: x.coveredByFreeBudget || 0,
        coveredByFreeBudgetCarry: x.coveredByFreeBudgetCarry || 0,
        reserveUsed: x.reserveUsed || 0,
      });
    }
  }

  // 余り金(今月の収入 - 繰越先を除いた各カテゴリの予算合計 - このspace自身の追加義務)は
  // 全額、現金預金(同棲側は旅行積立金)として繰越す(以前の2:1:1分配は廃止)
  const leftover = month.income - totalLeafBudget(space) - (extraObligation || 0);
  const targetId = leftoverTargetId(space);
  if (targetId) {
    carriedIn[targetId] = (carriedIn[targetId] || 0) + leftover;
  } else {
    space.reserve.balance += leftover; // 繰越先が無い空間は従来通り予備費に保持
  }

  settlement.leftover = leftover;
  settlement.leftoverTargetId = targetId;
  month.settlement = settlement;
  month.closed = true;
  if (!space.months[nextKey]) {
    space.months[nextKey] = emptyMonth(month.income);
  }
  space.months[nextKey].carriedIn = carriedIn;
  space.currentMonth = nextKey;
}

// ③未解決の貯蓄補填を、他カテゴリの(現在の)繰越残高から配分し直す。
// allocations: {catId: amount}。合計が bf.amount と一致する前提(呼び出し側で検証)。
// 配分した分だけ現金貯蓄(予備費)へ戻し、選んだカテゴリの繰越残高を減らす。
function reassignBackfill(space, backfillId, allocations) {
  const bf = space.unresolvedBackfills.find(b => b.id === backfillId);
  if (!bf) return;
  const month = space.months[space.currentMonth];
  let total = 0;
  for (const [catId, amt] of Object.entries(allocations)) {
    if (!amt || amt <= 0) continue;
    month.carriedIn[catId] = ((month.carriedIn[catId]) || 0) - amt;
    total += amt;
  }
  space.reserve.balance += total;
  bf.amount -= total;
  if (bf.amount <= 0.0001) {
    space.unresolvedBackfills = space.unresolvedBackfills.filter(b => b.id !== backfillId);
  }
}

// 現金貯蓄からの補填のまま確定する(配分し直さず、未解決リストから外すだけ)
function acceptBackfillFromReserve(space, backfillId) {
  space.unresolvedBackfills = space.unresolvedBackfills.filter(b => b.id !== backfillId);
}

// 保存データ上で「今」まで月を進める(開いていない間の月もすべて締めて繰越する)
function ensureCurrentMonth(space, extraObligation) {
  if (!space.months[space.currentMonth]) {
    space.months[space.currentMonth] = emptyMonth(0);
  }
  const real = monthKey(new Date());
  let guard = 0;
  while (space.currentMonth < real && guard < 36) {
    closeMonth(space, space.currentMonth, extraObligation);
    guard++;
  }
}

function init() {
  const data = load();
  migrateCategoryNames(data);
  // 同棲資金(shared)側を先に確定させてから、個人側(自分・彼女それぞれ)の自己負担分を計算する
  ensureCurrentMonth(data.spaces.shared, 0);
  syncSharedIncome(data);
  ensureCurrentMonth(data.spaces.personal, personalSharedShare(data));
  ensureCurrentMonth(data.spaces.partner, partnerSharedShare(data));
  save(data);
  return data;
}

window.Store = {
  monthKey, addMonths, uid,
  load, save, init, resetAll,
  leafCategories, isGroup, children, topLevel, reorderSiblings,
  spentOf, effectiveBudgetOf, remainingOf, statusOf, totals, totalAssets,
  rawBudgetOf, rawRemainingOf, rawStatusOf, allAuto,
  ensureCurrentMonth, closeMonth,
  reassignBackfill, acceptBackfillFromReserve,
  totalLeafBudget, findLeafByName, leftoverTargetId,
  sharedFundTotal, personalSharedShare, partnerSharedShare, syncSharedIncome,
  dayTotals, transactionsOnDay, transactionsInMonth, settlementOf,
  defaultBudgetTemplate, applyDefaultTemplate, resetSpaceAmounts,
  allMonthKeys, categorySpendBreakdown,
};
