import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { google } from "googleapis";
dotenv.config();

const app = express();
app.use(express.json());

const API = "https://graph.facebook.com/v20.0";
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const DENTIST = process.env.DENTIST_NUMBER;

// ---- util p/ envio de mensagem de texto
async function sendText(to, body) {
  try {
    const { data } = await axios.post(
      `${API}/${PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body } },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log("Enviado >", data);
  } catch (err) {
    console.error("Falha ao enviar <", err?.response?.status, err?.response?.data || err.message);
  }
}

// ---- “estado” simples por número (memória volátil)
const sessions = new Map();
// formata slots fake (troque depois por Google Calendar)
const SLOTS = [
  { id: 1, when: "Hoje 16:00" },
  { id: 2, when: "Amanhã 10:30" },
  { id: 3, when: "Amanhã 15:00" },
];

// ---- webhook verification (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---- webhook receive (POST)
app.post("/webhook", async (req, res) => {
  try {
    console.log("Payload:", JSON.stringify(req.body, null, 2));
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from; // telefone do paciente no WhatsApp
    const text = (msg.text?.body || "").trim();

    // inicia sessão se não existir
    if (!sessions.has(from)) {
      sessions.set(from, { step: "idle", data: {} });
    }
    const session = sessions.get(from);

    // comandos rápidos
    if (/^cancelar$/i.test(text)) {
      await sendText(from, "Sem problemas! Consulta cancelada. Se precisar, digite *agendar* novamente.");
      if (DENTIST) await sendText(DENTIST, `⚠️ Paciente ${session.data?.name || from} cancelou a consulta.`);
      sessions.set(from, { step: "idle", data: {} });
      return res.sendStatus(200);
    }
    if (/^agendar$/i.test(text) || session.step === "idle") {
      session.step = "get_name";
      await sendText(from, "Vamos agendar sua consulta 🦷\nQual é o seu *nome completo*?");
      return res.sendStatus(200);
    }

    // fluxo de coleta
    if (session.step === "get_name") {
      session.data.name = text;
      session.step = "get_phone";
      await sendText(from, `Pra continuar, me informe seu *telefone* (com DDD).`);
      return res.sendStatus(200);
    }

    if (session.step === "get_phone") {
      session.data.phone = text.replace(/\D/g, "");
      session.step = "offer_slots";
      const list = SLOTS.map(s => `${s.id}) ${s.when}`).join("\n");
      await sendText(
        from,
        `Obrigado, ${session.data.name}! Temos estes horários:\n${list}\n\nResponda com *1*, *2* ou *3*.`
      );
      return res.sendStatus(200);
    }

    if (session.step === "offer_slots") {
      const chosen = Number(text);
      const slot = SLOTS.find(s => s.id === chosen);
      if (!slot) {
        await sendText(from, "Não entendi. Responda *1*, *2* ou *3* para escolher um horário.");
        return res.sendStatus(200);
      }
      session.data.slot = slot.when;
      session.step = "confirm";
      await sendText(
        from,
        `Confirmar consulta para *${slot.when}*?\nResponda *confirmo* ou *cancelar*.`
      );
      return res.sendStatus(200);
    }

    if (session.step === "confirm" && /^confirmo$/i.test(text)) {
      // Aqui, depois vamos criar o evento real no Google Calendar
      await sendText(from, `✅ Consulta confirmada para *${session.data.slot}*.\nAté lá!`);
      if (DENTIST) {
        await sendText(
          DENTIST,
          `📬 Nova consulta confirmada:\nPaciente: ${session.data.name}\nTelefone: ${session.data.phone}\nHorário: ${session.data.slot}`
        );
      }
      sessions.set(from, { step: "idle", data: {} });
      return res.sendStatus(200);
    }

    // fallback
    await sendText(from, "Não entendi. Digite *agendar* para começar ou *cancelar* para encerrar.");
    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e?.response?.data || e.message);
    return res.sendStatus(200);
  }
});

// ---- healthcheck
app.get("/", (_, res) => res.send("OK"));

app.listen(process.env.PORT || 3000, () =>
  console.log("Webhook ON:", process.env.PORT || 3000)
);

// ping de saúde
app.get("/health", (req, res) => res.status(200).send("ok"));

// --- Google OAuth (básico) ---
const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  BASE_URL, // ex.: https://smilebot-2asc.onrender.com (defina no Render)
} = process.env;

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  `${BASE_URL}/google/callback`
);

// inicia o fluxo de login
app.get("/google/auth", (req, res) => {
  const dentistId = req.query.dentist_id || "default";
  const scopes = [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.readonly",
  ];

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    prompt: "consent",
    state: dentistId, // você pode recuperar isso no callback
  });

  return res.redirect(url);
});

// finaliza o login (callback do Google)
app.get("/google/callback", async (req, res) => {
  try {
    const { code, state } = req.query; // state = dentistId
    const { tokens } = await oauth2Client.getToken(code);

    // TODO: salvar tokens por dentista (state) no seu storage/banco
    // await saveTokens(state, tokens);

    return res.send("Conta Google conectada com sucesso!");
  } catch (e) {
    console.error(e);
    return res.status(500).send("Falha ao concluir OAuth.");
  }
});

// porta
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Webhook ON:", PORT);
});
