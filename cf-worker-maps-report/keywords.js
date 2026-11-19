// Search word for a shop that is not one of the Radar's own types (massage, salon, barber, nail, clinic, tattoo).
// Fully automatic: the owner is never asked what kind of shop they run (Art 2026-11-18). Signals, strongest first:
//   1. Google's primary type, when we know the word Thai people type for it
//   2. a word in the shop's name           ("ยาหยีรถเช่า", "Car Rental")
//   3. Google's other types, when we know the word
//   4. Google's own Thai type name, unless it is a catch-all like "บริการ"
//   5. words in the shop's Google reviews  (one extra Google call, only when 1–4 found nothing)
// Why: YAYEE Motorbike & Car Rental (Hua Hin) is filed by Google only as point_of_interest / service /
// establishment, Thai name "บริการ". The Radar searched "บริการ" and ranked the shop against laundromats and a
// petrol station: 40+ everywhere, a meaningless report (Art 2026-11-18).
// None of these words has been compared with the Google Maps app yet (only "ร้านนวด" has, 2026-11-14).

/** Google types that say nothing about what the shop sells. Never searched. */
export const GENERIC_TYPES = new Set([
  'point_of_interest', 'establishment', 'service', 'store', 'food', 'health', 'finance', 'business',
  'corporate_office', 'premise', 'local_government_office', 'locality', 'political',
]);

/** Google Thai type names that are just as empty. Never searched. */
const GENERIC_NAMES = new Set(['บริการ', 'ร้านค้า', 'สถานที่', 'ธุรกิจ', 'บริษัท', 'สำนักงาน', 'อาหาร', 'สุขภาพ', 'การเงิน', 'จุดที่น่าสนใจ', 'สถานประกอบการ']);

/**
 * Google types too wide to beat the name: "japanese_restaurant" + "Shizen Shabu" → "ชาบู",
 * "tour_agency" + "Princess Divers - Scuba Diving" → "ดำน้ำ" (both checked on real listings 2026-11-18).
 */
const BROAD = new Set(['restaurant', 'lodging', 'hotel', 'doctor', 'medical_clinic', 'medical_center', 'hospital', 'bar', 'cafe',
  'tour_agency', 'travel_agency']);
const isBroad = (t) => BROAD.has(t) || /_restaurant$/.test(t);

/** Google type → the words Thai people type into Maps. */
export const TYPE_WORDS = {
  // vehicles
  car_rental: 'รถเช่า', car_repair: 'อู่ซ่อมรถ', car_wash: 'ล้างรถ', // Google: "บริการล้างรถ"; คาร์แคร์ = coating/detailing, only from the name auto_parts_store: 'ร้านอะไหล่รถยนต์',
  // health
  dentist: 'คลินิกทันตกรรม', dental_clinic: 'คลินิกทันตกรรม', veterinary_care: 'คลินิกสัตว์',
  physiotherapist: 'กายภาพบำบัด', chiropractor: 'กายภาพบำบัด', doctor: 'คลินิกเวชกรรม', medical_clinic: 'คลินิกเวชกรรม',
  medical_center: 'คลินิกเวชกรรม', hospital: 'โรงพยาบาล', pharmacy: 'ร้านขายยา', drugstore: 'ร้านขายยา',
  // fitness
  gym: 'ฟิตเนส', fitness_center: 'ฟิตเนส', yoga_studio: 'โยคะ', swimming_pool: 'สระว่ายน้ำ',
  // food and drink
  cafe: 'คาเฟ่', coffee_shop: 'คาเฟ่', cat_cafe: 'คาเฟ่แมว', dog_cafe: 'คาเฟ่หมา', bakery: 'ร้านเบเกอรี่',
  dessert_shop: 'ร้านของหวาน', dessert_restaurant: 'ร้านของหวาน', ice_cream_shop: 'ร้านไอศกรีม', tea_house: 'ร้านชา',
  restaurant: 'ร้านอาหาร', thai_restaurant: 'ร้านอาหารไทย', japanese_restaurant: 'ร้านอาหารญี่ปุ่น',
  sushi_restaurant: 'ร้านซูชิ', ramen_restaurant: 'ราเมน', korean_restaurant: 'ร้านอาหารเกาหลี',
  korean_barbecue_restaurant: 'ปิ้งย่างเกาหลี', chinese_restaurant: 'ร้านอาหารจีน', italian_restaurant: 'ร้านอาหารอิตาเลียน',
  pizza_restaurant: 'พิซซ่า', seafood_restaurant: 'ร้านอาหารทะเล', steak_house: 'สเต็ก', barbecue_restaurant: 'ร้านปิ้งย่าง',
  buffet_restaurant: 'บุฟเฟ่ต์', vegetarian_restaurant: 'ร้านอาหารมังสวิรัติ', vegan_restaurant: 'ร้านอาหารมังสวิรัติ',
  indian_restaurant: 'ร้านอาหารอินเดีย', vietnamese_restaurant: 'ร้านอาหารเวียดนาม', hamburger_restaurant: 'ร้านเบอร์เกอร์',
  breakfast_restaurant: 'ร้านอาหารเช้า', brunch_restaurant: 'ร้านอาหารเช้า',
  bar: 'บาร์', pub: 'ผับ', wine_bar: 'ไวน์บาร์', night_club: 'ผับ', karaoke: 'คาราโอเกะ',
  // stays and trips
  hotel: 'โรงแรม', lodging: 'ที่พัก', resort_hotel: 'รีสอร์ท', hostel: 'โฮสเทล', guest_house: 'ที่พัก',
  bed_and_breakfast: 'ที่พัก', motel: 'ที่พัก', inn: 'ที่พัก', travel_agency: 'ทัวร์', tour_agency: 'ทัวร์',
  // other services
  laundry: 'ร้านซักผ้า', florist: 'ร้านดอกไม้', photographer: 'ร้านถ่ายรูป', driving_school: 'โรงเรียนสอนขับรถ',
  language_school: 'โรงเรียนสอนภาษา', moving_company: 'รถรับจ้างขนของ', electrician: 'ช่างไฟ', plumber: 'ช่างประปา',
  locksmith: 'ร้านทำกุญแจ', storage: 'ห้องเก็บของให้เช่า', pet_store: 'ร้านขายสัตว์เลี้ยง', cell_phone_store: 'ร้านมือถือ',
  bicycle_store: 'ร้านจักรยาน', furniture_store: 'ร้านเฟอร์นิเจอร์', hardware_store: 'ร้านวัสดุก่อสร้าง',
  jewelry_store: 'ร้านเครื่องประดับ', clothing_store: 'ร้านเสื้อผ้า',
};

/**
 * Words in a shop's name or reviews → search word. Most specific first: the first rule that matches the
 * name wins; in reviews the rule matched most often wins.
 */
export const NAME_WORDS = [
  [/เช่า\s*(รถ\s*)?(มอเตอร์ไซ|มอไซ|จักรยานยนต์)|(มอเตอร์ไซ|มอไซ)\S*\s*เช่า|motor\s*(bike|cycle)\s*rent|scooter\s*rent|bike\s*rental/i, 'เช่ามอเตอร์ไซค์'],
  [/รถตู้/, 'รถตู้เช่า'],
  [/รถเช่า|เช่ารถ|car\s*rent|rent\s*a\s*car|rental\s*car|car\s*hire/i, 'รถเช่า'],
  [/เช่าเรือ|boat\s*(rent|charter)|speed\s*boat/i, 'เช่าเรือ'],
  [/ดำน้ำ|diving|snorkel/i, 'ดำน้ำ'],
  [/ซ่อมมือถือ|phone\s*repair/i, 'ร้านซ่อมมือถือ'],
  [/อู่ซ่อม|ซ่อมรถ|car\s*repair|auto\s*(repair|service)|garage/i, 'อู่ซ่อมรถ'],
  [/คาร์แคร์|เคลือบแก้ว|เคลือบสี|car\s*care|detailing|coating/i, 'คาร์แคร์'],
  [/ล้างรถ|ล้างด่วน|car\s*wash/i, 'ล้างรถ'],
  [/ร้านยาง|ยางรถ|\btyres?\b|\btires?\b/i, 'ร้านยาง'],
  [/ล้างแอร์|ซ่อมแอร์|air\s*con/i, 'ล้างแอร์'],
  [/ขนของ|ย้ายบ้าน|moving/i, 'รถรับจ้างขนของ'],
  [/สะดวกซัก|ซักผ้า|ซักรีด|laundr/i, 'ร้านซักผ้า'],
  [/ทันตก|ทำฟัน|จัดฟัน|หมอฟัน|dental|dentist/i, 'คลินิกทันตกรรม'],
  [/สัตวแพทย์|รักษาสัตว์|คลินิกสัตว์|โรงพยาบาลสัตว์|\bvet\b/i, 'คลินิกสัตว์'],
  [/อาบน้ำ\S*\s*(หมา|สุนัข|แมว)|ตัดขน|grooming/i, 'อาบน้ำตัดขนสุนัข'],
  [/กายภาพ|physio/i, 'กายภาพบำบัด'],
  [/ต่อขนตา|eyelash|\blash/i, 'ต่อขนตา'],
  [/สักคิ้ว|\bbrows?\b/i, 'สักคิ้ว'],
  [/มวยไทย|muay\s*thai/i, 'ค่ายมวย'],
  [/โยคะ|yoga/i, 'โยคะ'],
  [/พิลาทิส|pilates/i, 'พิลาทิส'],
  [/ฟิตเนส|fitness|\bgym\b|ยิม/i, 'ฟิตเนส'],
  [/สอนว่ายน้ำ|swim(ming)?\s*(school|lesson|class)/i, 'สอนว่ายน้ำ'],
  [/กวดวิชา|สอนพิเศษ|tutor/i, 'โรงเรียนกวดวิชา'],
  [/สอนดนตรี|music\s*school|สอนเปียโน|สอนกีตาร์/i, 'โรงเรียนสอนดนตรี'],
  [/สอนขับรถ|driving\s*school/i, 'โรงเรียนสอนขับรถ'],
  [/ถ่ายรูป|ถ่ายภาพ|photo\s*studio|photograph/i, 'ร้านถ่ายรูป'],
  [/เช่าชุด/i, 'เช่าชุด'],
  [/ตัดชุด|ห้องเสื้อ|ตัดเสื้อ|tailor/i, 'ร้านตัดชุด'],
  [/แว่นตา|ร้านแว่น|optic|eyewear/i, 'ร้านแว่นตา'],
  [/ดอกไม้|florist|flower/i, 'ร้านดอกไม้'],
  [/ร้านขายยา|ร้านยา|เภสัช|pharmacy/i, 'ร้านขายยา'],
  [/หมูกระทะ/, 'หมูกระทะ'],
  [/ชาบู|shabu|สุกี้/i, 'ชาบู'],
  [/ปิ้งย่าง|yakiniku|\bbbq\b|barbecue/i, 'ร้านปิ้งย่าง'],
  [/ซูชิ|sushi|โอมากาเสะ|omakase/i, 'ร้านซูชิ'],
  [/ราเมง|ราเมน|ramen/i, 'ราเมน'],
  [/ส้มตำ/, 'ร้านส้มตำ'],
  [/ก๋วยเตี๋ยว|noodle/i, 'ร้านก๋วยเตี๋ยว'],
  [/ซีฟู้ด|อาหารทะเล|seafood/i, 'ร้านอาหารทะเล'],
  [/เบเกอรี่|bakery|ร้านเค้ก|cake/i, 'ร้านเบเกอรี่'],
  [/คาเฟ่|\bcaf[eé]\b|coffee|กาแฟ/i, 'คาเฟ่'],
  [/พูลวิลล่า|pool\s*villa/i, 'พูลวิลล่า'],
  [/รีสอร์ท|resort/i, 'รีสอร์ท'],
  [/โฮมสเตย์|homestay/i, 'โฮมสเตย์'],
  [/โฮสเทล|hostel|เกสต์เฮาส์|guest\s*house/i, 'ที่พัก'],
  [/โรงแรม|hotel/i, 'โรงแรม'],
  [/ทัวร์|\btours?\b|travel/i, 'ทัวร์'],
  [/คาราโอเกะ|karaoke/i, 'คาราโอเกะ'],
  [/ร้านอาหาร|restaurant|kitchen/i, 'ร้านอาหาร'],
  [/คลินิกเด็ก|หมอเด็ก|กุมาร|pediatric|paediatric|\bkids?\b.*clinic/i, 'คลินิกเด็ก'],
  [/แพทย์แผนไทย|แผนไทย|thai\s*traditional/i, 'คลินิกแพทย์แผนไทย'],
  [/เวชกรรม|คลินิกแพทย์|คลินิกหมอ|medical\s*clinic|\bgp\b/i, 'คลินิกเวชกรรม'],
  [/คลินิก|clinic/i, 'คลินิกเวชกรรม'],
];

/** The first rule that matches the text, or null. */
export function wordFromName(text) {
  const t = String(text || '');
  const hit = NAME_WORDS.find(([re]) => re.test(t));
  return hit ? hit[1] : null;
}

/**
 * The rule that matches the most reviews. `extra` = more [regex, value] rules tried first on a tie
 * (the Radar's own types, so a reviewed "massage" shop still gets its type and its search volume).
 * Returns { value, hits } or null.
 */
export function wordFromReviews(texts, extra = []) {
  const rules = extra.concat(NAME_WORDS);
  let best = null;
  rules.forEach(([re, value], i) => {
    const hits = texts.filter((t) => re.test(String(t || ''))).length;
    if (hits && (!best || hits > best.hits)) best = { value, hits, i };
  });
  return best && { value: best.value, hits: best.hits };
}

/** Google Thai type name → what people type ("ภัตตาคารอาหารไทย" → "ร้านอาหารไทย"). */
export function searchTerm(googleName) {
  const n = String(googleName || '').trim();
  if (!n.startsWith('ภัตตาคาร')) return n;
  const rest = n.slice('ภัตตาคาร'.length).trim();
  return rest ? `ร้าน${rest}` : 'ร้านอาหาร'; // ภัตตาคารอาหารไทย → ร้านอาหารไทย · ภัตตาคารซูชิ → ร้านซูชิ
}

export const isGenericName = (n) => !n || GENERIC_NAMES.has(String(n).trim());

/**
 * Search word from the listing alone (steps 1–4), no extra Google call.
 * Returns { label, from } or null when only the reviews can tell.
 */
export function wordFromListing(shopRaw) {
  const primary = shopRaw.primaryType || '';
  const types = (shopRaw.types || []).filter((t) => !GENERIC_TYPES.has(t));
  const name = (shopRaw.displayName && shopRaw.displayName.text) || '';
  const googleName = (shopRaw.primaryTypeDisplayName && shopRaw.primaryTypeDisplayName.text) || '';
  if (TYPE_WORDS[primary] && !isBroad(primary)) return { label: TYPE_WORDS[primary], from: 'type' };
  const byName = wordFromName(name);
  if (byName) return { label: byName, from: 'name' };
  if (TYPE_WORDS[primary]) return { label: TYPE_WORDS[primary], from: 'type' };
  const t = types.find((x) => TYPE_WORDS[x]);
  if (t) return { label: TYPE_WORDS[t], from: 'type' };
  if (primary && !GENERIC_TYPES.has(primary) && !isGenericName(googleName)) return { label: searchTerm(googleName), from: 'google' };
  return null;
}
