# Utahana Instagram Chatbot (Node.js + Express + Gemini)

## โครงสร้าง
- `server.js` – webhook, ส่งข้อความ IG, เรียก Gemini, ความจำแชท
- `persona.js` – System Instruction ของ 藤原 歌花 (แก้นิสัยที่นี่)
- `package.json`, `.env.example`

## Environment Variables
| ชื่อ | ความหมาย |
|---|---|
| VERIFY_TOKEN | ค่าเดียวกับที่กรอกในหน้า Webhook ของ Meta |
| IG_ACCESS_TOKEN | Instagram access token |
| GEMINI_API_KEY | API key จาก Google AI Studio |
| MODEL | ชื่อโมเดล (ค่าเริ่มต้น `gemini-2.5-flash`) |
| APP_SECRET | (ไม่บังคับ) ใช้ตรวจลายเซ็น webhook |
| PORT | Render ตั้งให้เอง |

## Deploy บน Render (แนะนำ)
1. อัปโหลดโค้ดขึ้น GitHub (อย่าใส่ไฟล์ `.env`)
2. Render → New → **Web Service** → เลือก repo
3. Runtime: Node | Build: `npm install` | Start: `npm start` | Plan: Free
4. เพิ่ม Environment Variables ตามตารางด้านบน
5. Deploy เสร็จจะได้ URL เช่น `https://xxx.onrender.com`
6. Meta Developer → Instagram → Webhooks:
   - Callback URL: `https://xxx.onrender.com/webhook`
   - Verify token: ค่า `VERIFY_TOKEN`
   - Subscribe ฟิลด์ `messages`
7. ลองส่ง DM ไปที่บัญชี IG ที่เชื่อมไว้

### หมายเหตุ Render Free
- เซิร์ฟเวอร์จะหลับเมื่อไม่มีคนใช้ ข้อความแรกอาจช้า 30-60 วินาที (ใช้ UptimeRobot ping `/health` ทุก 5 นาทีช่วยได้)
- ความจำแชทอยู่ใน RAM จะหายเมื่อเซิร์ฟเวอร์หลับ/รีสตาร์ต

### Vercel
ไม่แนะนำ เพราะเป็น serverless: ความจำใน RAM ไม่คงอยู่ และงานที่ทำหลังตอบ 200 อาจถูกตัดกลางคัน
