const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const { OpenAI } = require("openai");
const { GoogleGenAI } = require("@google/genai");
const { SYSTEM_INSTRUCTION } = require("./persona");

// ---------- Config (ทั้งหมดดึงจาก Environment Variables) ----------
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const APP_SECRET = process.env.APP_SECRET || ""; 
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";
const IG_API_HOST = process.env.IG_API_HOST || "https://graph.instagram.com";

// 🌟 ตัวแปรเลือกค่าย AI: "groq" หรือ "gemini" (ค่าเริ่มต้นเป็น groq ตามที่ตกลงกัน)
const MODEL_PROVIDER = (process.env.MODEL_PROVIDER || "groq").toLowerCase();
const MODEL_NAME = process.env.MODEL_NAME || (MODEL_PROVIDER === "groq" ? "qwen-2.5-32b" : "gemini-2.5-flash");

// API Keys ของแต่ละค่าย
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

const MAX_HISTORY = 20; // จำข้อความล่าสุดสูงสุด 20 messages
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 ชั่วโมง
const IG_MAX_CHARS = 900; // ข้อความ IG จำกัด ~1000 bytes

// เช็ก Config พื้นฐาน
for (const [k, v] of Object.entries({ VERIFY_TOKEN, IG_ACCESS_TOKEN })) {
  if (!v) console.warn(`[config] Missing env var: ${k}`);
}
if (MODEL_PROVIDER === "groq" && !GROQ_API_KEY) console.warn("[config] Missing GROQ_API_KEY");
if (MODEL_PROVIDER === "gemini" && !GEMINI_API_KEY) console.warn("[config] Missing GEMINI_API_KEY");

// ตั้งค่า AI Clients ตาม Provider ที่เลือก
let groqClient = null;
let geminiClient = null;

if (MODEL_PROVIDER === "groq") {
  groqClient = new OpenAI({
    apiKey: GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
  });
  console.log(`[AI Engine] Loaded Groq Provider with model: ${MODEL_NAME}`);
} else {
  geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  console.log(`[AI Engine] Loaded Gemini Provider with model: ${MODEL_NAME}`);
}

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
  if (!APP_SECRET) return true; 
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
  const IG_PAGE_ID = process.env.IG_PAGE_ID || "17841477196883165";
  const url = `${IG_API_HOST}/${GRAPH_VERSION}/${IG_PAGE_ID}/messages`;
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

// 🔍 ฟังก์ชันเสริม: ค้นหาข้อมูลผ่าน Tavily Search API
async function searchTavily(query) {
  if (!TAVILY_API_KEY) {
    console.warn("[Tavily] TAVILY_API_KEY is not set.");
    return null;
  }
  try {
    console.log(`🔍 Tavily Searching for: "${query}"`);
    const response = await axios.post("https://api.tavily.com/search", {
      api_key: TAVILY_API_KEY,
      query: query,
      search_depth: "basic",
      max_results: 3,
    });
    const results = response.data.results;
    if (!results || results.length === 0) return "ไม่พบข้อมูลจากเว็บ";
    return results.map((r, i) => `[ผลการค้นหาที่ ${i + 1}] ${r.title}\nเนื้อหา: ${r.content}`).join("\n\n");
  } catch (error) {
    console.error("Tavily Search Error:", error.response?.data || error.message);
    return null;
  }
}

// ---------- ฟังก์ชันเรียก AI กลาง (รองรับทั้ง Groq และ Gemini) ----------
async function askAI(session, userText) {
  let searchData = null;
  let cleanUserText = userText;

  // 📌 ดักจับคำสั่ง !ค้นหา(เนื้อหา) หรือ !ค้นหา เนื้อหา
  const searchMatch = userText.match(/^!ค้นหา(?:\((.*?)\)|[\s]+(.*))/);
  if (searchMatch) {
    const keyword = searchMatch[1] || searchMatch[2];
    if (keyword && keyword.trim()) {
      cleanUserText = `ดึงข้อมูลเรื่อง "${keyword.trim()}" มาให้หน่อย`;
      searchData = await searchTavily(keyword.trim());
    }
  }

  // บันทึกข้อความลง history
  session.history.push({ role: "user", content: cleanUserText });
  if (session.history.length > MAX_HISTORY) {
    session.history.splice(0, session.history.length - MAX_HISTORY);
  }
  session.lastActive = Date.now();

  let reply = "";

  // ⚡ กรณีใช้ Groq Provider (OpenAI SDK Compatible)
  if (MODEL_PROVIDER === "groq") {
    let dynamicSystemInstruction = SYSTEM_INSTRUCTION;
    if (searchData) {
      dynamicSystemInstruction += `\n\n[ข้อมูลล่าสุดจาก Google/Web Search]:\n${searchData}\n\n(คำสั่งพิเศษ: อีกฝ่ายใช้คำสั่งบังคับค้นหาข้อมูล ให้ตอบโดยนำข้อมูลด้านบนนี้มาบอกเขาตรงๆ ห้ามปฏิเสธว่าไม่รู้ แต่ให้ตอบด้วยน้ำเสียงบ่นอุบอิบ/ซึนเดะตามสไตล์ฮานะ)`;
    }

    const messages = [
      { role: "system", content: dynamicSystemInstruction },
      ...session.history.map(h => ({
        role: h.role === "model" ? "assistant" : h.role,
        content: h.parts ? h.parts[0].text : h.content
      }))
    ];

    const completion = await groqClient.chat.completions.create({
      model: MODEL_NAME,
      messages: messages,
      temperature: 0.9,
      max_tokens: 512,
    });

    reply = (completion.choices[0]?.message?.content || "").trim();
  } 
  // 🌟 กรณีใช้ Gemini Provider ตามเดิม
  else {
    // แปลง history ให้ตรงกับรูปแบบของ Gemini SDK
    const geminiHistory = session.history.map(h => ({
      role: h.role === "assistant" ? "model" : h.role,
      parts: h.parts || [{ text: h.content }]
    }));

    const configObj = {
      systemInstruction: SYSTEM_INSTRUCTION,
      temperature: 0.9,
      maxOutputTokens: 512,
    };
    if (searchData) {
      configObj.tools = [{ googleSearch: {} }];
    }

    const response = await geminiClient.models.generateContent({
      model: MODEL_NAME,
      contents: geminiHistory,
      config: configObj,
    });
    reply = (response.text || "").trim();
  }

  if (!reply) throw new Error("AI returned empty response");

  // บันทึกคำตอบบอทลง history
  session.history.push({ role: "model", content: reply });
  return reply;
}

async function handleMessagingEvent(ev) {
  const senderId = ev.sender && ev.sender.id;
  const msg = ev.message;
  if (!senderId || !msg || msg.is_echo) return; 

  if (msg.mid) {
    if (processedMids.has(msg.mid)) return;
    processedMids.set(msg.mid, Date.now());
  }

  const session = getSession(senderId);

  if (!msg.text) {
    await sendInstagramMessage(senderId, "ฮานะอ่านได้แต่ข้อความนะคะ พิมพ์มาเป็นตัวอักษรได้เลยค่ะ");
    return;
  }

  // ---------- คำสั่งลับเช็ก System Monitor & AI Status ----------
  const userMsg = msg.text.trim().toLowerCase();
  if (userMsg === "!status" || userMsg === "!sys" || userMsg === "!info") {
    const os = require("os");

    const totalMem = (os.totalmem() / 1024 / 1024).toFixed(0);
    const freeMem = (os.freemem() / 1024 / 1024).toFixed(0);
    const usedMem = totalMem - freeMem;
    const ramUsagePct = ((usedMem / totalMem) * 100).toFixed(1);

    const totalSec = Math.floor(process.uptime());
    const days = Math.floor(totalSec / (3600 * 24));
    const hours = Math.floor((totalSec % (3600 * 24)) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    
    let uptimeStr = "";
    if (days > 0) uptimeStr += `${days}d `;
    if (hours > 0 || days > 0) uptimeStr += `${hours}h `;
    uptimeStr += `${mins}m ${secs}s`;

    const platform = `${os.type()} ${os.arch()}`;
    const activeSessions = sessions.size;

    const statusText = 
      `🖥️ [SYSTEM MONITOR & DIAGNOSTIC]\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🟢 Server Status : Online (Render)\n` +
      `⏱️ Server Uptime : ${uptimeStr}\n` +
      `💾 Memory Usage  : ${usedMem}/${totalMem} MB (${ramUsagePct}%)\n` +
      `⚙️ Node.js Ver   : ${process.version}\n` +
      `🐧 OS Platform   : ${platform}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🤖 AI Engine     : ${MODEL_PROVIDER.toUpperCase()} (${MODEL_NAME})\n` +
      `💬 Active Session: ${activeSessions} user(s)\n` +
      `🌐 API Host      : ${IG_API_HOST}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `✨ Utahana System Status: ALL OK!`;

    await sendInstagramMessage(senderId, statusText);
    return;
  }
  // ----------------------------------------------------------------

  let reply;
  try {
    reply = await askAI(session, msg.text);
  } catch (err) {
    console.error("[ai] error:", err.message);
    if (session.history.length && session.history[session.history.length - 1].role === "user") {
      session.history.pop();
    }
    reply = "ตอนนี้ฮานะสมองตื้อนิดหน่อย ลองทักมาใหม่อีกทีนะคะ(#ER42953)";
  }
  await sendInstagramMessage(senderId, reply);
  console.log(`[bot] replied to ${senderId}`);
}

// ---------- Routes ----------
app.get("/", (_req, res) => res.status(200).send("Utahana bot is running"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true, provider: MODEL_PROVIDER, model: MODEL_NAME, sessions: sessions.size }));

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
    console.warn("[webhook] signature check failed");
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== "instagram") return;
    for (const entry of body.entry || []) {
      const events = [...(entry.messaging || [])];
      for (const ch of entry.changes || []) {
        if (ch.field === "messages" && ch.value) events.push(ch.value);
      }
      for (const ev of events) {
        handleMessagingEvent(ev).catch((err) =>
          console.error("[webhook] handler error:", err.message)
        );
      }
    }
  } catch (err) {
    console.error("[webhook] parse error:", err.message);
  }
});

// กัน Server ล่ม
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
