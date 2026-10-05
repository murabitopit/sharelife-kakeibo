// レポートタブ用:全期間/月次のExcel(.xlsx)書き出し・PDF表示。
// ExcelJS / jsPDF / html2canvas はCDN読み込み(index.html)。通信環境が無いと使えないため、
// 読み込み失敗時は各操作の実行時にその場で知らせる(アプリ本体の閲覧・記録には影響しない)。

const SPACE_DEFS = [
  { key: 'personal', label: '🧑自分' },
  { key: 'partner', label: '👩彼女' },
  { key: 'shared', label: '🤝同棲' },
];

// style.cssの--series-1〜12(ライトモード)と合わせた固定パレット(canvas描画用に複製)
const REPORT_PALETTE = [
  '#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300',
  '#8a5fd1', '#1b9aa8', '#c43d3d', '#8f9c2e', '#9c6a35', '#5c6bd8',
];

function yen(n) { return '¥' + Math.round(n || 0).toLocaleString('ja-JP'); }

function spacesOf(data) {
  return SPACE_DEFS.map(s => ({ ...s, sp: data.spaces[s.key] }));
}

// --- データ収集 ---

// 全期間レポート用データ:月ごと×空間ごとの収入/支出、全期間のカテゴリ別支出合算
function gatherOverallData(data) {
  const monthsDesc = Store.allMonthKeys(data); // 新しい順
  const monthsAsc = monthsDesc.slice().reverse();
  const spaces = spacesOf(data);

  const monthRows = monthsAsc.map(mk => {
    const perSpace = spaces.map(s => {
      if (!s.sp.months[mk]) return { key: s.key, label: s.label, exists: false, income: 0, spent: 0 };
      const t = Store.totals(s.sp, mk);
      return { key: s.key, label: s.label, exists: true, income: t.income, spent: t.spent };
    });
    const incomeSum = perSpace.reduce((a, x) => a + x.income, 0);
    const spentSum = perSpace.reduce((a, x) => a + x.spent, 0);
    return { monthKey: mk, perSpace, incomeSum, spentSum };
  });

  const catTotals = new Map();
  for (const s of spaces) {
    for (const mk of monthsAsc) {
      for (const c of Store.categorySpendBreakdown(s.sp, mk)) {
        catTotals.set(c.name, (catTotals.get(c.name) || 0) + c.value);
      }
    }
  }
  const categoryBreakdown = Array.from(catTotals, ([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  const grandIncome = monthRows.reduce((a, x) => a + x.incomeSum, 0);
  const grandSpent = monthRows.reduce((a, x) => a + x.spentSum, 0);

  return { monthsAsc, monthsDesc, monthRows, categoryBreakdown, grandIncome, grandSpent };
}

// 指定月のレポート用データ:空間ごとの収支・カテゴリ内訳・精算内訳
function gatherMonthData(data, monthKey_) {
  const spaces = spacesOf(data);
  const perSpace = spaces.map(s => {
    const sp = s.sp;
    if (!sp.months[monthKey_]) return { key: s.key, label: s.label, exists: false };
    const totals = Store.totals(sp, monthKey_);
    const breakdown = Store.categorySpendBreakdown(sp, monthKey_);
    const settlement = Store.settlementOf(sp, monthKey_);
    return { key: s.key, label: s.label, exists: true, totals, breakdown, settlement };
  });
  return { monthKey: monthKey_, perSpace };
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

async function exportExcel(data) {
  if (!window.ExcelJS) {
    alert('Excel書き出し用ライブラリの読み込みに失敗しました。通信環境を確認してもう一度お試しください。');
    return;
  }
  const overall = gatherOverallData(data);
  const wb = new ExcelJS.Workbook();
  wb.creator = '資産管理アプリ';
  wb.created = new Date();

  // --- 1枚目:総合 ---
  const sheet1 = wb.addWorksheet('総合');
  sheet1.columns = [
    { header: '月', key: 'month', width: 12 },
    { header: '収入(自分)', key: 'inc_personal', width: 13 },
    { header: '支出(自分)', key: 'exp_personal', width: 13 },
    { header: '収入(彼女)', key: 'inc_partner', width: 13 },
    { header: '支出(彼女)', key: 'exp_partner', width: 13 },
    { header: '収入(同棲)', key: 'inc_shared', width: 13 },
    { header: '支出(同棲)', key: 'exp_shared', width: 13 },
    { header: '収入合計', key: 'inc_total', width: 13 },
    { header: '支出合計', key: 'exp_total', width: 13 },
  ];
  sheet1.getRow(1).font = { bold: true };
  for (const row of overall.monthRows) {
    const byKey = {};
    for (const p of row.perSpace) byKey[p.key] = p;
    sheet1.addRow({
      month: row.monthKey,
      inc_personal: byKey.personal.income, exp_personal: byKey.personal.spent,
      inc_partner: byKey.partner.income, exp_partner: byKey.partner.spent,
      inc_shared: byKey.shared.income, exp_shared: byKey.shared.spent,
      inc_total: row.incomeSum, exp_total: row.spentSum,
    });
  }
  const totalRow = sheet1.addRow({ month: '合計', inc_total: overall.grandIncome, exp_total: overall.grandSpent });
  totalRow.font = { bold: true };

  if (overall.monthsAsc.length > 0) {
    const barPng = drawIncomeExpenseBarChart(overall.monthsAsc, overall.monthRows.map(r => r.incomeSum), overall.monthRows.map(r => r.spentSum));
    const barImgId = wb.addImage({ base64: stripDataUrlPrefix(barPng), extension: 'png' });
    const chartRow = overall.monthRows.length + 3;
    sheet1.addImage(barImgId, { tl: { col: 0, row: chartRow }, ext: { width: 450, height: 220 } });

    const pieSlices = overall.categoryBreakdown.map(c => ({ name: c.name, value: c.value }));
    const piePng = drawPieChartPng(pieSlices);
    const pieImgId = wb.addImage({ base64: stripDataUrlPrefix(piePng), extension: 'png' });
    sheet1.addImage(pieImgId, { tl: { col: 0, row: chartRow + 13 }, ext: { width: 500, height: 240 } });
  }

  // --- 2枚目以降:月次(新しい月が2枚目になるよう降順で追加) ---
  for (const mk of overall.monthsDesc) {
    const monthData = gatherMonthData(data, mk);
    const ws = wb.addWorksheet(mk);
    ws.columns = [
      { header: '空間', key: 'space', width: 10 },
      { header: '項目', key: 'name', width: 20 },
      { header: '金額', key: 'value', width: 13 },
    ];
    ws.getRow(1).font = { bold: true };
    const combined = new Map();
    for (const sp of monthData.perSpace) {
      if (!sp.exists) continue;
      ws.addRow({ space: sp.label, name: '収入', value: sp.totals.income });
      ws.addRow({ space: sp.label, name: '支出', value: sp.totals.spent });
      ws.addRow({ space: sp.label, name: '残り予算(収入-支出)', value: sp.totals.remaining });
      for (const c of sp.breakdown) {
        ws.addRow({ space: sp.label, name: c.name, value: c.value });
        combined.set(c.name, (combined.get(c.name) || 0) + c.value);
      }
      ws.addRow({});
    }
    const slices = Array.from(combined, ([name, value]) => ({ name, value }));
    if (slices.length) {
      const png = drawPieChartPng(slices);
      const imgId = wb.addImage({ base64: stripDataUrlPrefix(png), extension: 'png' });
      ws.addImage(imgId, { tl: { col: 4, row: 1 }, ext: { width: 420, height: 200 } });
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

function overallReportHtml(data) {
  const overall = gatherOverallData(data);
  const barPng = drawIncomeExpenseBarChart(overall.monthsAsc, overall.monthRows.map(r => r.incomeSum), overall.monthRows.map(r => r.spentSum));
  const piePng = drawPieChartPng(overall.categoryBreakdown);
  const periodLabel = overall.monthsAsc.length ? `${overall.monthsAsc[0]} 〜 ${overall.monthsDesc[0]}` : '(データなし)';
  const rows = [['月', '収入合計', '支出合計']].concat(
    overall.monthRows.map(r => [r.monthKey, yen(r.incomeSum), yen(r.spentSum)])
  );
  rows.push(['合計', yen(overall.grandIncome), yen(overall.grandSpent)]);
  return `
    <h1 style="font-size:20px;">資産管理レポート(全期間)</h1>
    <p style="color:#666; font-size:12px;">対象期間: ${periodLabel} / 🧑自分+👩彼女+🤝同棲 合算</p>
    <h2 style="font-size:15px; margin-top:20px;">収入・支出の推移</h2>
    <img src="${barPng}" style="width:100%; max-width:660px;" />
    <h2 style="font-size:15px; margin-top:20px;">カテゴリ別支出(全期間合算)</h2>
    <img src="${piePng}" style="width:100%; max-width:660px;" />
    <h2 style="font-size:15px; margin-top:20px;">月別合計</h2>
    ${reportTableHtml(rows)}
  `;
}

function monthReportHtml(data, monthKey_) {
  const monthData = gatherMonthData(data, monthKey_);
  let body = '';
  for (const sp of monthData.perSpace) {
    if (!sp.exists) continue;
    const piePng = sp.breakdown.length ? drawPieChartPng(sp.breakdown) : null;
    body += `
      <h2 style="font-size:15px; margin-top:20px;">${sp.label}</h2>
      ${reportTableHtml([
        ['項目', '金額'],
        ['収入', yen(sp.totals.income)],
        ['支出', yen(sp.totals.spent)],
        ['残り予算(収入-支出)', yen(sp.totals.remaining)],
      ])}
      ${piePng ? `<img src="${piePng}" style="width:100%; max-width:600px;" />` : ''}
      ${sp.breakdown.length ? reportTableHtml([['カテゴリ', '支出']].concat(sp.breakdown.map(c => [c.name, yen(c.value)]))) : ''}
    `;
  }
  return `
    <h1 style="font-size:20px;">月次レポート: ${monthKey_}</h1>
    ${body}
  `;
}

// --- レポートタブ本体のHTML ---

function reportTabHtml(data) {
  const months = Store.allMonthKeys(data);
  if (months.length === 0) {
    return `
      <div class="section-title">レポート</div>
      <div class="empty-note">レポートの元になる月次データがまだありません</div>
    `;
  }
  return `
    <div class="section-title">全期間レポート</div>
    <div class="card report-card">
      <div class="hint" style="margin-top:0">🧑自分+👩彼女+🤝同棲 合算・記録がある全${months.length}か月分</div>
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
