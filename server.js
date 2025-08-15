// server.js
import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { google } from "googleapis";

dotenv.config();

const app = express();
app.use(express.json());

// -------------------------
//  ENV
// -------------------------
const {
  PORT = 3000,
  META_VERIFY_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_ACCESS_TOKEN,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
} = process.env;

if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
  console.warn(
    "[WARN] Faltam variáveis do WhatsApp (WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN)"
  );
}

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
  console.warn(
    "[WARN] Faltam variáveis do Google OAuth (GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI)"
  );
}

// -------------------------
//  Store simples de tokens do Google por dentista
//  (para produção, troque por DB real: Redis, Postgres etc.)
// -------------------------
const googleTokensStore = new Map(); // key: dentist_id, value: tokens

// -------------------------
//  Helper: cliente OAuth2
// -------------------------
function getOAuthClient() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI // precisa ser idêntico ao cadastrado no Google Console
  );
}

// -------------------------
//  Helper: enviar texto via WhatsApp
// -------------------------
async function sendText(to, body) {
  try {
    const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    };

    const headers = {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    };

    const { data } = await axios.post(url, payload, { headers });
    console.log("[WhatsApp] Enviado:", data);
    return data;
  } catch (err) {
    const details =
      err.response?.data || err.message || err.toString();
    console.error("[WhatsApp] Erro ao enviar mensagem:", details);
  }
}

// -------------------------
//  Rota: iniciar OAuth (GET /google/auth)
//  Ex.: https://.../google/auth?dentist_id=default
// -------------------------
app.get("/google/auth", (req, res) => {
  try {
    const dentistId = req.query.dentist_id || "default";
    const oauth2Client = getOAuthClient();

    // Colocamos o dentistId no state para recuperar no callback
    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/calendar.events",
      ],
      state: JSON.stringify({ dentistId }),
    });

    return res.redirect(url);
  } catch (err) {
    console.error("[OAuth] Erro ao iniciar:", err);
    return res.status(500).send("Falha ao iniciar OAuth.");
  }
});

// -------------------------
//  Rota: callback do OAuth (GET /google/callback)
//  O Google redireciona para cá com ?code= e ?state=
// -------------------------
app.get("/google/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).send("Código de autorização ausente.");
  }

  let dentistId = "default";
  try {
    if (state) {
      const parsed = JSON.parse(state);
      if (parsed?.dentistId) dentistId = parsed.dentistId;
    }
  } catch {
    // state opcional / inválido
  }

  try {
    const oauth2Client = getOAuthClient();

    // IMPORTANTE: redirect_uri precisa bater 100% com o do Google Console
    const { tokens } = await oauth2Client.getToken({
      code,
      redirect_uri: GOOGLE_REDIRECT_URI,
    });

    oauth2Client.setCredentials(tokens);
    googleTokensStore.set(dentistId, tokens);

    // Teste: listar calendários (apenas para validar que deu certo)
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    const list = await calendar.calendarList.list();

    console.log("[OAuth] Tokens salvos para", dentistId, {
      has_access_token: !!tokens.access_token,
      has_refresh_token: !!tokens.refresh_token,
      expiry_date: tokens.expiry_date,
    });
    console.log(
      "[OAuth] Calendários encontrados:",
      (list.data.items || []).length
    );

    return res.send("OAuth concluído com sucesso! Você já pode fechar esta janela. ✅");
  } catch (err) {
    const details =
      err.response?.data || err.errors || err.message || err.toString();
    console.error("[OAuth] Erro no callback:", details);
    return res.status(500).send("Falha ao concluir OAuth.");
  }
});

// -------------------------
//  Webhook: verificação (GET /webhook)
// -------------------------
app.get("/webhook", (req, res) => {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
      console.log("[Webhook] Verificado com sucesso!");
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  } catch (err) {
    console.error("[Webhook] Erro na verificação:", err);
    return res.sendStatus(500);
  }
});

// -------------------------
//  Webhook: receber mensagens (POST /webhook)
// -------------------------
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const msg = change?.value?.messages?.[0];

    if (!msg) {
      // Sem mensagem (delivery, status, etc.)
      return res.sendStatus(200);
    }

    const from = msg.from; // telefone do usuário
    const text = msg.text?.body?.trim() || "";

    console.log("[Webhook] Msg de", from, ":", text);

    // Comandos simples
    if (/^(conectar|conectar google|link google)/i.test(text)) {
      const url = new URL(`${req.protocol}://${req.get("host")}/google/auth`);
      url.searchParams.set("dentist_id", "default");
      await sendText(from, `Para conectar seu Google Agenda, acesse: ${url.toString()}`);
      return res.sendStatus(200);
    }

    if (/^agendar/i.test(text)) {
      await sendText(
        from,
        "Ótimo! Me envie: nome, telefone e unidade/endereço. 😃"
      );
      return res.sendStatus(200);
    }

    // Resposta padrão
    await sendText(
      from,
      "Olá! Sou a secretária virtual 🦷 Posso agendar, confirmar ou cancelar consultas.\n\n" +
        "Dicas:\n" +
        "• Envie 'agendar' para começar o atendimento.\n" +
        "• Envie 'conectar google' para vincular seu Google Agenda."
    );

    return res.sendStatus(200);
  } catch (err) {
    const details =
      err.response?.data || err.message || err.toString();
    console.error("[Webhook] Erro no POST:", details);
    return res.sendStatus(500);
  }
});

// -------------------------
//  Saúde
// -------------------------
app.get("/health", (req, res) => res.send("OK"));

// -------------------------
//  Inicialização
// -------------------------
app.listen(PORT, () => {
  console.log(`Webhook ON: ${PORT}`);
  console.log("ENV check:", {
    has_meta_verify: !!META_VERIFY_TOKEN,
    has_phone_id: !!WHATSAPP_PHONE_NUMBER_ID,
    has_wapp_token: !!WHATSAPP_ACCESS_TOKEN,
    google_redirect: GOOGLE_REDIRECT_URI,
  });
});
