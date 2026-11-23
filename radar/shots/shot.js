// Shop Radar · shows the real Google Maps picture of the shop (taken by radar/shots/capture.mjs) on the report and offer pages.
// Usage: radarShot(element, placeId, baseUrl) — baseUrl is the folder that holds index.json ('shots/' from the report, '../shots/' from the offer).
// No picture for this shop → the element stays hidden and the page looks as before.
(function () {
  const TH_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const thDay = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${TH_MONTH[m - 1]} ${String(y + 543).slice(-2)}`; };
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let indexPromise = null;
  const CSS = `
.gshot{display:grid;grid-template-columns:minmax(0,340px) 1fr;gap:18px 32px;align-items:start}
.gshot>div:last-child{border-left:1px solid #E3E6EC;padding:6px 0 6px 32px;align-self:stretch}
.gshot h3{grid-column:1/-1;font-size:17px;font-weight:800;line-height:1.35}
.gshot a.pic{display:block;border-radius:14px;overflow:hidden;border:1px solid #E3E6EC;line-height:0}
.gshot img{width:100%;height:auto;display:block}
.gshot h4{font-size:18px;font-weight:800;line-height:1.35;margin:0 0 20px}
.gshot ul{list-style:none;display:flex;flex-direction:column;gap:20px;padding:0;margin:0}
.gshot li{display:flex;gap:14px;align-items:flex-start;font-size:16.5px;font-weight:600;line-height:1.45;color:#0A0A0A}
.gshot li em{display:block;font-style:normal;font-weight:500;font-size:14.5px;color:#6B7383;margin-top:2px;word-break:break-all}
.gshot li.warn{color:#92400E}
.gshot li i{flex:none;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin-top:-1px}
.gshot li.ok i{background:#16A34A}.gshot li.warn i{background:#F5A70B}
.gshot li i svg{width:14px;height:14px;color:#fff}
.gshot small{display:block;margin-top:22px;color:#6B7383;font-size:13px}
.gshot small span{white-space:nowrap}
@media (max-width:560px){.gshot{grid-template-columns:1fr;gap:18px}.gshot a.pic{max-width:340px}.gshot>div:last-child{border-left:0;border-top:1px solid #E3E6EC;padding:20px 0 0}}
.gshot.compact{grid-template-columns:44% 1fr;gap:12px 16px}
.gshot.compact>div:last-child{border-left:0;border-top:0;padding:0}
.gshot.compact li em{font-size:12.5px}
.gshot.compact h3{font-size:15.5px}
.gshot.compact li{font-size:13.5px;gap:8px}
.gshot.compact h4{font-size:15px;margin-bottom:12px}
.gshot.compact ul{gap:12px}
.gshot.compact a.pic{max-width:none}
.gshot .pic.wait{display:flex;align-items:center;justify-content:center;aspect-ratio:456/640;max-width:340px;background:linear-gradient(100deg,#F3F5F8 30%,#E9EDF3 50%,#F3F5F8 70%);background-size:300% 100%;animation:gshot-wait 1.6s ease-in-out infinite;color:#6B7383;font-size:14px;line-height:1.4;padding:16px;text-align:center}
@keyframes gshot-wait{from{background-position:100% 0}to{background-position:0 0}}
@media (prefers-reduced-motion:reduce){.gshot .pic.wait{animation:none}}`;

  // Solid round icons beside each finding: a white tick on green (found), a white "!" on amber (not found / to fix).
  const ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const ICON_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round"><path d="M12 5v9"/><path d="M12 19.2v.1"/></svg>';
  // "main\n(detail)": the detail goes on a small grey line; digits stay together.
  const lines = (t) => { const [a, ...b] = String(t).split('\n'); const k = (x) => esc(x).replace(/(\d) (?=\d)/g, '$1\u00a0'); return k(a) + (b.length ? `<em>${k(b.join(' '))}</em>` : ''); };
  // One picture block, from either source: the batch files in this folder, or the worker (the iMac shoots every new report).
  function paint(el, placeId, shot, src, opts) {
    const maps = `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`;
    el.innerHTML = `<div class="gshot${opts && opts.compact ? ' compact' : ''}">
        <h3>นี่คือหน้าร้านของคุณบน Google Maps</h3>
        <a class="pic" href="${maps}" target="_blank" rel="noopener"><img src="${src}" alt="หน้าร้าน ${esc(shot.name || '')} บน Google Maps"></a>
        <div><h4>สรุปที่ตรวจพบ</h4><ul>${shot.marks.map((m) => { const warn = m.kind === 'warn';
          return `<li class="${warn ? 'warn' : 'ok'}"><i aria-hidden="true">${warn ? ICON_WARN : ICON_OK}</i><span>${lines(m.text)}</span></li>`; }).join('')}</ul>
        <small>ภาพจาก Google Maps · <span>${thDay(shot.date)}</span></small></div>
      </div>`;
    el.hidden = false;
  }
  // While the iMac is taking the picture: a quiet placeholder of the same size, so nothing jumps when it lands.
  function waiting(el, opts) {
    el.innerHTML = `<div class="gshot${opts && opts.compact ? ' compact' : ''}">
        <h3>นี่คือหน้าร้านของคุณบน Google Maps</h3>
        <div class="pic wait" aria-live="polite"><span>กำลังเปิดหน้า Google Maps ของร้านคุณ…</span></div>
      </div>`;
    el.hidden = false;
  }
  const WAIT_MS = 3 * 60 * 1000; // give up quietly after this: the report stays as it is
  function fromWorker(el, placeId, opts) {
    const api = opts && opts.api;
    if (!api) return;
    const started = Date.now();
    const tick = () => fetch(`${api}/shot?p=${encodeURIComponent(placeId)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { status: 'none' }))
      .then((st) => {
        if (st.status === 'ready' && Array.isArray(st.marks)) return paint(el, placeId, st, `${api}/shot/img?p=${encodeURIComponent(placeId)}&d=${encodeURIComponent(st.date)}`, opts);
        if (st.status === 'pending' && Date.now() - started < WAIT_MS) {
          if (el.hidden) waiting(el, opts);
          setTimeout(tick, Date.now() - started < 30000 ? 2500 : 6000);
          return;
        }
        el.hidden = true; // none, or waited long enough
      })
      .catch((e) => { console.error('[radarShot] worker', e); el.hidden = true; });
    tick();
  }

  window.radarShot = function (el, placeId, base, opts) {
    if (!el || !placeId) return;
    if (!document.getElementById('gshot-css')) { const st = document.createElement('style'); st.id = 'gshot-css'; st.textContent = CSS; document.head.appendChild(st); }
    indexPromise = indexPromise || fetch(`${base}index.json`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {})).catch((e) => { console.error('[radarShot] index.json', e); return {}; });
    indexPromise.then((index) => {
      const shot = index[placeId];
      if (shot) paint(el, placeId, shot, `${base}${encodeURIComponent(placeId)}.jpg?d=${encodeURIComponent(shot.date)}`, opts);
      else fromWorker(el, placeId, opts);
    });
  };
}());
