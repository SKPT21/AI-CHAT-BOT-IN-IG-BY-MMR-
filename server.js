const express = require("express");
const crypto = require("crypto");
const { GoogleGenAI } = require("@google/genai");
const { SYSTEM_INSTRUCTION } = require("./persona");

// ---------- Config (ทั้งหมดดึงจาก Environment Variables) ----------
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.MODEL || "gemini-2.5-flash";
const APP_SECRET = process.env.APP_SECRET || ""; // ไม่บังคับ: ถ้าใส่ จะตรวจลายเซ็น webhook
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";
// token ขึ้นต้น IGAA... ใช้ https://graph.instagram.com
// token ขึ้นต้น EAA...  ใช้ https://graph.facebook.com
const IG_API_HOST = process.env.IG_API_HOST || "https://graph.instagram.com";

const MAX_HISTORY = 20; // จำข้อความล่าสุดสูงสุด 20 messages
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 ชั่วโมง
const IG_MAX_CHARS = 900; // ข้อความ IG จำกัด ~1000 bytes

for (const [k, v] of Object.entries({ VERIFY_TOKEN, IG_ACCESS_TOKEN, GEMINI_API_KEY })) {
  if (!v) console.warn(`[config] Missing env var: ${k}`);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const app = express();

// เก็บ raw body ไว้ตรวจลายเซ็น
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ---------- Session Memory (In-memory) ----------
// sessions: senderId -> { history: [{role, parts:[{text}]}], lastActive: ms }
const sessions = new Map();
const processedMids = new Map(); // กันประมวลผลข้อความซ้ำ (Meta ส่ง retry)

function getSession(senderId) {
  const now = Date.now();
  let s = sessions.get(senderId);
  if (!s || now - s.lastActive > SESSION_TTL_MS) {
    s = { history: [], lastActive: now };
    sessions.set(senderId, s);
  }
  return s;
}

function pushHistory(session, role, text) {
  session.history.push({ role, parts: [{ text }] });
  if (session.history.length > MAX_HISTORY) {
    session.history.splice(0, session.history.length - MAX_HISTORY);
  }
  // Gemini ต้องการให้ history เริ่มด้วย role "user"
  while (session.history.length && session.history[0].role !== "user") {
    session.history.shift();
  }
  session.lastActive = Date.now();
}

// ล้าง session ที่หมดอายุ + mid เก่าทุก 10 นาที
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActive > SESSION_TTL_MS) sessions.delete(id);
  }
  for (const [mid, t] of processedMids) {
    if (now - t > 10 * 60 * 1000) processedMids.delete(mid);
  }
}, 10 * 60 * 1000).unref();

// ---------- Helpers ----------
function verifySignature(req) {
  if (!APP_SECRET) return true; // ไม่ได้ตั้งค่า = ข้ามการตรวจ
  const sig = req.get("x-hub-signature-256");
  if (!sig || !req.rawBody) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function splitText(text, max = IG_MAX_CHARS) {
  const chunks = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendInstagramMessage(recipientId, text) {
  const url = `${IG_API_HOST}/${GRAPH_VERSION}/me/messages`;
  for (const chunk of splitText(text)) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${IG_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: chunk },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`IG Send API ${res.status}: ${body}`);
    }
  }
}

async function askGemini(session, userText) {
  pushHistory(session, "user", userText);
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: session.history,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      temperature: 0.9,
      maxOutputTokens: 512,
    },
  });
  const reply = (response.text || "").trim();
  if (!reply) throw new Error("Gemini returned empty response");
  pushHistory(session, "model", reply);
  return reply;
}

async function handleMessagingEvent(ev) {
  const senderId = ev.sender && ev.sender.id;
  const msg = ev.message;
  if (!senderId || !msg || msg.is_echo) return; // ข้ามข้อความที่บอทส่งเอง

  if (msg.mid) {
    if (processedMids.has(msg.mid)) return;
    processedMids.set(msg.mid, Date.now());
  }

  const session = getSession(senderId);

  if (!msg.text) {
    // รูป/สติกเกอร์/ไฟล์ ฯลฯ — ตอบแบบสุภาพแทนการเงียบ
    await sendInstagramMessage(senderId, "ฮานะอ่านได้แต่ข้อความนะคะ พิมพ์มาเป็นตัวอักษรได้เลยค่ะ");
    return;
  }

  let reply;
  try {
    reply = await askGemini(session, msg.text);
  } catch (err) {
    console.error("[gemini] error:", err.message);
    // ถ้าล้มเหลว เอา user message ล่าสุดออกจากประวัติ ไม่ให้ history เพี้ยน
    if (session.history.length && session.history[session.history.length - 1].role === "user") {
      session.history.pop();
    }
    reply = "ตอนนี้ฮานะสมองตื้อนิดหน่อย ลองทักมาใหม่อีกทีนะคะ";
  }
  await sendInstagramMessage(senderId, reply);
  console.log(`[bot] replied to ${senderId}`);
}

// ---------- Routes ----------
app.get("/", (_req, res) => res.status(200).send("Utahana bot is running"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true, sessions: sessions.size }));

// Webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  console.log("[webhook] GET verify, mode:", mode, "token match:", token === VERIFY_TOKEN);
  if (mode === "subscribe" && token && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Webhook events
app.post("/webhook", (req, res) => {
  console.log("[webhook] POST received:", JSON.stringify(req.body).slice(0, 600));
  if (!verifySignature(req)) {
    console.warn("[webhook] signature check failed (ตรวจ APP_SECRET หรือลบตัวแปรนี้ออก)");
    return res.sendStatus(403);
  }

  // ตอบ 200 ทันที เพื่อไม่ให้ Meta timeout/retry
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== "instagram") return;
    for (const entry of body.entry || []) {
      for (const ev of entry.messaging || []) {
        handleMessagingEvent(ev).catch((err) =>
          console.error("[webhook] handler error:", err.message)
        );
      }
    }
  } catch (err) {
    console.error("[webhook] parse error:", err.message);
  }
});

// กัน Server ล่มจาก error ที่หลุดมา
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
