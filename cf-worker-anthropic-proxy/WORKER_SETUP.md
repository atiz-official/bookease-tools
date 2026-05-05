# 🛠 Phase A · Cloudflare Worker setup · 5 นาที (Art ทำ)

> **Goal:** ใส่ Anthropic API key ฝั่ง server · tool พร้อมใช้สำหรับใครก็ได้
> โดยไม่ต้องตั้ง API key ฝั่ง user เลย
>
> **Time:** 5 นาที · CF dashboard
> **Skill:** ไม่ต้องเขียนโค้ด · paste + click

---

## ขั้นตอน 5 ขั้น

### Step 1 · ล็อกอิน Cloudflare dashboard

URL: https://dash.cloudflare.com

ใช้ account ที่เป็นของ Atiz (มี zone bookease.co อยู่แล้ว)

---

### Step 2 · สร้าง Worker

1. Sidebar ซ้าย → คลิก **"Workers & Pages"**
2. คลิกปุ่ม **"Create"** หรือ **"Create application"**
3. เลือก **"Create Worker"** (NOT Pages)
4. ตั้งชื่อ: `bookease-anthropic-proxy`
   - URL จะเป็น: `bookease-anthropic-proxy.<your-subdomain>.workers.dev`
   - จดเก็บไว้ · จะเอาไปใส่ใน menu-ocr.html ทีหลัง
5. คลิก **"Deploy"** (default code โอเค · ยังไม่ใส่ logic)

---

### Step 3 · Paste worker code

1. หลัง deploy → คลิก **"Edit code"** (หรือไอคอนดินสอ)
2. ลบ code default ทั้งหมด
3. Paste code จากไฟล์ **`worker.js`** ในโฟลเดอร์เดียวกันนี้
   - ใน VS Code: `cf-worker-anthropic-proxy/worker.js` → Ctrl+A · Ctrl+C
   - Paste ใน CF editor
4. คลิก **"Deploy"** หรือ **"Save and Deploy"**

---

### Step 4 · ตั้ง environment variable (Anthropic key)

1. หลัง deploy → คลิก tab **"Settings"** ของ Worker
2. หา section **"Variables and Secrets"** (หรือ "Environment Variables")
3. คลิก **"Add"** หรือ **"+"**
4. Type: **"Secret"** (NOT plaintext · ต้องเป็น secret)
5. Name: `ANTHROPIC_KEY`
6. Value: paste Anthropic API key (sk-ant-api03-...)
7. คลิก **"Save"**
8. **Deploy ใหม่** เพื่อ apply env var (CF อาจขอ deploy หลังเพิ่ม env)

---

### Step 5 · (Optional) Rate limiting · KV namespace

ถ้าอยากจำกัด IP บางคนเรียกเกิน 50 ครั้ง/วัน:

1. Sidebar → **"Workers & Pages"** → **"KV"**
2. **"Create namespace"** ตั้งชื่อ: `bookease-rate-limit`
3. Save · จดชื่อ namespace
4. กลับไปที่ Worker → **"Settings"** → **"Bindings"**
5. **"Add"** → เลือก **"KV Namespace"**
6. Variable name: `RATE_LIMIT` (ตัวพิมพ์ใหญ่ทั้งหมด · ตรงกับ code)
7. Namespace: เลือก `bookease-rate-limit`
8. Save · Deploy ใหม่

ถ้า skip step 5 ก็ได้ · Worker จะ pass-through ทุก request · ค่าใช้จ่ายควบคุมโดย Anthropic budget cap แทน

---

## ขั้นตอนสุดท้าย · บอก Claude URL

หลัง Step 4 (หรือ 5) เสร็จ · ทดสอบด้วย curl:

```bash
curl -X POST https://bookease-anthropic-proxy.<your-subdomain>.workers.dev/ \
  -H "Origin: https://atiz-official.github.io" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 100,
    "messages": [{"role":"user","content":"Hello"}]
  }'
```

ผลลัพธ์ควรได้ JSON ที่ Anthropic ตอบ

**บอกผม URL Worker** (`bookease-anthropic-proxy.xxx.workers.dev`)
ผมจะ:
1. ใส่ใน `WORKER_URL` constant ใน `menu-ocr.html`
2. Push commit
3. tool เปลี่ยนเป็น "ใครก็ใช้ได้ · zero setup" mode ทันที
4. Admin panel ในหน้า OCR หายไปเอง

---

## ข้อมูลเพิ่มเติม

### Cost expectation
- ทุก Worker request ฟรี 100K/day (CF Workers free tier)
- Anthropic Sonnet 4 vision call ~$0.04
- 1 merchant signup ≈ 2 calls = $0.08
- 1,000 signups/month ≈ $80 · trivial

### Origin whitelist (ปรับได้ใน worker.js)
```js
const ALLOWED_ORIGINS = [
  'https://atiz-official.github.io',
  'https://shop.bookease.co',
  'https://shopv3.bookease.co',
  'https://bookease.co',
];
```
ถ้าจะ host บน custom domain (เช่น `tools.bookease.co`) เพิ่มใน array นี้

### Custom domain (optional · later)
ถ้าอยากให้ URL สั้นกว่า workers.dev:
1. Cloudflare → Worker → **Triggers** → **"Add Custom Domain"**
2. Type: `proxy.bookease.co` (จะออก SSL อัตโนมัติ)
3. ใช้ URL นี้แทน workers.dev URL ใน menu-ocr.html

### Monitoring
- CF Dashboard → Worker → **"Metrics"** เห็นจำนวน requests/วัน
- ถ้า abuse · เพิ่ม rate limit ใน worker.js หรือ block specific IP

---

## Rollback

ถ้ามีปัญหา:
1. ตั้ง `WORKER_URL = ''` ใน menu-ocr.html (ผม push 1 commit)
2. Tool fallback กลับเป็นโหมด localStorage admin key เหมือนเดิม
3. Worker ยังอยู่ · ปิดได้ใน CF dashboard ภายหลัง
