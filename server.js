const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);

// WebSocket на /ws
const wss = new WebSocket.Server({ server, path: "/ws" });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// users: username -> { username, password }
const users = new Map();

// chats: id -> { id, name, owner, password, participants: Set<username> }
const chats = new Map();

// username -> Set<WebSocket>
const connections = new Map();

function generateId() {
  return (
    Math.random().toString(36).slice(2) +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2)
  );
}

function sanitizeUsername(username) {
  if (typeof username !== "string") return "";
  return username.trim();
}

function broadcastToUsers(usernames, payloadObj) {
  const payload = JSON.stringify(payloadObj);
  for (const u of usernames) {
    const conns = connections.get(u);
    if (!conns) continue;
    for (const ws of conns) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }
}

// Регистрация
app.post("/api/register", (req, res) => {
  const { username, password } = req.body || {};

  const u = sanitizeUsername(username);
  if (!u || !password) {
    return res
      .status(400)
      .json({ ok: false, message: "Заполните логин и пароль." });
  }

  if (!/^[a-zA-Z0-9_а-яА-ЯёЁ]{3,20}$/.test(u)) {
    return res.status(400).json({
      ok: false,
      message: "Логин должен быть от 3 до 20 символов, без пробелов.",
    });
  }

  if (users.has(u)) {
    return res
      .status(400)
      .json({ ok: false, message: "Такой логин уже занят." });
  }

  if (String(password).length < 4) {
    return res
      .status(400)
      .json({ ok: false, message: "Пароль должен быть не короче 4 символов." });
  }

  users.set(u, { username: u, password: String(password) });

  res.json({ ok: true, username: u });
});

// Вход
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const u = sanitizeUsername(username);

  if (!u || !password) {
    return res
      .status(400)
      .json({ ok: false, message: "Заполните логин и пароль." });
  }

  const user = users.get(u);
  if (!user || user.password !== String(password)) {
    return res
      .status(401)
      .json({ ok: false, message: "Неверный логин или пароль." });
  }

  res.json({ ok: true, username: u });
});

// Список чатов
app.get("/api/chats", (req, res) => {
  const username = sanitizeUsername(req.query.username);

  const result = [];
  for (const chat of chats.values()) {
    const isOwner = chat.owner === username;
    const isParticipant = chat.participants.has(username);
    const isFull = chat.participants.size >= 2 && !isParticipant;

    if (!isFull || isParticipant || isOwner) {
      result.push({
        id: chat.id,
        name: chat.name,
        owner: chat.owner,
        isOwner,
        participants: Array.from(chat.participants),
        isFull,
      });
    }
  }

  result.sort((a, b) => (a.id < b.id ? 1 : -1));

  res.json({ ok: true, chats: result });
});

// Создание чата
app.post("/api/chats", (req, res) => {
  const { name, password, owner } = req.body || {};
  const username = sanitizeUsername(owner);

  if (!username || !users.has(username)) {
    return res
      .status(401)
      .json({ ok: false, message: "Сначала войдите в систему." });
  }

  const chatName = String(name || "").trim();
  if (!chatName) {
    return res
      .status(400)
      .json({ ok: false, message: "Введите название чата." });
  }

  if (!password || String(password).length < 3) {
    return res
      .status(400)
      .json({
        ok: false,
        message: "Пароль для чата должен быть не короче 3 символов.",
      });
  }

  const id = generateId();
  const chat = {
    id,
    name: chatName,
    owner: username,
    password: String(password),
    participants: new Set([username]),
  };

  chats.set(id, chat);

  res.json({ ok: true, chat: { id, name: chatName, owner: username } });
});

// Присоединение к чату
app.post("/api/chats/join", (req, res) => {
  const { chatId, username, password } = req.body || {};
  const u = sanitizeUsername(username);

  if (!u || !users.has(u)) {
    return res
      .status(401)
      .json({ ok: false, message: "Сначала войдите в систему." });
  }

  const chat = chats.get(chatId);
  if (!chat) {
    return res
      .status(404)
      .json({ ok: false, message: "Чат не найден или уже удалён." });
  }

  if (chat.password !== String(password)) {
    return res
      .status(403)
      .json({ ok: false, message: "Неверный пароль от чата." });
  }

  const isParticipant = chat.participants.has(u);
  if (!isParticipant && chat.participants.size >= 2) {
    return res
      .status(403)
      .json({ ok: false, message: "В этом чате уже два участника." });
  }

  chat.participants.add(u);

  // уведомляем всех участников, что состав изменился
  broadcastToUsers(Array.from(chat.participants), {
    type: "chatParticipants",
    chatId: chat.id,
    participants: Array.from(chat.participants),
  });

  res.json({ ok: true });
});

// Удаление чата (только владелец)
app.delete("/api/chats/:id", (req, res) => {
  const chatId = req.params.id;
  const { username } = req.body || {};
  const u = sanitizeUsername(username);

  const chat = chats.get(chatId);
  if (!chat) {
    return res.status(404).json({ ok: false, message: "Чат уже удалён." });
  }

  if (chat.owner !== u) {
    return res
      .status(403)
      .json({ ok: false, message: "Удалять чат может только его создатель." });
  }

  chats.delete(chatId);

  const payload = {
    type: "chatDeleted",
    chatId,
    by: u,
  };

  broadcastToUsers(Array.from(chat.participants), payload);

  res.json({ ok: true });
});

// WebSocket для сообщений
wss.on("connection", (ws) => {
  let username = null;

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (!msg || typeof msg !== "object") return;

    if (msg.type === "auth") {
      const u = sanitizeUsername(msg.username);
      if (!u) return;
      username = u;
      if (!connections.has(u)) {
        connections.set(u, new Set());
      }
      connections.get(u).add(ws);
      return;
    }

    if (msg.type === "message") {
      if (!username) return;
      const { chatId, text, timestamp, clientId } = msg;
      const chat = chats.get(chatId);
      if (!chat) return;
      if (!chat.participants.has(username)) return;

      const cleanText = String(text || "").trim();
      if (!cleanText) return;

      const out = {
        type: "message",
        chatId,
        from: username,
        text: cleanText,
        timestamp: typeof timestamp === "number" ? timestamp : Date.now(),
        clientId: clientId || null,
      };

      broadcastToUsers(Array.from(chat.participants), out);
    }
  });

  ws.on("close", () => {
    if (username && connections.has(username)) {
      const set = connections.get(username);
      set.delete(ws);
      if (set.size === 0) {
        connections.delete(username);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Messenger server listening on http://localhost:${PORT}`);
});
