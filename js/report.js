// レポートタブ用:全期間/月次のExcel(.xlsx)書き出し・PDF表示。
// ExcelJS / jsPDF / html2canvas はCDN読み込み(index.html)。通信環境が無いと使えないため、
// 読み込み失敗時は各操作の実行時にその場で知らせる(アプリ本体の閲覧・記録には影響しない)。
//
// プライバシー上の理由(画面ロックの意味が無くならないよう)、レポートは常に
// 「自分(ログイン中の本人)」と「同棲」の2空間のみを対象にし、相方の個人空間は一切含めない。
// どちらが「自分」かは main.js 側で Lock.getDeviceOwner()/現在のタブから決めて ownKey として渡す。

// style.cssの--series-1〜12(ライトモード)と合わせた固定パレット(canvas描画用に複製)
const REPORT_PALETTE = [
  '#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300',
  '#8a5fd1', '#1b9aa8', '#c43d3d', '#8f9c2e', '#9c6a35', '#5c6bd8',
];

function yen(n) { return '¥' + Math.round(n || 0).toLocaleString('ja-JP'); }

// --- データ収集 ---
// ownKey: 'personal' | 'partner'。レポート対象は常に「ownKeyの空間」+「同棲」の2つだけ

// 個人側(自分)の月次データ:収入はそのまま、支出には同棲資金の自己負担分を上乗せする
// (同棲側の「収入」は2人の負担額の合算であって新規の収入ではないため、個人側の支出として扱う)
function gatherOwnMonthRow(data, ownKey, mk) {
  const sp = data.spaces[ownKey];
  if (!sp.months[mk]) return { monthKey: mk, exists: false, income: 0, spent: 0 };
  const t = Store.totals(sp, mk);
  const contribution = Store.sharedContributionForMonth(data, ownKey, mk);
  return { monthKey: mk, exists: true, income: t.income, spent: t.spent + contribution, contribution };
}

function gatherSharedMonthRow(data, mk) {
  const sp = data.spaces.shared;
  if (!sp.months[mk]) return { monthKey: mk, exists: false, income: 0, spent: 0 };
  const t = Store.totals(sp, mk);
  return { monthKey: mk, exists: true, income: t.income, spent: t.spent };
}

// 空間1つ分の全期間データ(月次推移・カテゴリ内訳合算・合計)。contribLabelがあれば
// 同棲費負担を1項目としてカテゴリ内訳・支出合計へ合算する(自分側のみ使う)
function gatherSpaceOverall(data, spaceKey, monthsAsc, contribLabel) {
  const isOwn = !!contribLabel;
  const monthRows = monthsAsc.map(mk => isOwn ? gatherOwnMonthRow(data, spaceKey, mk) : gatherSharedMonthRow(data, mk));
  const catTotals = new Map();
  for (const mk of monthsAsc) {
    for (const c of Store.categorySpendBreakdown(data.spaces[spaceKey], mk)) {
      catTotals.set(c.name, (catTotals.get(c.name) || 0) + c.value);
    }
  }
  if (isOwn) {
    const contribSum = monthRows.reduce((s, r) => s + (r.contribution || 0), 0);
    if (contribSum > 0) catTotals.set(contribLabel, (catTotals.get(contribLabel) || 0) + contribSum);
  }
  const categoryBreakdown = Array.from(catTotals, ([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  const grandIncome = monthRows.reduce((a, x) => a + x.income, 0);
  const grandSpent = monthRows.reduce((a, x) => a + x.spent, 0);
  return { monthRows, categoryBreakdown, grandIncome, grandSpent };
}

// 全期間レポート用データ:自分の空間 + 同棲の2本立て
function gatherOverallData(data, ownKey) {
  const monthsDesc = Store.allMonthKeys(data); // 新しい順
  const monthsAsc = monthsDesc.slice().reverse();
  const ownLabel = Store.spaceLabel(data, ownKey);
  const own = gatherSpaceOverall(data, ownKey, monthsAsc, `🤝同棲費負担`);
  const shared = gatherSpaceOverall(data, 'shared', monthsAsc, null);
  return { monthsAsc, monthsDesc, ownKey, ownLabel, own, shared };
}

// 指定月のレポート用データ:自分の空間 + 同棲の2本立て
function gatherMonthData(data, monthKey_, ownKey) {
  const ownRow = gatherOwnMonthRow(data, ownKey, monthKey_);
  const sharedRow = gatherSharedMonthRow(data, monthKey_);
  const ownBreakdown = Store.categorySpendBreakdown(data.spaces[ownKey], monthKey_);
  if (ownRow.contribution > 0) ownBreakdown.push({ name: '🤝同棲費負担', value: ownRow.contribution });
  const sharedBreakdown = Store.categorySpendBreakdown(data.spaces.shared, monthKey_);
  return {
    monthKey: monthKey_,
    ownKey,
    ownLabel: Store.spaceLabel(data, ownKey),
    own: { exists: ownRow.exists, totals: { income: ownRow.income, spent: ownRow.spent, remaining: ownRow.income - ownRow.spent }, breakdown: ownBreakdown },
    shared: { exists: sharedRow.exists, totals: { income: sharedRow.income, spent: sharedRow.spent, remaining: sharedRow.income - sharedRow.spent }, breakdown: sharedBreakdown },
  };
}

// --- canvasでの簡易チャート描画(xlsx埋め込み・PDF両方で使う。画像化してdataURLで返す) ---

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// 月ごとの収入/支出を並べた棒グラフ
function drawIncomeExpenseBarChart(monthLabels, incomeArr, expenseArr) {
  const w = 900, h = 440;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);

  const padL = 70, padR = 20, padT = 30, padB = 70;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const maxVal = Math.max(1, ...incomeArr, ...expenseArr);
  const n = monthLabels.length || 1;
  const groupW = plotW / n;
  const barW = Math.min(28, groupW * 0.32);

  ctx.strokeStyle = '#999'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH); ctx.stroke();

  ctx.fillStyle = '#333'; ctx.font = '13px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = maxVal * i / 4;
    const y = padT + plotH - (v / maxVal) * plotH;
    ctx.fillText(Math.round(v).toLocaleString('ja-JP'), padL - 8, y);
    ctx.strokeStyle = '#eee'; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
  }

  monthLabels.forEach((label, i) => {
    const cx = padL + groupW * i + groupW / 2;
    const incH = (incomeArr[i] / maxVal) * plotH;
    const expH = (expenseArr[i] / maxVal) * plotH;
    ctx.fillStyle = REPORT_PALETTE[0];
    ctx.fillRect(cx - barW - 2, padT + plotH - incH, barW, incH);
    ctx.fillStyle = REPORT_PALETTE[1];
    ctx.fillRect(cx + 2, padT + plotH - expH, barW, expH);
    ctx.fillStyle = '#333'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.save();
    ctx.translate(cx, padT + plotH + 8);
    ctx.rotate(-Math.PI / 6);
    ctx.textAlign = 'right';
    ctx.fillText(label, 0, 0);
    ctx.restore();
  });

  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = REPORT_PALETTE[0]; ctx.fillRect(padL, 4, 12, 12);
  ctx.fillStyle = '#333'; ctx.fillText('収入', padL + 16, 10);
  ctx.fillStyle = REPORT_PALETTE[1]; ctx.fillRect(padL + 70, 4, 12, 12);
  ctx.fillStyle = '#333'; ctx.fillText('支出', padL + 86, 10);

  return canvas.toDataURL('image/png');
}

// カテゴリ別支出の円グラフ(上位11+その他)+凡例
function drawPieChartPng(items) {
  const w = 760, h = 360;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  if (!items.length) return canvas.toDataURL('image/png');

  const sorted = items.slice().sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, 11);
  const othersVal = sorted.slice(11).reduce((s, x) => s + x.value, 0);
  const slices = top.map((x, i) => ({ name: x.name, value: x.value, color: REPORT_PALETTE[i % REPORT_PALETTE.length] }));
  if (othersVal > 0) slices.push({ name: 'その他', value: othersVal, color: '#898781' });

  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const cx = 180, cy = h / 2, r = 140;
  let angle = -Math.PI / 2;
  for (const s of slices) {
    const sweep = (s.value / total) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + sweep);
    ctx.closePath();
    ctx.fillStyle = s.color; ctx.fill();
    angle += sweep;
  }

  ctx.font = '13px sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  let ly = 24;
  for (const s of slices) {
    const pct = Math.round((s.value / total) * 100);
    ctx.fillStyle = s.color; ctx.fillRect(380, ly - 7, 14, 14);
    ctx.fillStyle = '#222';
    ctx.fillText(`${s.name}  ${yen(s.value)} (${pct}%)`, 400, ly);
    ly += 24;
    if (ly > h - 10) break;
  }
  return canvas.toDataURL('image/png');
}

function stripDataUrlPrefix(dataUrl) {
  return dataUrl.replace(/^data:image\/\w+;base64,/, '');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

// --- Excel(.xlsx)書き出し ---

async function exportExcel(data, ownKey) {
  if (!window.ExcelJS) {
    alert('Excel書き出し用ライブラリの読み込みに失敗しました。通信環境を確認してもう一度お試しください。');
    return;
  }
  const overall = gatherOverallData(data, ownKey);
  const ownLabel = overall.ownLabel;
  const wb = new ExcelJS.Workbook();
  wb.creator = '資産管理アプリ';
  wb.created = new Date();

  // --- 1枚目:総合 ---
  const sheet1 = wb.addWorksheet('総合');
  sheet1.columns = [
    { header: '月', key: 'month', width: 12 },
    { header: `収入(${ownLabel})`, key: 'inc_own', width: 14 },
    { header: `支出(${ownLabel}・同棲費負担込み)`, key: 'exp_own', width: 20 },
    { header: '収入(同棲)', key: 'inc_shared', width: 13 },
    { header: '支出(同棲)', key: 'exp_shared', width: 13 },
  ];
  sheet1.getRow(1).font = { bold: true };
  for (let i = 0; i < overall.monthsAsc.length; i++) {
    sheet1.addRow({
      month: overall.monthsAsc[i],
      inc_own: overall.own.monthRows[i].income, exp_own: overall.own.monthRows[i].spent,
      inc_shared: overall.shared.monthRows[i].income, exp_shared: overall.shared.monthRows[i].spent,
    });
  }
  const totalRow = sheet1.addRow({ month: '合計', inc_own: overall.own.grandIncome, exp_own: overall.own.grandSpent, inc_shared: overall.shared.grandIncome, exp_shared: overall.shared.grandSpent });
  totalRow.font = { bold: true };

  if (overall.monthsAsc.length > 0) {
    const ownBarPng = drawIncomeExpenseBarChart(overall.monthsAsc, overall.own.monthRows.map(r => r.income), overall.own.monthRows.map(r => r.spent));
    const ownBarImgId = wb.addImage({ base64: stripDataUrlPrefix(ownBarPng), extension: 'png' });
    const chartRow = overall.monthsAsc.length + 3;
    sheet1.addRow({});
    sheet1.getCell(`A${chartRow - 1}`).value = `${ownLabel}の収支推移`;
    sheet1.addImage(ownBarImgId, { tl: { col: 0, row: chartRow }, ext: { width: 450, height: 220 } });

    const ownPiePng = drawPieChartPng(overall.own.categoryBreakdown);
    const ownPieImgId = wb.addImage({ base64: stripDataUrlPrefix(ownPiePng), extension: 'png' });
    sheet1.getCell(`A${chartRow + 12}`).value = `${ownLabel}のカテゴリ別支出(全期間合算)`;
    sheet1.addImage(ownPieImgId, { tl: { col: 0, row: chartRow + 13 }, ext: { width: 500, height: 240 } });

    const sharedBarPng = drawIncomeExpenseBarChart(overall.monthsAsc, overall.shared.monthRows.map(r => r.income), overall.shared.monthRows.map(r => r.spent));
    const sharedBarImgId = wb.addImage({ base64: stripDataUrlPrefix(sharedBarPng), extension: 'png' });
    sheet1.getCell(`H${chartRow - 1}`).value = `同棲の収支推移`;
    sheet1.addImage(sharedBarImgId, { tl: { col: 7, row: chartRow }, ext: { width: 450, height: 220 } });

    const sharedPiePng = drawPieChartPng(overall.shared.categoryBreakdown);
    const sharedPieImgId = wb.addImage({ base64: stripDataUrlPrefix(sharedPiePng), extension: 'png' });
    sheet1.getCell(`H${chartRow + 12}`).value = `同棲のカテゴリ別支出(全期間合算)`;
    sheet1.addImage(sharedPieImgId, { tl: { col: 7, row: chartRow + 13 }, ext: { width: 500, height: 240 } });
  }

  // --- 2枚目以降:月次(新しい月が2枚目になるよう降順で追加) ---
  for (const mk of overall.monthsDesc) {
    const monthData = gatherMonthData(data, mk, ownKey);
    const ws = wb.addWorksheet(mk);
    ws.columns = [
      { header: '空間', key: 'space', width: 10 },
      { header: '項目', key: 'name', width: 20 },
      { header: '金額', key: 'value', width: 13 },
    ];
    ws.getRow(1).font = { bold: true };
    const sections = [{ label: ownLabel, d: monthData.own }, { label: '🤝同棲', d: monthData.shared }];
    for (const sec of sections) {
      if (!sec.d.exists) continue;
      ws.addRow({ space: sec.label, name: '収入', value: sec.d.totals.income });
      ws.addRow({ space: sec.label, name: '支出', value: sec.d.totals.spent });
      ws.addRow({ space: sec.label, name: '残り(収入-支出)', value: sec.d.totals.remaining });
      for (const c of sec.d.breakdown) {
        ws.addRow({ space: sec.label, name: c.name, value: c.value });
      }
      ws.addRow({});
    }
    if (monthData.own.breakdown.length) {
      const png = drawPieChartPng(monthData.own.breakdown);
      const imgId = wb.addImage({ base64: stripDataUrlPrefix(png), extension: 'png' });
      ws.getCell('E1').value = `${ownLabel}`;
      ws.addImage(imgId, { tl: { col: 4, row: 1 }, ext: { width: 420, height: 200 } });
    }
    if (monthData.shared.breakdown.length) {
      const png = drawPieChartPng(monthData.shared.breakdown);
      const imgId = wb.addImage({ base64: stripDataUrlPrefix(png), extension: 'png' });
      ws.getCell('E12').value = '🤝同棲';
      ws.addImage(imgId, { tl: { col: 4, row: 12 }, ext: { width: 420, height: 200 } });
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const latest = overall.monthsDesc[0] || 'empty';
  downloadBlob(blob, `資産管理レポート_${latest}.xlsx`);
}

// --- PDF表示(html2canvas+jsPDFでHTMLをそのままPDF化) ---

function buildOffscreenContainer(html) {
  const div = document.createElement('div');
  div.style.cssText = 'position:fixed; left:-10000px; top:0; width:760px; background:#fff; color:#1f2a24; ' +
    'font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif; padding:24px;';
  div.innerHTML = html;
  document.body.appendChild(div);
  return div;
}

// html2canvasでHTMLを1枚の画像化し、A4ページの高さごとに切り分けてjsPDFへ貼り付ける
// (jsPDF付属のdoc.html()は日本語混在のレイアウトで白紙になる不具合があったため、
//  html2canvasを直接呼んで画像を自前でページ分割する方式にしている)
async function renderHtmlToPdf(html, filename) {
  if (!window.jspdf || !window.html2canvas) {
    alert('PDF表示用ライブラリの読み込みに失敗しました。通信環境を確認してもう一度お試しください。');
    return;
  }
  const container = buildOffscreenContainer(html);
  try {
    const canvas = await window.html2canvas(container, { scale: 2, backgroundColor: '#ffffff' });
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const margin = 24;
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const contentW = pageW - margin * 2;
    const contentH = pageH - margin * 2;
    const scale = contentW / canvas.width; // 元画像pxあたりのpt
    const sliceHeightPx = Math.max(1, Math.floor(contentH / scale));

    let renderedPx = 0;
    let first = true;
    while (renderedPx < canvas.height) {
      const thisSliceHeightPx = Math.min(sliceHeightPx, canvas.height - renderedPx);
      const sliceCanvas = document.createElement('canvas');
      sliceCanvas.width = canvas.width;
      sliceCanvas.height = thisSliceHeightPx;
      sliceCanvas.getContext('2d').drawImage(
        canvas, 0, renderedPx, canvas.width, thisSliceHeightPx,
        0, 0, canvas.width, thisSliceHeightPx
      );
      if (!first) doc.addPage();
      doc.addImage(sliceCanvas.toDataURL('image/png'), 'PNG', margin, margin, contentW, thisSliceHeightPx * scale);
      renderedPx += thisSliceHeightPx;
      first = false;
    }
    doc.save(filename);
  } finally {
    document.body.removeChild(container);
  }
}

function reportTableHtml(rows) {
  return `
    <table style="width:100%; border-collapse:collapse; font-size:13px; margin-bottom:16px;">
      ${rows.map(r => `
        <tr>
          ${r.map((cell, i) => `<td style="border:1px solid #ccc; padding:5px 8px; ${i === r.length - 1 ? 'text-align:right;' : ''}">${cell}</td>`).join('')}
        </tr>
      `).join('')}
    </table>
  `;
}

// 自分(own)/同棲(shared)1空間分のセクションHTML(全期間レポート用)
function overallSpaceSectionHtml(label, part, monthsAsc, monthsDesc) {
  const barPng = drawIncomeExpenseBarChart(monthsAsc, part.monthRows.map(r => r.income), part.monthRows.map(r => r.spent));
  const piePng = drawPieChartPng(part.categoryBreakdown);
  const rows = [['月', '収入', '支出']].concat(
    part.monthRows.map(r => [r.monthKey, yen(r.income), yen(r.spent)])
  );
  rows.push(['合計', yen(part.grandIncome), yen(part.grandSpent)]);
  return `
    <h2 style="font-size:17px; margin-top:28px; border-bottom:2px solid #333; padding-bottom:4px;">${label}の収支</h2>
    <h3 style="font-size:14px; margin-top:16px;">収入・支出の推移</h3>
    <img src="${barPng}" style="width:100%; max-width:660px;" />
    <h3 style="font-size:14px; margin-top:16px;">カテゴリ別支出(全期間合算)</h3>
    <img src="${piePng}" style="width:100%; max-width:660px;" />
    <h3 style="font-size:14px; margin-top:16px;">月別合計</h3>
    ${reportTableHtml(rows)}
  `;
}

function overallReportHtml(data, ownKey) {
  const overall = gatherOverallData(data, ownKey);
  const periodLabel = overall.monthsAsc.length ? `${overall.monthsAsc[0]} 〜 ${overall.monthsDesc[0]}` : '(データなし)';
  return `
    <h1 style="font-size:20px;">資産管理レポート(全期間)</h1>
    <p style="color:#666; font-size:12px;">対象期間: ${periodLabel} / ${overall.ownLabel}・🤝同棲(それぞれ別集計。同棲費の自己負担分は${overall.ownLabel}側の支出に含む)</p>
    ${overallSpaceSectionHtml(overall.ownLabel, overall.own, overall.monthsAsc, overall.monthsDesc)}
    ${overallSpaceSectionHtml('🤝同棲', overall.shared, overall.monthsAsc, overall.monthsDesc)}
  `;
}

function monthSpaceSectionHtml(label, d) {
  if (!d.exists) return `<h2 style="font-size:17px; margin-top:20px;">${label}</h2><p class="hint">この月の記録はありません</p>`;
  const piePng = d.breakdown.length ? drawPieChartPng(d.breakdown) : null;
  return `
    <h2 style="font-size:17px; margin-top:20px; border-bottom:2px solid #333; padding-bottom:4px;">${label}</h2>
    ${reportTableHtml([
      ['項目', '金額'],
      ['収入', yen(d.totals.income)],
      ['支出', yen(d.totals.spent)],
      ['残り(収入-支出)', yen(d.totals.remaining)],
    ])}
    ${piePng ? `<img src="${piePng}" style="width:100%; max-width:600px;" />` : ''}
    ${d.breakdown.length ? reportTableHtml([['カテゴリ', '支出']].concat(d.breakdown.map(c => [c.name, yen(c.value)]))) : ''}
  `;
}

function monthReportHtml(data, monthKey_, ownKey) {
  const monthData = gatherMonthData(data, monthKey_, ownKey);
  return `
    <h1 style="font-size:20px;">月次レポート: ${monthKey_}</h1>
    <p style="color:#666; font-size:12px;">${monthData.ownLabel}・🤝同棲(それぞれ別集計。同棲費の自己負担分は${monthData.ownLabel}側の支出に含む)</p>
    ${monthSpaceSectionHtml(monthData.ownLabel, monthData.own)}
    ${monthSpaceSectionHtml('🤝同棲', monthData.shared)}
  `;
}

// --- レポートタブ本体のHTML ---

function reportTabHtml(data, ownKey) {
  const months = Store.allMonthKeys(data);
  const ownLabel = Store.spaceLabel(data, ownKey);
  if (months.length === 0) {
    return `
      <div class="section-title">レポート</div>
      <div class="empty-note">レポートの元になる月次データがまだありません</div>
    `;
  }
  return `
    <div class="section-title">全期間レポート</div>
    <div class="card report-card">
      <div class="hint" style="margin-top:0">${ownLabel}+🤝同棲・記録がある全${months.length}か月分(相方の個人空間は含みません)</div>
      <button class="btn" id="reportOverallPdf">PDFで見る</button>
      <button class="btn secondary" id="reportExportExcel" style="margin-top:8px">Excel(.xlsx)を書き出す</button>
    </div>
    <div class="section-title">月別レポート</div>
    ${months.map(mk => `
      <div class="report-row">
        <span>${mk}</span>
        <button class="mini-link" data-reportpdf="${mk}">PDFで見る</button>
      </div>
    `).join('')}
  `;
}

window.Report = {
  reportTabHtml,
  exportExcel,
  renderHtmlToPdf,
  overallReportHtml,
  monthReportHtml,
};
