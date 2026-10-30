'use strict';
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.MESSENGER_DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PROFILE_MEDIA_DIR = path.join(DATA_DIR, 'profile-media');
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB for this first working version
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(PROFILE_MEDIA_DIR, { recursive: true });
const profileMediaUpload = multer({ storage: multer.diskStorage({ destination: PROFILE_MEDIA_DIR, filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()) }), limits: { fileSize: 30 * 1024 * 1024, files: 1 }, fileFilter: (req, file, cb) => { const ok = /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype) || /^video\/(mp4|webm|quicktime)$/.test(file.mimetype); cb(ok ? null : new Error('Поддерживаются изображения и видео MP4/WebM/MOV.'), ok); } });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
const FRONTEND_DIR = path.resolve(__dirname, '../frontend');
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadStore() {
  try {
    const value = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { users: Array.isArray(value.users) ? value.users : [], messages: Array.isArray(value.messages) ? value.messages : [] };
  } catch { return { users: [], messages: [] }; }
}
let store = loadStore();
function saveStore() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE);
}
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
const attempts = new Map();
function authRateLimit(req, res, next) {
  const now = Date.now(), key = `${req.ip}:${req.path}`;
  const entry = attempts.get(key) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
  entry.count++; attempts.set(key, entry);
  if (entry.count > 12) return res.status(429).json({ error: 'Слишком много попыток. Подожди минуту и попробуй снова.' });
  next();
}
setInterval(() => { const now = Date.now(); for (const [key, value] of attempts) if (value.resetAt < now) attempts.delete(key); }, 60000).unref();
app.use(express.static(FRONTEND_DIR));
app.use('/profile-media', express.static(PROFILE_MEDIA_DIR, { fallthrough: false, maxAge: '1h' }));
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
const sessions = new Map(); // token -> userId
const sockets = new Map(); // userId -> Set<WebSocket>

const cleanNick = value => String(value || '').trim().normalize('NFKC');
const nickKey = value => cleanNick(value).toLocaleLowerCase('ru-RU');
const publicUser = u => ({ id: u.id, nickname: u.nickname, createdAt: u.createdAt, publicKey: u.publicKey || null, bio: u.bio || '', avatarData: u.avatarData || '', profileBackground: u.profileBackground || '#202020', profileBackgroundMedia: u.profileBackgroundMedia || '' });
const authUser = u => ({ ...publicUser(u), keySalt: u.keySalt, keyIv: u.keyIv, encryptedPrivateKey: u.encryptedPrivateKey });
function userById(id) { return store.users.find(u => u.id === id); }
function getToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return String(req.query.token || '');
}
function auth(req, res, next) {
  const id = sessions.get(getToken(req));
  const user = id && userById(id);
  if (!user) return res.status(401).json({ error: 'Сессия истекла. Войди снова.' });
  req.user = user; next();
}
function send(ws, obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function sendUser(userId, obj) { for (const ws of sockets.get(userId) || []) send(ws, obj); }
function isMember(msg, id) { return msg.type === 'group' || msg.fromId === id || msg.toId === id; }
function serializeMessage(m) {
  const from = userById(m.fromId);
  const to = m.toId ? userById(m.toId) : null;
  return { id: m.id, type: m.type, fromId: m.fromId, fromNickname: from ? from.nickname : 'Удалённый пользователь', toId: m.toId || null, toNickname: to ? to.nickname : null, legacyText: typeof m.text === 'string' ? m.text : undefined, encrypted: m.type === 'private' ? m.encrypted : undefined, encryptedFor: m.type === 'group' ? m.encryptedFor : undefined, createdAt: m.createdAt, editedAt: m.editedAt || null, readAt: m.readAt || null, attachment: m.attachment || null, replyTo: m.replyTo || null };
}
function deliverMessage(m) {
  const payload = { type: 'message', message: serializeMessage(m) };
  if (m.type === 'group') {
    for (const id of sockets.keys()) sendUser(id, payload);
  } else {
    sendUser(m.fromId, payload);
    if (m.toId !== m.fromId) sendUser(m.toId, payload);
  }
}
app.get('/api/health', (_req, res) => res.json({ ok: true, version: '2.3.0-http-temporary', realtime: true, legacyAccounts: true }));
app.post('/api/register', authRateLimit, (req, res) => {
  const nickname = cleanNick(req.body && req.body.nickname);
  const password = String((req.body && req.body.password) || '');
  if (nickname.length < 3 || nickname.length > 24 || !/^[\p{L}\p{N}_-]+$/u.test(nickname)) {
    return res.status(400).json({ error: 'Никнейм: 3–24 символа, только буквы, цифры, _ и -.' });
  }
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Пароль должен содержать от 8 до 128 символов.' });
  if (store.users.some(u => nickKey(u.nickname) === nickKey(nickname))) return res.status(409).json({ error: 'Этот никнейм уже занят. Придумай другой.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
  const { publicKey, keySalt, keyIv, encryptedPrivateKey } = req.body || {};
  if (publicKey && (!keySalt || !keyIv || !encryptedPrivateKey || typeof publicKey !== 'object' || typeof encryptedPrivateKey !== 'string' || encryptedPrivateKey.length > 12000)) return res.status(400).json({ error: 'Некорректный ключ шифрования.' });
  const user = { id: crypto.randomUUID(), nickname, nicknameKey: nickKey(nickname), salt, passwordHash, ...(publicKey ? { publicKey, keySalt, keyIv, encryptedPrivateKey } : {}), createdAt: new Date().toISOString() };
  store.users.push(user); saveStore();
  const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, user.id);
  res.status(201).json({ token, user: publicUser(user), keyBundle: authUser(user) });
});
app.post('/api/login', authRateLimit, (req, res) => {
  const nickname = cleanNick(req.body && req.body.nickname);
  const password = String((req.body && req.body.password) || '');
  const user = store.users.find(u => u.nicknameKey === nickKey(nickname));
  if (!user) return res.status(401).json({ error: 'Неверный никнейм или пароль.' });
  const candidate = crypto.scryptSync(password, user.salt, 64);
  const expected = Buffer.from(user.passwordHash, 'hex');
  if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) return res.status(401).json({ error: 'Неверный никнейм или пароль.' });
  const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, user.id);
  res.json({ token, user: publicUser(user), keyBundle: authUser(user) });
});
app.post('/api/keys', auth, (req, res) => {
  const { publicKey, keySalt, keyIv, encryptedPrivateKey } = req.body || {};
  if (!publicKey || typeof publicKey !== 'object' || !keySalt || !keyIv || typeof encryptedPrivateKey !== 'string' || encryptedPrivateKey.length > 12000) return res.status(400).json({ error: 'Некорректный ключ шифрования.' });
  req.user.publicKey = publicKey; req.user.keySalt = keySalt; req.user.keyIv = keyIv; req.user.encryptedPrivateKey = encryptedPrivateKey; saveStore();
  res.json({ ok: true });
});
app.post('/api/logout', auth, (req, res) => { sessions.delete(getToken(req)); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));
app.post('/api/profile-background', auth, (req, res) => {
  profileMediaUpload.single('file')(req, res, err => {
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Файл фона должен быть не больше 30 МБ.' : (err.message || 'Не удалось загрузить фон.') });
    if (!req.file) return res.status(400).json({ error: 'Выбери файл фона.' });
    const isVideo = req.file.mimetype.startsWith('video/');
    if (!isVideo && req.file.size > 10 * 1024 * 1024) { fs.unlink(req.file.path, () => {}); return res.status(413).json({ error: 'Фото фона должно быть не больше 10 МБ.' }); }
    res.json({ url: '/profile-media/' + encodeURIComponent(req.file.filename), kind: isVideo ? 'video' : 'image' });
  });
});
app.patch('/api/profile', auth, (req, res) => {
  const nickname = cleanNick(req.body.nickname || req.user.nickname);
  if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(nickname)) return res.status(400).json({ error: 'Никнейм: 3–24 буквы, цифры, _ или -.' });
  if (store.users.some(u => u.id !== req.user.id && nickKey(u.nickname) === nickKey(nickname))) return res.status(409).json({ error: 'Этот никнейм уже занят.' });
  const bio = String(req.body.bio || '').trim().slice(0, 180);
  const avatarData = String(req.body.avatarData || '');
  if (avatarData && (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(avatarData) || avatarData.length > 350000)) return res.status(400).json({ error: 'Аватарка должна быть изображением до примерно 250 КБ.' });
  const profileBackground = /^#[0-9a-fA-F]{6}$/.test(String(req.body.profileBackground || '')) ? req.body.profileBackground : '#202020';
  const profileBackgroundMedia = typeof req.body.profileBackgroundMedia === 'string' && /^\/profile-media\/[a-f0-9-]+\.(?:png|jpe?g|webp|gif|mp4|webm|mov)$/i.test(req.body.profileBackgroundMedia) ? req.body.profileBackgroundMedia : (req.user.profileBackgroundMedia || '');
  req.user.nickname = nickname; req.user.bio = bio; req.user.avatarData = avatarData; req.user.profileBackground = profileBackground; req.user.profileBackgroundMedia = profileBackgroundMedia; saveStore();
  res.json({ user: publicUser(req.user) });
});
app.get('/api/users', auth, (req, res) => res.json({ users: store.users.filter(u => u.id !== req.user.id).map(publicUser).sort((a,b) => a.nickname.localeCompare(b.nickname, 'ru')) }));
app.get('/api/conversations', auth, (req, res) => {
  const byPeer = new Map();
  for (const m of store.messages) {
    if (m.type !== 'private' || (Array.isArray(m.deletedFor) && m.deletedFor.includes(req.user.id))) continue;
    const peerId = m.fromId === req.user.id ? m.toId : (m.toId === req.user.id ? m.fromId : null);
    if (!peerId || peerId === req.user.id) continue;
    const current = byPeer.get(peerId) || { userId: peerId, lastActivity: '', unreadCount: 0 };
    if (!current.lastActivity || String(m.createdAt || '') > current.lastActivity) current.lastActivity = String(m.createdAt || '');
    if (m.toId === req.user.id && m.fromId === peerId && !m.readAt) current.unreadCount++;
    byPeer.set(peerId, current);
  }
  const conversations = [...byPeer.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  res.json({ userIds: conversations.map(c => c.userId), conversations });
});
app.post('/api/upload', auth, (req, res) => {
  upload.single('file')(req, res, err => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Максимальный размер файла сейчас 50 МБ.' : 'Не удалось загрузить файл.';
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: 'Выбери файл.' });
    const id = crypto.randomUUID();
    const safeName = path.basename(req.file.originalname || 'file').replace(/[\\/\\\0-\\x1f]/g, '_').slice(0, 180) || 'file';
    try {
      fs.writeFileSync(path.join(UPLOAD_DIR, id), req.file.buffer, { flag: 'wx', mode: 0o600 });
      res.status(201).json({ attachment: { id, name: safeName, mimeType: req.file.mimetype || 'application/octet-stream', size: req.file.size } });
    } catch { res.status(500).json({ error: 'Не удалось сохранить файл.' }); }
  });
});
app.get('/api/files/:id', auth, (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).end();
  const allowed = store.messages.some(m => m.attachment && m.attachment.id === id && (m.type === 'group' || m.fromId === req.user.id || m.toId === req.user.id));
  if (!allowed) return res.status(404).json({ error: 'Файл не найден.' });
  const filePath = path.join(UPLOAD_DIR, id);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Файл не найден на сервере.' });
  const msg = store.messages.find(m => m.attachment && m.attachment.id === id);
  const name = String(msg.attachment.name || 'file').replace(/[\\"\\r\\n]/g, '_');
  res.setHeader('Content-Type', msg.attachment.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', req.query.preview === '1' && /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i.test(msg.attachment.mimeType || '') ? `inline; filename*=UTF-8''${encodeURIComponent(name)}` : `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  fs.createReadStream(filePath).pipe(res);
});
app.get('/api/messages', auth, (req, res) => {
  const peer = String(req.query.with || '');
  const messages = store.messages.filter(m => !(Array.isArray(m.deletedFor) && m.deletedFor.includes(req.user.id)) && (m.type === 'group' ? !peer : ((m.fromId === req.user.id && m.toId === peer) || (m.fromId === peer && m.toId === req.user.id))));
  res.json({ messages: messages.slice(-300).map(serializeMessage) });
});
app.patch('/api/messages/:id', auth, (req, res) => {
  const message = store.messages.find(m => m.id === req.params.id);
  if (!message || !isMember(message, req.user.id)) return res.status(404).json({ error: 'Сообщение не найдено.' });
  if (message.fromId !== req.user.id) return res.status(403).json({ error: 'Можно изменять только свои сообщения.' });
  if (typeof message.text !== 'string') return res.status(400).json({ error: 'Это сообщение нельзя редактировать.' });
  const text = String(req.body && req.body.text || '').trim();
  if (!text || text.length > 2000) return res.status(400).json({ error: 'Текст должен содержать от 1 до 2000 символов.' });
  message.text = text;
  message.editedAt = new Date().toISOString();
  saveStore();
  const payload = { type: 'message-updated', message: serializeMessage(message) };
  if (message.type === 'group') { for (const uid of sockets.keys()) sendUser(uid, payload); }
  else { sendUser(message.fromId, payload); sendUser(message.toId, payload); }
  res.json({ message: serializeMessage(message) });
});
app.delete('/api/messages/:id', auth, (req, res) => {
  const index = store.messages.findIndex(m => m.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: 'Сообщение не найдено.' });
  const message = store.messages[index];
  if (!isMember(message, req.user.id)) return res.status(404).json({ error: 'Сообщение не найдено.' });
  const scope = String(req.body && req.body.scope || 'me');
  if (scope === 'everyone') {
    if (message.fromId !== req.user.id) return res.status(403).json({ error: 'Удалить сообщение у всех может только автор.' });
    store.messages.splice(index, 1);
    saveStore();
    const payload = { type: 'message-deleted', messageId: message.id, deletedForAll: true };
    if (message.type === 'group') { for (const uid of sockets.keys()) sendUser(uid, payload); }
    else { sendUser(message.fromId, payload); sendUser(message.toId, payload); }
    return res.json({ ok: true, deletedForAll: true });
  }
  if (!Array.isArray(message.deletedFor)) message.deletedFor = [];
  if (!message.deletedFor.includes(req.user.id)) message.deletedFor.push(req.user.id);
  saveStore();
  sendUser(req.user.id, { type: 'message-deleted', messageId: message.id, deletedForAll: false, userId: req.user.id });
  res.json({ ok: true, deletedForAll: false });
});

app.post('/api/messages', auth, (req, res) => {
  // TEMPORARY HTTP-only mode: messages are stored as plaintext. Do not use for sensitive data.
  const text = String(req.body && req.body.text || '').trim();
  const attachment = req.body && req.body.attachment;
  const type = req.body && req.body.type === 'private' ? 'private' : 'group';
  const toId = type === 'private' ? String(req.body && req.body.toId || '') : null;
  let replyTo = null;
  if (req.body && req.body.replyTo && typeof req.body.replyTo.id === 'string') {
    const target = store.messages.find(item => item.id === req.body.replyTo.id && !(Array.isArray(item.deletedFor) && item.deletedFor.includes(req.user.id)));
    const sameConversation = target && (type === 'group' ? target.type === 'group' : target.type === 'private' && ((target.fromId === req.user.id && target.toId === toId) || (target.fromId === toId && target.toId === req.user.id)));
    if (sameConversation) replyTo = { id: target.id, fromNickname: String(req.body.replyTo.fromNickname || '').slice(0, 40), text: String(req.body.replyTo.text || '').slice(0, 180) };
  }
  if ((!text && !attachment) || text.length > 2000) return res.status(400).json({ error: 'Сообщение должно содержать текст или файл.' });
  if (attachment && (typeof attachment.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(attachment.id) || !fs.existsSync(path.join(UPLOAD_DIR, attachment.id)))) return res.status(400).json({ error: 'Некорректный файл.' });
  if (type === 'private' && (!toId || !userById(toId) || toId === req.user.id)) return res.status(400).json({ error: 'Выбери пользователя для личного сообщения.' });
  const m = { id: crypto.randomUUID(), type, fromId: req.user.id, toId, text, ...(replyTo ? { replyTo } : {}), ...(attachment ? { attachment: { id: attachment.id, name: String(attachment.name || 'file').slice(0,180), mimeType: String(attachment.mimeType || 'application/octet-stream').slice(0,120), size: Number(attachment.size) || 0 } } : {}), createdAt: new Date().toISOString() };
  store.messages.push(m); if (store.messages.length > 10000) store.messages = store.messages.slice(-10000); saveStore();
  deliverMessage(m); res.status(201).json({ message: serializeMessage(m) });
});

server.on('upgrade', (req, socket, head) => {
  let token;
  try { token = new URL(req.url, 'http://localhost').searchParams.get('token'); } catch {}
  const userId = token && sessions.get(token);
  if (!userId || !userById(userId)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => { ws.userId = userId; wss.emit('connection', ws, req); });
});
wss.on('connection', ws => {
  const id = ws.userId;
  if (!sockets.has(id)) sockets.set(id, new Set());
  sockets.get(id).add(ws);
  const online = () => Array.from(sockets.keys()).filter(uid => (sockets.get(uid) || new Set()).size > 0).map(uid => publicUser(userById(uid))).filter(Boolean);
  const broadcastPresence = () => { const payload = { type: 'presence', users: online() }; for (const uid of sockets.keys()) sendUser(uid, payload); };
  broadcastPresence();
  ws.on('message', raw => {
    try {
      const data = JSON.parse(String(raw));
      if (data.type === 'typing' && typeof data.toId === 'string' && userById(data.toId)) {
        sendUser(data.toId, { type: 'typing', fromId: id, fromNickname: userById(id).nickname, active: !!data.active });
      }
      if (data.type === 'read' && Array.isArray(data.messageIds)) {
        const readIds = [];
        for (const messageId of data.messageIds.slice(0, 300)) {
          const message = store.messages.find(m => m.id === messageId && m.type === 'private' && m.toId === id);
          if (message && !message.readAt) { message.readAt = new Date().toISOString(); readIds.push(message.id); }
          else if (message && message.readAt) readIds.push(message.id);
        }
        if (readIds.length) {
          saveStore();
          const bySender = new Map();
          for (const messageId of readIds) { const message = store.messages.find(m => m.id === messageId); if (!message) continue; if (!bySender.has(message.fromId)) bySender.set(message.fromId, []); bySender.get(message.fromId).push(messageId); }
          for (const [senderId, ids] of bySender) sendUser(senderId, { type: 'read', messageIds: ids, readerId: id });
        }
      }
    } catch {}
  });
  ws.on('close', () => { const set = sockets.get(id); if (set) { set.delete(ws); if (!set.size) sockets.delete(id); } broadcastPresence(); });
});
function startServer(port = PORT, host = process.env.HOST || '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const onError = err => { server.off('listening', onListen); reject(err); };
    const onListen = () => { server.off('error', onError); resolve(server.address().port); };
    server.once('error', onError); server.once('listening', onListen); server.listen(port, host);
  });
}
if (require.main === module) startServer().then(port => console.log(`Messenger server: http://localhost:${port}`)).catch(err => { console.error(err); process.exit(1); });
module.exports = { startServer };
