// Search numbers shared by the Radar report (index.html), the Home "สำรวจย่าน" strip and the Guide,
// so every page shows the same figure for the same area (Art 2026-11-17).
//
// "Near me" searches: Google Keyword Planner gives them for all of Bangkok only, never per area.
// Source: Keyword Planner, Bangkok, 12-month average, pulled 2026-11-15
// (bookease-official tools/merchant-discovery/out/generic-volumes-raw-bangkok-2026-11-15.txt).
// Each area gets a share in proportion to its own area-name searches:
//   near-me ≈ area-name searches × (Bangkok near-me ÷ all area-name searches we hold for that type)
// NAMED_BKK = sum of `total` over every area + district in cf-worker-maps-report/areas-data.js (pulled 2026-11-14):
//   massage 57,070 + 5,210 · salon 3,900 + 620 · barber 19,030 + 1,460 · nail 5,280 + 230 · clinic 2,550 + 300 · tattoo 1,450 + 40.
// Our areas do not cover all of Bangkok, so the share leans high: always shown with "≈", never as a measurement.
// Searches for a shop's own name are never in these numbers (only the shop's Google Business Profile has them).
window.RadarVolume = (() => {
  const NEAR_ME_BKK = {
    massage: { k: 'ร้านนวดใกล้ฉัน', v: 200400 },   // ร้านนวด/นวด/นวดไทย/สปา ใกล้ฉัน
    salon: { k: 'ร้านเสริมสวยใกล้ฉัน', v: 24520 },  // ร้านเสริมสวย/ร้านทำผม/เสริมสวย/ทำผม ใกล้ฉัน
    barber: { k: 'ร้านตัดผมใกล้ฉัน', v: 130520 },   // ร้านตัดผม/ร้านตัดผมชาย/ตัดผม/บาร์เบอร์ ใกล้ฉัน
    nail: { k: 'ร้านทำเล็บใกล้ฉัน', v: 15200 },     // ร้านทำเล็บ/ร้านเล็บ/ทำเล็บ ใกล้ฉัน
    clinic: { k: 'คลินิกความงามใกล้ฉัน', v: 7300 }, // คลินิกความงาม/คลินิกเสริมความงาม ใกล้ฉัน
    tattoo: { k: 'ร้านสักใกล้ฉัน', v: 8100 },
  };
  const NAMED_BKK = { massage: 62280, salon: 4520, barber: 20490, nail: 5510, clinic: 2850, tattoo: 1490 };
  /** The near-me share for an area, rounded to tens; 0 when we have no figure for the type. */
  function nearShare(catId, areaTotal) {
    const nm = NEAR_ME_BKK[catId], all = NAMED_BKK[catId];
    if (!nm || !all || !areaTotal) return 0;
    return Math.round((areaTotal * nm.v / all) / 10) * 10;
  }
  return { NEAR_ME_BKK, NAMED_BKK, nearShare, total: (catId, areaTotal) => areaTotal + nearShare(catId, areaTotal) };
})();
