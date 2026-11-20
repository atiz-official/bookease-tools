// The BookEase Growth weekly card, drawn as a picture. ONE copy for every page that shows it:
// radar/growth (the shop's report + the team's LINE picture) and radar/kit (the sample the sales team shows).
// Approved top (Art 2026-11-16) + the full card read in the chat (spec 2026-11-17, Art 2026-11-20): this week's
// work, where the shop is shown, next week's plan. No button on the picture.
const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('th', { granularity: 'word' }) : null;
function wrapLines(ctx, text, maxW) {
  const words = seg ? [...seg.segment(text)].map((x) => x.segment) : text.split(/(?<=\s)/);
  const lines = []; let line = '';
  for (const w of words) {
    if (ctx.measureText(line + w).width > maxW && line) { lines.push(line.trimEnd()); line = w.trimStart(); } else line += w;
  }
  if (line) lines.push(line);
  return lines;
}
async function cardBlob(c) {
  // The approved weekly card (Art 2026-11-16), drawn as a picture: same content as the LINE flex card.
  await Promise.all(['600 14px Anuphan', '700 16px Anuphan', '800 30px Anuphan', '800 17px Inter'].map((f) => document.fonts.load(f)));
  let photo = null;
  if (c.photo) {
    photo = await new Promise((ok) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = (e) => { console.error('[growth] card photo', e); ok(null); }; im.src = c.photo; });
  }
  const K = 3, W = 340 * K, P = 22 * K, canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
  const font = (w, px, fam = 'Anuphan') => `${w} ${px * K}px ${fam}`;
  const paint = (draw) => {
    let y = P;
    const text = (str, f, color, lh, x = P, maxW = W - P - x) => {
      ctx.font = f; ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      const lines = wrapLines(ctx, str, maxW);
      lines.forEach((l, i) => draw && ctx.fillText(l, x, y + i * lh * K));
      y += lines.length * lh * K;
    };
    const rr = (x, yy, w, h, r, fill, stroke) => { ctx.beginPath(); ctx.roundRect(x, yy, w, h, r); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.setLineDash([6 * K / 2, 4 * K / 2]); ctx.lineWidth = 2 * K; ctx.strokeStyle = stroke; ctx.stroke(); ctx.setLineDash([]); } };
    // logo + week
    if (draw) {
      ctx.textBaseline = 'top'; ctx.textAlign = 'left'; ctx.font = font(800, 17, 'Inter');
      ctx.fillStyle = '#0A0A0A'; ctx.fillText('book', P, y); const bw = ctx.measureText('book').width; ctx.fillStyle = '#2D55EB'; ctx.fillText('ease', P + bw, y);
      ctx.font = font(600, 13); ctx.fillStyle = '#8A827B'; ctx.textAlign = 'right'; ctx.fillText(`สัปดาห์ที่ ${c.week}`, W - P, y + 2 * K);
    }
    y += 34 * K;
    // Whose report this is (Art 2026-11-21): the shop's name above the headline, plain and dark, at most two lines.
    if (c.name) {
      ctx.font = font(700, 16);
      const nameLines = wrapLines(ctx, c.name, W - 2 * P).slice(0, 2);
      nameLines.forEach((l, i) => { if (draw) { ctx.font = font(700, 16); ctx.fillStyle = '#14110F'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(l, P, y + i * 23 * K); } });
      y += nameLines.length * 23 * K + 6 * K;
    }
    text(c.headline, font(800, 30), c.color, 38);
    if (c.from) { y += 2 * K; text(c.from, font(700, 16), c.color, 24); }
    if (c.where) { y += 2 * K; text(c.where, font(600, 13.5), '#8A827B', 20); }
    // ladder
    if (c.ladder.length) {
      y += 14 * K;
      const numW = 30 * K, barX = P + numW + 10 * K, barW = W - P - barX, rowH = 40 * K;
      for (const row of c.ladder) {
        if (row.kind === 'gap') { if (draw) { ctx.font = font(700, 14, 'Inter'); ctx.fillStyle = '#8A827B'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('· · ·', W / 2, y + 7 * K); } y += 16 * K; continue; }
        if (draw) {
          ctx.font = font(800, 17, 'Inter'); ctx.fillStyle = row.kind === 'me' ? c.color : '#8A827B'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
          ctx.fillText(row.n, P + numW, y + rowH / 2);
          if (row.kind === 'me') {
            rr(barX, y, barW, rowH, 12 * K, c.color);
            let tx = barX + 14 * K;
            if (photo) {
              const d = 30 * K, cx = barX + 6 * K + d / 2, cy = y + rowH / 2;
              ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, d / 2, 0, Math.PI * 2); ctx.clip();
              const sz = Math.min(photo.width, photo.height); ctx.drawImage(photo, (photo.width - sz) / 2, (photo.height - sz) / 2, sz, sz, cx - d / 2, cy - d / 2, d, d); ctx.restore();
              ctx.beginPath(); ctx.arc(cx, cy, d / 2, 0, Math.PI * 2); ctx.lineWidth = 2 * K; ctx.strokeStyle = '#FFFFFF'; ctx.stroke();
              tx = barX + 6 * K + d + 10 * K;
            }
            ctx.font = font(700, 16); ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'left'; ctx.fillText('ร้านคุณ', tx, y + rowH / 2);
          } else if (row.kind === 'was') {
            rr(barX + K, y + K, barW - 2 * K, rowH - 2 * K, 12 * K, null, '#D9D2CB');
            ctx.font = font(600, 14); ctx.fillStyle = '#8A827B'; ctx.textAlign = 'left'; ctx.fillText('สัปดาห์ก่อน', barX + 12 * K, y + rowH / 2);
          } else rr(barX, y, barW, rowH, 12 * K, '#EFEBE7');
        }
        y += rowH + 6 * K;
      }
      y -= 6 * K;
    }
    // calls
    y += 16 * K;
    const boxH = 54 * K;
    if (draw) {
      rr(P, y, W - 2 * P, boxH, 16 * K, '#F7F5F2');
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = `${26 * K}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
      ctx.fillText('📞', P + 16 * K, y + boxH / 2);
      ctx.font = font(700, 17); ctx.fillStyle = '#14110F'; ctx.fillText(c.calls, P + 56 * K, y + boxH / 2);
    }
    y += boxH;
    // The rest of the report, readable without opening anything (Art 2026-11-17/20): this week's work, where the
    // shop is shown, next week's plan. Plain lines, no chips, no numbers.
    // Three steps of attention under the approved top (Art 2026-11-20 review): the work done is the proof, so it gets
    // the blue ticks; where the shop is shown is plain; next week is quieter. Titles in Ease blue, like the group
    // headings on the paper and the Nearby page. Status words "(กำลังทำ)" / "(ตัวอย่าง)" are grey so the item reads first.
    const mark = (kind, cy) => {
      if (!draw) return;
      const cx = P + 8 * K;
      ctx.save();
      if (kind === 'done') {
        ctx.strokeStyle = '#2D55EB'; ctx.lineWidth = 2.6 * K; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath(); ctx.moveTo(cx - 6 * K, cy); ctx.lineTo(cx - 1.5 * K, cy + 4.5 * K); ctx.lineTo(cx + 7 * K, cy - 5 * K); ctx.stroke();
      } else if (kind === 'next') {
        ctx.strokeStyle = '#B5ADA6'; ctx.lineWidth = 2 * K; ctx.beginPath(); ctx.arc(cx, cy, 5 * K, 0, Math.PI * 2); ctx.stroke();
      } else { ctx.fillStyle = '#14110F'; ctx.beginPath(); ctx.arc(cx, cy, 3 * K, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    };
    const item = (kind, line) => {
      const m = String(line).match(/^(.*?)\s*(\([^)]*\))?$/);
      const main = m[1], status = m[2] || '';
      const x = P + 26 * K, maxW = W - P - x, lh = 23;
      const f = font(kind === 'next' ? 500 : 600, 15), color = kind === 'next' ? '#6B635D' : '#14110F';
      ctx.font = f;
      const lines = wrapLines(ctx, main, maxW);
      mark(kind, y + 8.5 * K);
      lines.forEach((l, i) => { if (draw) { ctx.font = f; ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(l, x, y + i * lh * K); } });
      let lastW = ctx.measureText(lines[lines.length - 1] || '').width;
      y += (lines.length - 1) * lh * K;
      if (status) {
        ctx.font = font(500, 14);
        const sw = ctx.measureText(status).width;
        if (lastW + 6 * K + sw > maxW) { y += lh * K; lastW = -6 * K; }
        if (draw) { ctx.fillStyle = '#8A827B'; ctx.textBaseline = 'top'; ctx.fillText(status, x + lastW + 6 * K, y + 1 * K); }
      }
      y += lh * K + 6 * K;
    };
    const section = (title, kind, lines) => {
      if (!lines.length) return;
      y += 16 * K;
      if (draw) { ctx.fillStyle = '#EFEBE7'; ctx.fillRect(P, y, W - 2 * P, 1.5 * K); }
      y += 16 * K;
      text(title, font(700, 15), '#2D55EB', 22);
      y += 8 * K;
      for (const line of lines) item(kind, line);
      y -= 6 * K;
    };
    section('สัปดาห์นี้เราทำให้ร้าน', 'done', [...(c.done || []), ...(c.doneMore ? [`และอีก ${c.doneMore} งาน`] : [])]);
    section('ร้านคุณอยู่ที่', 'on', c.shownOn || []);
    section('สัปดาห์หน้าเราจะทำ', 'next', c.next || []);
    // No button on the picture: it is read in the chat as it is; the report link is sent as a message after it.
    y += P;
    return y;
  };
  const H = paint(false);
  canvas.width = W; canvas.height = H;
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);
  paint(true);
  return new Promise((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error('toBlob failed'))), 'image/png'));
}

