'use strict';
const $ = id => document.getElementById(id);
const state = { mode: 'login', token: localStorage.getItem('messengerToken') || '', me: null, users: [], online: new Set(), selected: null, ws: null, privateKey: null, typingTimer: null, typingClear: null, theme: localStorage.getItem('messengerTheme') || 'dark', seen: new Set(), readReceipts: new Set(), pendingReadIds: new Set(), conversationIds: new Set(), conversationMeta: new Map(), chatUnreadIds: [], messageCache: new Map(), pendingForward: null, pendingDeleteMessage: null, editingMessage: null, replyingTo: null };
// Токен сохраняется для восстановления сессии.
const authScreen = $('authScreen'), appScreen = $('appScreen');

// Keep the app sized to the actually visible viewport on mobile. Android browsers
// often resize visualViewport when the on-screen keyboard opens or closes.
(function keepChatVisibleWithKeyboard() {
  const root = document.documentElement;
  let lastHeight = 0;
  const updateViewport = () => {
    const viewport = window.visualViewport;
    const height = Math.round(viewport?.height || window.innerHeight || root.clientHeight);
    if (height > 0 && height !== lastHeight) {
      lastHeight = height;
      root.style.setProperty('--messenger-viewport-height', `${height}px`);
    }
    // Prevent the header/composer from being left outside the visible area after
    // keyboard transitions; the message history remains the independently scrollable area.
    const messages = document.getElementById('messages');
    if (messages && document.activeElement?.id === 'messageInput') {
      requestAnimationFrame(() => {
        const input = document.getElementById('messageInput');
        if (!input || document.activeElement !== input) return;
        const rect = input.getBoundingClientRect();
        const visibleBottom = window.visualViewport?.height || window.innerHeight;
        if (rect.bottom > visibleBottom) input.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      });
    }
  };
  updateViewport();
  window.addEventListener('resize', updateViewport, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(updateViewport, 120), { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateViewport, { passive: true });
    window.visualViewport.addEventListener('scroll', updateViewport, { passive: true });
  }
  document.addEventListener('focusin', event => {
    if (event.target?.id === 'messageInput') setTimeout(updateViewport, 80);
  });
  document.addEventListener('focusout', event => {
    if (event.target?.id === 'messageInput') setTimeout(updateViewport, 180);
  });
})();


function initials(n) { return (n || '?').trim().slice(0, 1).toLocaleUpperCase('ru-RU'); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function setAvatar(el, user) { if (!el) return; const n = user?.nickname || '?'; el.textContent = user?.avatarData ? '' : initials(n); el.style.backgroundImage = user?.avatarData ? `url(\"${user.avatarData}\")` : ''; el.style.backgroundSize = 'cover'; el.style.backgroundPosition = 'center'; el.style.backgroundColor = /^#[0-9a-fA-F]{6}$/.test(user?.profileBackground || '') ? user.profileBackground : '#7162e8'; el.style.color = user?.avatarData ? 'transparent' : '#fff'; }
window.setAvatar = setAvatar;
function setTheme() { document.body.classList.toggle('light', state.theme === 'light'); document.documentElement.style.colorScheme = state.theme; $('themeButton').textContent = state.theme === 'light' ? '☾' : '☼'; }
setTheme();
function setMode(mode) { state.mode = mode; document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.mode === mode)); $('authSubmit').textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт'; $('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password'; $('authError').textContent = ''; }
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(path, { ...options, headers });
  let data = {}; try { data = await response.json(); } catch {}
  if (!response.ok) { if (response.status === 401 && state.token) await logout(false); throw new Error(data.error || `Ошибка ${response.status}`); }
  return data;
}

const encoder = new TextEncoder(), decoder = new TextDecoder();
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
async function passwordKey(password, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt']);
}
async function createEncryptedKeyBundle(password) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const wrappingKey = await passwordKey(password, salt);
  const encryptedPrivateKey = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, encoder.encode(JSON.stringify(privateJwk)));
  return { publicKey, keySalt: b64(salt), keyIv: b64(iv), encryptedPrivateKey: b64(encryptedPrivateKey) };
}
async function unlockPrivateKey(bundle, password) {
  try {
    const key = await passwordKey(password, unb64(bundle.keySalt));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(bundle.keyIv) }, key, unb64(bundle.encryptedPrivateKey));
    return crypto.subtle.importKey('jwk', JSON.parse(decoder.decode(plain)), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
  } catch { throw new Error('Не удалось открыть ключ шифрования. Проверь пароль или обнови приложение.'); }
}
async function encryptForPublicKey(text, recipientPublicJwk) {
  const recipientKey = await crypto.subtle.importKey('jwk', recipientPublicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const aes = await crypto.subtle.deriveKey({ name: 'ECDH', public: recipientKey }, state.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, encoder.encode(text));
  return { iv: b64(iv), ciphertext: b64(ciphertext) };
}
async function decryptEnvelope(message, peerId, envelope) {
  const peer = state.users.find(u => u.id === peerId) || (state.me?.id === peerId ? state.me : null);
  if (!peer?.publicKey || !state.privateKey || !envelope) return '[Не удалось расшифровать: ключ недоступен]';
  try {
    const peerKey = await crypto.subtle.importKey('jwk', peer.publicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const aes = await crypto.subtle.deriveKey({ name: 'ECDH', public: peerKey }, state.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv) }, aes, unb64(envelope.ciphertext));
    return decoder.decode(plain);
  } catch { return '[Сообщение не расшифровано: ключи не совпадают]'; }
}
async function decryptMessage(m) {
  // Compatibility: messages saved by the older, pre-E2EE version remain readable.
  if (typeof m.legacyText === 'string') return m.legacyText;
  if (m.type === 'group') return decryptEnvelope(m, m.fromId, m.encryptedFor?.[state.me.id]);
  const peerId = m.fromId === state.me.id ? m.toId : m.fromId;
  return decryptEnvelope(m, peerId, m.encrypted);
}
$('authForm').addEventListener('submit', async e => {
  e.preventDefault(); const button = $('authSubmit'); button.disabled = true; $('authError').textContent = '';
  // Ask for notification permission during the user's sign-in gesture; browsers may require HTTPS.
  if ('Notification' in window && Notification.permission === 'default') { try { Notification.requestPermission(); } catch {} }
  try {
    const nickname = $('nickname').value; const password = $('password').value;
    // Temporary HTTP-only mode: don't call WebCrypto, which is unavailable on a public HTTP IP.
    // WARNING: messages are plaintext in this temporary mode; use HTTPS + E2EE for private conversations.
    const data = await api(state.mode === 'login' ? '/api/login' : '/api/register', { method: 'POST', body: JSON.stringify({ nickname, password }) });
    state.token = data.token; localStorage.setItem('messengerToken', data.token);
    state.privateKey = null;
    state.me = data.user; $('password').value = ''; await enterApp();
  } catch (err) { $('authError').textContent = err.message; }
  finally { button.disabled = false; }
});
async function enterApp() {
  authScreen.classList.add('hidden'); appScreen.classList.remove('hidden');
  $('myNickname').textContent = state.me.nickname; setAvatar($('myAvatar'), state.me); setTheme();
  await loadUsers(); showChatsPanel(); connectSocket();
}
async function logout(callApi = true) {
  if (callApi && state.token) { try { await fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${state.token}` } }); } catch {} }
  if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
  state.token = ''; state.me = null; state.selected = null; state.online.clear(); localStorage.removeItem('messengerToken');
  appScreen.classList.add('hidden'); authScreen.classList.remove('hidden'); $('messages').innerHTML = ''; $('contactsList').innerHTML = ''; $('authError').textContent = '';
}
$('logoutButton').addEventListener('click', () => { if (window.confirm('Вы действительно хотите выйти из аккаунта?')) logout(true); });
async function loadUsers() {
  try { const [data, conversations] = await Promise.all([api('/api/users'), api('/api/conversations')]); state.users = data.users; state.conversationIds = new Set(conversations.userIds || []); state.conversationMeta = new Map((conversations.conversations || []).map(c => [c.userId, c])); renderContacts(); }
  catch (err) { if (state.me) toastError(err.message); }
}
function showChatsPanel() { appScreen.classList.remove('chat-open'); $('scrollBottomButton').classList.add('hidden'); }
function showChatPanel() {
  const wasOpen = appScreen.classList.contains('chat-open');
  appScreen.classList.add('chat-open'); $('scrollBottomButton').classList.remove('hidden');
  if (!wasOpen) history.pushState({ messengerChat: true }, '', location.href);
}
window.addEventListener('popstate', () => { if (appScreen.classList.contains('chat-open')) showChatsPanel(); });
function renderContacts() {
  const query = ($('userSearch')?.value || '').trim().toLocaleLowerCase('ru-RU');
  const candidates = query
    ? state.users.filter(u => u.nickname.toLocaleLowerCase('ru-RU').includes(query))
    : state.pendingForward ? state.users.filter(u => u.id !== state.me?.id) : state.users.filter(u => state.conversationIds.has(u.id)).sort((a, b) => {
      const aa = state.conversationMeta.get(a.id)?.lastActivity || '';
      const bb = state.conversationMeta.get(b.id)?.lastActivity || '';
      return bb.localeCompare(aa);
    });
  $('contactsCount').textContent = candidates.length;
  if (!candidates.length) {
    $('contactsList').innerHTML = `<div class="empty-contacts">${query ? 'Никого не найдено.' : 'Пока нет личных переписок. Найди пользователя через поиск выше.'}</div>`;
    return;
  }
  $('contactsList').innerHTML = candidates.map(u => { const unread = state.conversationMeta.get(u.id)?.unreadCount || 0; return `<button class="contact ${state.selected === u.id ? 'active' : ''}" data-user="${escapeHtml(u.id)}"><span class="contact-avatar-wrap"><span class="avatar" style="${u.avatarData ? `background-image:url('${u.avatarData}');background-size:cover;background-position:center;color:transparent;` : ''}background-color:${/^#[0-9a-fA-F]{6}$/.test(u.profileBackground||'')?u.profileBackground:'#7162e8'}">${u.avatarData ? '' : escapeHtml(initials(u.nickname))}</span>${unread ? `<b class="unread-avatar-badge">${unread > 99 ? '99+' : unread}</b>` : ''}</span><span class="contact-copy"><strong>${escapeHtml(u.nickname)}${unread ? `<b class="unread-badge">${unread > 99 ? '99+' : unread}</b>` : ''}</strong><small>${state.conversationIds.has(u.id) ? (state.online.has(u.id) ? 'В сети' : 'Есть переписка') : (state.online.has(u.id) ? 'В сети · новый чат' : 'Начать переписку')}</small></span><i class="presence-dot ${state.online.has(u.id) ? 'online' : ''}"></i></button>`; }).join('');
  document.querySelectorAll('.contact').forEach(b => b.addEventListener('click', () => state.pendingForward ? forwardMessageTo(b.dataset.user) : selectChat(b.dataset.user)));
}
$('userSearch').addEventListener('input', renderContacts);
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !state.token || !state.me || !state.selected) return;
  flushPendingReadReceipts();
  try {
    const result = await api(`/api/messages?with=${encodeURIComponent(state.selected)}`);
    markIncomingMessagesRead(result.messages);
  } catch (err) { console.warn('Не удалось обновить статусы прочтения', err); }
});

function renderChatHeader() {
  if (!state.selected) { $('chatAvatar').textContent = '#'; $('chatTitle').textContent = 'Общий чат'; $('chatSubtitle').textContent = 'Общение со всеми участниками'; $('groupButton').classList.add('active'); }
  else { const u = state.users.find(x => x.id === state.selected); setAvatar($('chatAvatar'), u); $('chatTitle').textContent = u?.nickname || 'Личные сообщения'; $('chatSubtitle').textContent = [u?.bio || '', state.online.has(state.selected) ? 'В сети · личный чат' : 'Личные сообщения'].filter(Boolean).join(' · '); $('groupButton').classList.remove('active'); }
  renderContacts();
}
async function selectChat(userId) {
  state.replyingTo = null; renderReplyComposer();
  showChatPanel();
  state.selected = userId || null; state.seen.clear(); state.messageCache.clear(); renderChatHeader(); $('typingIndicator').textContent = ''; $('messages').innerHTML = '<div class="welcome"><div class="welcome-symbol">✦</div><h3>Загружаем переписку…</h3><p>Секундочку.</p></div>';
  try { const url = state.selected ? `/api/messages?with=${encodeURIComponent(state.selected)}` : '/api/messages'; const data = await api(url); $('messages').innerHTML = ''; state.seen.clear(); state.chatUnreadIds = data.messages.filter(m => m.type === 'private' && m.toId === state.me.id && m.fromId === state.selected && !m.readAt).map(m => m.id); if (!data.messages.length) showWelcome(); else { for (const message of data.messages) await addMessage(message); if (state.chatUnreadIds.length) { const firstUnread = document.querySelector(`[data-message-id="${CSS.escape(state.chatUnreadIds[0])}"]`); if (firstUnread) $('messages').scrollTop = Math.max(0, firstUnread.offsetTop - 16); updateScrollButton(); } else jumpToLatest('auto'); markIncomingMessagesRead(data.messages); setTimeout(loadUsers, 250); } }
  catch (err) { $('messages').innerHTML = `<div class="welcome"><h3>Не удалось загрузить сообщения</h3><p>${escapeHtml(err.message)}</p></div>`; }
}
function showWelcome() { $('messages').innerHTML = `<div class="welcome"><div class="welcome-symbol">✦</div><h3>${state.selected ? 'Начни личный разговор' : 'Добро пожаловать!'}</h3><p>${state.selected ? 'Только ты и выбранный собеседник увидите сообщения этой переписки.' : 'Напиши первое сообщение в общий чат.'}</p></div>`; }
function queueReadReceipts(messageIds) {
  for (const id of messageIds || []) if (id) state.pendingReadIds.add(id);
  flushPendingReadReceipts();
}
function flushPendingReadReceipts() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN || document.hidden || !state.pendingReadIds.size) return;
  const messageIds = Array.from(state.pendingReadIds).slice(0, 300);
  if (!messageIds.length) return;
  state.ws.send(JSON.stringify({ type: 'read', messageIds }));
  for (const id of messageIds) state.pendingReadIds.delete(id);
}
function markIncomingMessagesRead(messages) {
  if (!state.selected || !state.me || document.hidden) return;
  const ids = messages.filter(m => m.type === 'private' && m.toId === state.me.id && m.fromId === state.selected && !m.readAt).map(m => m.id);
  if (ids.length) queueReadReceipts(ids);
}
function updateReadStatuses(messageIds) {
  for (const id of messageIds || []) {
    state.readReceipts.add(id);
    const status = document.querySelector(`[data-message-id="${CSS.escape(id)}"] .message-status`);
    if (status) { status.textContent = '✓✓'; status.title = 'Прочитано'; status.classList.add('read'); }
  }
}
async function addMessage(m, fromLiveSocket = false) {
  const isGroup = m.type === 'group';
  const mine = m.fromId === state.me.id;
  if (fromLiveSocket && !mine && document.hidden &&
      'Notification' in window && Notification.permission === 'granted') {
    try {
      const body = m.text ?? await decryptMessage(m);
      const notification = new Notification(
        `Сообщение от ${m.fromNickname || 'Пользователь'}`,
        { body: String(body).slice(0, 180), tag: `message-${m.id}` }
      );
      notification.onclick = () => {
        window.focus();
        if (isGroup) selectChat(null);
        else selectChat(m.fromId);
        notification.close();
      };
    } catch (e) { console.warn('Не удалось показать уведомление', e); }
  }
  if (state.selected ? (isGroup || !((m.fromId === state.me.id && m.toId === state.selected) || (m.fromId === state.selected && m.toId === state.me.id))) : !isGroup) return;
  if (state.seen.has(m.id)) return; state.seen.add(m.id);
  if (!mine && m.type === 'private' && m.toId === state.me.id && state.selected === m.fromId && !document.hidden) queueReadReceipts([m.id]);
  const displayText = await decryptMessage(m);
  const empty = $('messages').querySelector('.welcome'); if (empty) empty.remove();
  const item = document.createElement('article'); item.className = `message ${mine ? 'mine' : ''} ${!isGroup ? 'private' : ''}`; item.dataset.messageId = m.id;
  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fileUrl = m.attachment ? `/api/files/${encodeURIComponent(m.attachment.id)}?token=${encodeURIComponent(state.token)}` : '';
  const isImage = !!m.attachment && /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i.test(m.attachment.mimeType || '');
  const isVideo = !!m.attachment && /^video\//i.test(m.attachment.mimeType || '');
  const attachmentHtml = m.attachment ? (isImage
    ? `<div class="attachment-card image-attachment"><button class="image-preview-button" type="button" data-image-url="${fileUrl}&preview=1" data-image-name="${escapeHtml(m.attachment.name)}" aria-label="Открыть фото"><img class="message-image-preview" src="${fileUrl}&preview=1" alt="${escapeHtml(m.attachment.name)}" loading="lazy"></button><div class="attachment-image-footer"><span class="attachment-name">${escapeHtml(m.attachment.name)}</span><small>${formatFileSize(m.attachment.size)}</small><a href="${fileUrl}" rel="noopener">Скачать</a></div></div>`
    : isVideo
      ? `<div class="attachment-card video-attachment"><video class="message-video-preview" src="${fileUrl}" controls playsinline preload="metadata"></video><div class="attachment-image-footer"><span class="attachment-name">${escapeHtml(m.attachment.name)}</span><small>${formatFileSize(m.attachment.size)}</small><a href="${fileUrl}" rel="noopener">Скачать</a></div></div>`
      : `<div class="attachment-card"><span>📎</span><span class="attachment-name">${escapeHtml(m.attachment.name)}</span><small>${formatFileSize(m.attachment.size)}</small><a href="${fileUrl}" rel="noopener">Скачать</a></div>`) : '';
  state.messageCache.set(m.id, { ...m, displayText });
  const replyHtml = m.replyTo ? `<div class="message-reply-quote"><strong>${escapeHtml(m.replyTo.fromNickname || 'Сообщение')}</strong><span>${escapeHtml(m.replyTo.text || 'Вложение')}</span></div>` : '';
  const emojiOnly = !m.attachment ? classifyEmojiMessage(displayText) : null;
  if (emojiOnly) item.classList.add(`emoji-message-${emojiOnly.count}`, `emoji-motion-${emojiOnly.kind}`);
  item.innerHTML = `<div class="message-tools"><button class="message-more" type="button" aria-label="Действия с сообщением" title="Действия">⋯</button><div class="message-action-menu hidden" role="menu"><button type="button" data-message-action="reply">↩ <span>Ответить</span></button><button type="button" data-message-action="forward">↗ <span>Переслать</span></button><button type="button" data-message-action="copy">▢ <span>Скопировать</span></button>${mine ? '<button type="button" data-message-action="edit">✎ <span>Изменить</span></button>' : ''}<button type="button" data-message-action="delete"><svg class="message-delete-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4.5 7h15M9 7V4.8h6V7m-8.1 0 .8 12.1h8.6L17.1 7M10 10.5v5.8m4-5.8v5.8"/></svg><span>Удалить</span></button></div></div><div class="message-meta"><strong>${mine ? 'Вы' : escapeHtml(m.fromNickname)}</strong><time>${time}${mine ? ` <span class="message-status ${(m.readAt || state.readReceipts.has(m.id)) ? 'read' : ''}" title="${(m.readAt || state.readReceipts.has(m.id)) ? 'Прочитано' : 'Отправлено'}">${(m.readAt || state.readReceipts.has(m.id)) ? '✓✓' : '✓'}</span>` : ''}</time></div>${replyHtml}<div class="message-bubble">${escapeHtml(displayText)}${attachmentHtml}</div>${m.editedAt ? '<small class="message-edited">изменено</small>' : ''}`;
  const messageArea = $('messages');
  const wasNearBottom = messageArea.scrollHeight - messageArea.scrollTop - messageArea.clientHeight < 100;
  messageArea.appendChild(item);
  if (m.type === 'private') { const peer = m.fromId === state.me.id ? m.toId : m.fromId; if (peer) state.conversationIds.add(peer); renderContacts(); }
  if (wasNearBottom) scrollBottom(); else updateScrollButton();
}
function jumpToLatest(behavior = 'smooth') {
  const el = $('messages');
  if (!el) return;
  const scrollToEnd = () => {
    if (behavior === 'smooth') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
    updateScrollButton();
  };
  scrollToEnd();
  // Re-apply after message/media layout settles.
  requestAnimationFrame(() => {
    scrollToEnd();
    requestAnimationFrame(scrollToEnd);
  });
  setTimeout(scrollToEnd, 180);
  setTimeout(scrollToEnd, 650);
}
function scrollBottom() {
  jumpToLatest('smooth');
}
function updateScrollButton() {
  const el = $('messages');
  const button = $('scrollBottomButton');
  if (!el || !button) return;
  const away = el.scrollHeight - el.scrollTop - el.clientHeight > 80;
  const unreadRemaining = state.chatUnreadIds.filter(id => { const item = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`); return item && item.getBoundingClientRect().top >= el.getBoundingClientRect().top - 8; }).length;
  button.classList.toggle('at-latest', !away);
  button.classList.toggle('hidden', !away);
  button.classList.toggle('has-unread', away && unreadRemaining > 0);
  button.innerHTML = `↓${away && unreadRemaining ? `<span class="scroll-unread-count">${unreadRemaining > 99 ? '99+' : unreadRemaining}</span>` : ''}`;
  button.setAttribute('aria-label', away ? `Перейти к последнему сообщению${unreadRemaining ? `, непрочитанных ${unreadRemaining}` : ''}` : 'Вы уже у последнего сообщения');
  button.title = away ? `Перейти к последнему сообщению${unreadRemaining ? ` · непрочитанных ${unreadRemaining}` : ''}` : 'Вы уже у последнего сообщения';
}
function connectSocket() {
  if (state.ws) state.ws.close(); const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/?token=${encodeURIComponent(state.token)}`); state.ws = ws;
  ws.addEventListener('open', async () => { $('connectionText').textContent = 'Подключено'; $('connectionDot').classList.add('connected');
    // Catch up on messages missed while offline; no manual refresh needed.
    try { await loadUsers(); const url = state.selected ? `/api/messages?with=${encodeURIComponent(state.selected)}` : '/api/messages'; const result = await api(url); for (const message of result.messages) await addMessage(message); markIncomingMessagesRead(result.messages); flushPendingReadReceipts(); if (!result.messages.length && !$('messages').querySelector('.message')) showWelcome(); else jumpToLatest('auto'); } catch (err) { if (state.me) toastError(err.message); }
  });
  ws.addEventListener('message', event => { let data; try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'message') { addMessage(data.message, true); loadUsers(); }
    if (data.type === 'message-updated') updateMessageDisplay(data.message);
    if (data.type === 'message-deleted') removeMessageDisplay(data.messageId);
    if (data.type === 'read') { updateReadStatuses(data.messageIds); loadUsers(); }
    if (data.type === 'presence') { state.online = new Set((data.users || []).map(u => u.id)); renderContacts(); if (state.selected) renderChatHeader(); loadUsers(); }
    if (data.type === 'typing' && data.toId !== state.me?.id) { /* not used: server sends typing to recipient without toId */ }
    if (data.type === 'typing' && data.fromId === state.selected) { $('typingIndicator').textContent = data.active ? `${data.fromNickname} печатает…` : ''; clearTimeout(state.typingClear); if (data.active) state.typingClear = setTimeout(() => $('typingIndicator').textContent = '', 1800); }
  });
  ws.addEventListener('close', () => { $('connectionText').textContent = 'Переподключение…'; $('connectionDot').classList.remove('connected'); if (state.token && state.me) setTimeout(() => { if (state.token && (!state.ws || state.ws.readyState === WebSocket.CLOSED)) connectSocket(); }, 1800); });
  ws.addEventListener('error', () => { $('connectionText').textContent = 'Нет соединения'; });
}
$('groupButton').addEventListener('click', () => state.pendingForward ? forwardMessageTo(null) : selectChat(null));
$('cancelForwardButton').addEventListener('click', cancelForward);

$('backToChatsButton').addEventListener('click', () => { if (appScreen.classList.contains('chat-open') && history.state?.messengerChat) history.back(); else showChatsPanel(); });
$('scrollBottomButton').addEventListener('click', event => {
  event.preventDefault();
  event.stopPropagation();
  scrollBottom();
});
$('messages').addEventListener('click', async event => {
  const more = event.target.closest('.message-more');
  if (more) { event.preventDefault(); event.stopPropagation(); toggleMessageMenu(more.closest('.message')); return; }
  const action = event.target.closest('[data-message-action]');
  if (action) { event.preventDefault(); event.stopPropagation(); const item = action.closest('.message'); closeMessageMenus(); await handleMessageAction(item?.dataset.messageId, action.dataset.messageAction); return; }
  const button = event.target.closest('.image-preview-button');
  if (!button) return;
  $('imageViewerImage').src = button.dataset.imageUrl;
  $('imageViewerImage').alt = button.dataset.imageName || 'Фото';
  $('imageViewerCaption').textContent = button.dataset.imageName || 'Фото';
  $('imageViewerModal').classList.remove('hidden');
});
let longPressTimer = null, longPressTriggered = false, longPressStart = null;
const cancelMessageLongPress = () => { clearTimeout(longPressTimer); longPressTimer = null; longPressStart = null; };
$('messages').addEventListener('pointerdown', event => {
  if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
  const bubble = event.target.closest('.message-bubble'); if (!bubble) return;
  cancelMessageLongPress();
  longPressTriggered = false;
  longPressStart = { x: event.clientX, y: event.clientY };
  longPressTimer = setTimeout(() => {
    longPressTriggered = true;
    const item = bubble.closest('.message');
    document.querySelectorAll('.message.long-pressed').forEach(el => el.classList.remove('long-pressed'));
    item?.classList.add('long-pressed');
    toggleMessageMenu(item, true);
  }, 520);
}, { passive: true });
$('messages').addEventListener('pointermove', event => {
  if (!longPressStart) return;
  if (Math.abs(event.clientX - longPressStart.x) > 12 || Math.abs(event.clientY - longPressStart.y) > 12) cancelMessageLongPress();
}, { passive: true });
for (const name of ['pointerup','pointercancel']) $('messages').addEventListener(name, () => {
  cancelMessageLongPress();
  if (name === 'pointerup') setTimeout(() => { longPressTriggered = false; }, 600);
}, { passive: true });
$('messages').addEventListener('contextmenu', event => { if (event.target.closest('.message-bubble')) event.preventDefault(); });
document.addEventListener('click', event => {
  // Снимаем подсветку выбранного сообщения при нажатии в любом другом месте экрана.
  const selectedMessage = event.target.closest('.message.long-pressed');
  if (!selectedMessage) {
    document.querySelectorAll('.message.long-pressed').forEach(el => el.classList.remove('long-pressed'));
  }
  if (!event.target.closest('.message-tools')) closeMessageMenus();
});
function closeMessageMenus() {
  document.querySelectorAll('.message-action-menu:not(.hidden)').forEach(menu => { menu.classList.add('hidden'); menu.style.top = ''; menu.style.left = ''; });
  document.querySelectorAll('.message.menu-open').forEach(item => item.classList.remove('menu-open'));
}
function toggleMessageMenu(item, fromLongPress = false) {
  if (!item) return;
  const menu = item.querySelector('.message-action-menu'); if (!menu) return;
  const wasOpen = !menu.classList.contains('hidden'); closeMessageMenus(); if (wasOpen && !fromLongPress) return;
  menu.classList.remove('hidden'); item.classList.add('menu-open');
  const rect = item.getBoundingClientRect();
  const width = Math.min(190, window.innerWidth - 16);
  let left = rect.right - width;
  if (window.matchMedia('(max-width: 720px)').matches) left = rect.left - width - 8;
  if (left < 8) left = Math.min(window.innerWidth - width - 8, rect.right + 8);
  menu.style.width = `${width}px`; menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, Math.min(window.innerHeight - 210, rect.top + 2))}px`;
}
function updateMessageDisplay(m) {
  if (!m?.id) return;
  const previous = state.messageCache.get(m.id) || {};
  const merged = { ...previous, ...m };
  state.messageCache.set(m.id, merged);
  const item = document.querySelector(`[data-message-id="${CSS.escape(m.id)}"]`); if (!item) return;
  decryptMessage(merged).then(text => {
    const bubble = item.querySelector('.message-bubble'); if (!bubble) return;
    merged.displayText = text; state.messageCache.set(m.id, merged);
    const attachment = bubble.querySelector('.attachment-card'); bubble.textContent = text; if (attachment) bubble.appendChild(attachment);
    let edited = item.querySelector('.message-edited');
    if (merged.editedAt) { if (!edited) { edited = document.createElement('small'); edited.className = 'message-edited'; item.appendChild(edited); } edited.textContent = 'изменено'; }
    else edited?.remove();
  }).catch(() => {});
}
function removeMessageDisplay(id) {
  document.querySelector(`[data-message-id="${CSS.escape(id)}"]`)?.remove();
  state.seen.delete(id); state.messageCache.delete(id);
  if (!$('messages').querySelector('.message')) showWelcome();
}
function renderReplyComposer() {
  let banner = $('replyComposerBanner');
  if (!banner) return;
  if (!state.replyingTo) { banner.classList.add('hidden'); banner.innerHTML = ''; return; }
  banner.innerHTML = `<div class="reply-composer-copy"><strong>Ответ на сообщение · ${escapeHtml(state.replyingTo.fromNickname)}</strong><span>${escapeHtml(state.replyingTo.text)}</span></div><button type="button" id="cancelReplyButton" aria-label="Отменить ответ" title="Отменить ответ">×</button>`;
  banner.classList.remove('hidden');
  $('cancelReplyButton').addEventListener('click', () => { state.replyingTo = null; renderReplyComposer(); });
}
async function handleMessageAction(id, action) {
  const m = state.messageCache.get(id); if (!m) return;
  if (action === 'reply') {
    state.replyingTo = { id: m.id, fromNickname: m.fromNickname || (m.fromId === state.me.id ? 'Вы' : 'Пользователь'), text: String(m.displayText ?? await decryptMessage(m) ?? '').trim().slice(0, 180) || (m.attachment?.name ? `📎 ${m.attachment.name}` : 'Сообщение') };
    renderReplyComposer();
    $('messageInput').focus();
    setTimeout(() => $('messageInput').scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 80);
  } else if (action === 'copy') {
    const text = m.displayText ?? await decryptMessage(m);
    try { await navigator.clipboard.writeText(text || m.attachment?.name || ''); toastError('Сообщение скопировано.'); }
    catch { const area = document.createElement('textarea'); area.value = text || m.attachment?.name || ''; document.body.appendChild(area); area.select(); const ok = document.execCommand('copy'); area.remove(); toastError(ok ? 'Сообщение скопировано.' : 'Не удалось скопировать сообщение.'); }
  } else if (action === 'forward') {
    state.pendingForward = { message: m, returnChat: state.selected };
    $('forwardModeBanner').classList.remove('hidden'); $('userSearch').value = ''; renderContacts(); showChatsPanel();
    toastError('Выбери чат или общий чат для пересылки.');
  } else if (action === 'edit' && m.fromId === state.me.id) {
    state.editingMessage = m; $('messageEditText').value = m.displayText ?? await decryptMessage(m); $('messageEditError').textContent = ''; $('messageEditModal').classList.remove('hidden'); setTimeout(() => $('messageEditText').focus(), 40);
  } else if (action === 'delete') {
    state.pendingDeleteMessage = m;
    const mine = m.fromId === state.me.id;
    $('deleteForEveryoneButton').classList.toggle('hidden', !mine);
    $('messageDeleteModal').classList.remove('hidden');
  }
}
function cancelForward() {
  const pending = state.pendingForward; state.pendingForward = null; $('forwardModeBanner').classList.add('hidden');
  if (pending) selectChat(pending.returnChat);
}
async function forwardMessageTo(toId) {
  const pending = state.pendingForward; if (!pending) return;
  const m = pending.message;
  try {
    const text = m.displayText ?? await decryptMessage(m);
    const payload = toId ? { type: 'private', toId, text, ...(m.attachment ? { attachment: m.attachment } : {}) } : { type: 'group', text, ...(m.attachment ? { attachment: m.attachment } : {}) };
    await api('/api/messages', { method: 'POST', body: JSON.stringify(payload) });
    state.pendingForward = null; $('forwardModeBanner').classList.add('hidden'); $('userSearch').value = '';
    await loadUsers(); await selectChat(pending.returnChat);
    toastError('Сообщение переслано.');
  } catch (err) { toastError(err.message || 'Не удалось переслать сообщение.'); }
}
$('messageEditForm').addEventListener('submit', async event => {
  event.preventDefault(); const m = state.editingMessage; const text = $('messageEditText').value.trim();
  if (!m || !text) { $('messageEditError').textContent = 'Введи текст сообщения.'; return; }
  try {
    const result = await api(`/api/messages/${encodeURIComponent(m.id)}`, { method: 'PATCH', body: JSON.stringify({ text }) });
    state.messageCache.set(m.id, { ...state.messageCache.get(m.id), ...result.message, legacyText: text, displayText: text }); updateMessageDisplay({ ...result.message, legacyText: text });
    $('messageEditModal').classList.add('hidden'); state.editingMessage = null;
  } catch (err) { $('messageEditError').textContent = err.message || 'Не удалось изменить сообщение.'; }
});
function closeEditModal() { $('messageEditModal').classList.add('hidden'); state.editingMessage = null; }
$('messageEditClose').addEventListener('click', closeEditModal); $('messageEditCancel').addEventListener('click', closeEditModal);
$('messageEditModal').addEventListener('click', event => { if (event.target === $('messageEditModal')) closeEditModal(); });
async function deleteMessage(scope) {
  const m = state.pendingDeleteMessage; if (!m) return;
  try { await api(`/api/messages/${encodeURIComponent(m.id)}`, { method: 'DELETE', body: JSON.stringify({ scope }) }); removeMessageDisplay(m.id); $('messageDeleteModal').classList.add('hidden'); state.pendingDeleteMessage = null; }
  catch (err) { toastError(err.message || 'Не удалось удалить сообщение.'); }
}
$('deleteForMeButton').addEventListener('click', () => deleteMessage('me'));
$('deleteForEveryoneButton').addEventListener('click', () => deleteMessage('everyone'));
function closeDeleteModal() { $('messageDeleteModal').classList.add('hidden'); state.pendingDeleteMessage = null; }
$('messageDeleteClose').addEventListener('click', closeDeleteModal);
$('messageDeleteModal').addEventListener('click', event => { if (event.target === $('messageDeleteModal')) closeDeleteModal(); });
function closeImageViewer() { $('imageViewerModal').classList.add('hidden'); $('imageViewerImage').src = ''; }
$('imageViewerClose').addEventListener('click', closeImageViewer);
$('imageViewerModal').addEventListener('click', event => { if (event.target === $('imageViewerModal')) closeImageViewer(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('imageViewerModal').classList.contains('hidden')) closeImageViewer(); });
let previousMessagesScrollTop = 0;
$('messages').addEventListener('scroll', () => {
  const messages = $('messages');
  const composer = $('messageForm');
  if (!messages || !composer) { updateScrollButton(); return; }
  const currentTop = messages.scrollTop;
  const distanceFromBottom = messages.scrollHeight - currentTop - messages.clientHeight;
  const movingUp = currentTop < previousMessagesScrollTop - 2;
  const movingDown = currentTop > previousMessagesScrollTop + 2;
  if (distanceFromBottom < 48 || $('messageInput') === document.activeElement) {
    composer.classList.remove('composer-away');
  } else if (movingUp) {
    composer.classList.add('composer-away');
  } else if (movingDown) {
    composer.classList.remove('composer-away');
  }
  previousMessagesScrollTop = currentTop;
  if (distanceFromBottom < 48) state.chatUnreadIds = [];
  updateScrollButton();
});
$('messageInput').addEventListener('focus', () => $('messageForm').classList.remove('composer-away'));

function openProfileModal() {
  if (!state.me) return;
  $('profileNickname').value = state.me.nickname || '';
  $('profileBio').value = state.me.bio || '';
  $('profileBackground').value = /^#[0-9a-fA-F]{6}$/.test(state.me.profileBackground || '') ? state.me.profileBackground : '#202020';
  $('profileAvatarPreview').src = state.me.avatarData || '';
  $('profileBackgroundFile').value = ''; renderBackgroundPreview(state.me.profileBackgroundMedia || '');
  $('profileError').textContent = '';
  $('profileModal').classList.remove('hidden');
}
function closeProfileModal() { $('profileModal').classList.add('hidden'); $('profileAvatarFile').value = ''; }
$('myAvatar').addEventListener('click', openProfileModal);
function openPublicProfile(user) {
  if (!user) return;
  $('publicProfileName').textContent = user.nickname || 'Пользователь'; $('publicProfileBio').textContent = user.bio || 'Описание не добавлено.'; $('publicProfileStatus').textContent = state.online.has(user.id) ? 'В сети' : 'Не в сети';
  setAvatar($('publicProfileAvatar'), user);
  const cover = $('publicProfileCover'); cover.innerHTML = ''; cover.style.backgroundColor = /^#[0-9a-fA-F]{6}$/.test(user.profileBackground || '') ? user.profileBackground : '#202020';
  const media = user.profileBackgroundMedia || '';
  if (media) { if (/\.(mp4|webm|mov)(?:$|\?)/i.test(media)) { const v = document.createElement('video'); v.src = media; v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true; cover.append(v); } else { cover.style.backgroundImage = `url(\"${media}\")`; cover.style.backgroundSize = 'cover'; cover.style.backgroundPosition = 'center'; } }
  $('publicProfileModal').classList.remove('hidden');
}
$('chatAvatar').addEventListener('click', () => { if (state.selected) openPublicProfile(state.users.find(u => u.id === state.selected)); });
$('myPublicProfileButton').addEventListener('click', () => openPublicProfile(state.me));
$('myNickname').addEventListener('click', () => openPublicProfile(state.me));
$('myNickname').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPublicProfile(state.me); } });
$('publicProfileClose').addEventListener('click', () => $('publicProfileModal').classList.add('hidden'));
$('publicProfileModal').addEventListener('click', e => { if (e.target === $('publicProfileModal')) $('publicProfileModal').classList.add('hidden'); });

$('profileClose').addEventListener('click', closeProfileModal);
$('profileCancel').addEventListener('click', closeProfileModal);
$('profileModal').addEventListener('click', e => { if (e.target === $('profileModal')) closeProfileModal(); });
$('profileAvatarFile').addEventListener('change', () => {
  const file = $('profileAvatarFile').files?.[0]; if (!file) return;
  if (!file.type.startsWith('image/')) { $('profileError').textContent = 'Выбери файл изображения.'; return; }
  if (file.size > 2 * 1024 * 1024) { $('profileError').textContent = 'Выбери изображение размером до 2 МБ.'; return; }
  const reader = new FileReader(); reader.onload = () => {
    const img = new Image(); img.onload = () => {
      const canvas = document.createElement('canvas'); const scale = Math.min(1, 256 / Math.max(img.width, img.height)); canvas.width = Math.max(1, Math.round(img.width * scale)); canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height); $('profileAvatarPreview').src = canvas.toDataURL('image/jpeg', .78); $('profileError').textContent = '';
    }; img.onerror = () => $('profileError').textContent = 'Не удалось прочитать изображение.'; img.src = reader.result;
  }; reader.readAsDataURL(file);
});
function renderBackgroundPreview(url, kind) {
  const box = $('profileBackgroundPreview'); box.innerHTML = ''; box.classList.toggle('hidden', !url); if (!url) return;
  if (kind === 'video' || /\.(mp4|webm|mov)(?:$|\?)/i.test(url)) { const v = document.createElement('video'); v.src = url; v.controls = true; v.muted = true; v.playsInline = true; box.append(v); }
  else { const img = document.createElement('img'); img.src = url; img.alt = 'Предпросмотр фона профиля'; box.append(img); }
}
$('profileBackgroundFile').addEventListener('change', () => {
  const f = $('profileBackgroundFile').files?.[0]; if (!f) return;
  const video = f.type.startsWith('video/'); const max = video ? 30*1024*1024 : 10*1024*1024;
  if (!(f.type.startsWith('image/') || video)) { $('profileError').textContent = 'Выбери фото или видео.'; return; }
  if (f.size > max) { $('profileError').textContent = video ? 'Видео должно быть не больше 30 МБ.' : 'Фото должно быть не больше 10 МБ.'; return; }
  const localUrl = URL.createObjectURL(f); renderBackgroundPreview(localUrl, video ? 'video' : 'image'); $('profileError').textContent = '';
});
$('profileForm').addEventListener('submit', async e => {
  e.preventDefault(); $('profileError').textContent = '';
  const avatar = $('profileAvatarPreview').src.startsWith('data:image/') ? $('profileAvatarPreview').src : '';
  try {
    let backgroundMedia = state.me.profileBackgroundMedia || '';
    const file = $('profileBackgroundFile').files?.[0];
    if (file) {
      const form = new FormData(); form.append('file', file);
      const response = await fetch('/api/profile-background', { method: 'POST', headers: { Authorization: `Bearer ${state.token}` }, body: form });
      const uploaded = await response.json(); if (!response.ok) throw new Error(uploaded.error || 'Не удалось загрузить фон.'); backgroundMedia = uploaded.url;
    }
    const result = await api('/api/profile', { method: 'PATCH', body: JSON.stringify({ nickname: $('profileNickname').value, bio: $('profileBio').value, avatarData: avatar, profileBackground: $('profileBackground').value, profileBackgroundMedia: backgroundMedia }) });
    state.me = { ...state.me, ...result.user }; $('myNickname').textContent = state.me.nickname; setAvatar($('myAvatar'), state.me); renderContacts(); renderChatHeader(); closeProfileModal();
  } catch (err) { $('profileError').textContent = err.message || 'Не удалось сохранить профиль.'; }
});
$('themeButton').addEventListener('click', () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('messengerTheme', state.theme); setTheme(); });
function formatFileSize(bytes) { const n = Number(bytes) || 0; return n < 1024 ? `${n} Б` : n < 1024*1024 ? `${(n/1024).toFixed(1)} КБ` : `${(n/1024/1024).toFixed(1)} МБ`; }
function closeAttachmentChooser() { $('attachmentChooser').classList.add('hidden'); document.body.classList.remove('attachment-chooser-open'); }
function closeMobileMediaSheet() { const sheet = $('mobileMediaSheet'); if (!sheet) return; sheet.classList.add('hidden'); sheet.classList.remove('expanded'); document.body.classList.remove('mobile-media-sheet-open'); }
function openMobileMediaSheet() { closeAttachmentChooser(); const sheet = $('mobileMediaSheet'); sheet.classList.remove('hidden', 'expanded'); document.body.classList.add('mobile-media-sheet-open'); }
$('attachButton').addEventListener('click', () => {
  if (window.matchMedia('(max-width: 720px)').matches) {
    const chooser = $('attachmentChooser');
    const opening = chooser.classList.contains('hidden');
    chooser.classList.toggle('hidden', !opening);
    document.body.classList.toggle('attachment-chooser-open', opening);
  } else $('fileInput').click();
});
$('attachmentChooser').addEventListener('click', e => { if (e.target.closest('[data-close-attachment-chooser]')) closeAttachmentChooser(); });
$('chooseFileButton').addEventListener('click', () => { closeAttachmentChooser(); $('fileInput').click(); });
$('chooseMediaButton').addEventListener('click', () => { if (window.matchMedia('(max-width: 720px)').matches) openMobileMediaSheet(); else $('mediaInput').click(); });
$('mobileMediaClose').addEventListener('click', closeMobileMediaSheet);
$('mobileMediaSheet').addEventListener('click', e => { if (e.target.closest('[data-close-media-sheet]')) closeMobileMediaSheet(); });
$('openDeviceGalleryButton').addEventListener('click', () => { $('mediaInput').click(); });
const mediaPanel = $('mobileMediaPanel');
const mediaHandle = $('mobileMediaHandleArea');
let mediaTouchStartY = 0, mediaTouchLastY = 0, mediaTouching = false;
mediaHandle.addEventListener('touchstart', e => { mediaTouchStartY = mediaTouchLastY = e.touches[0].clientY; mediaTouching = true; }, { passive: true });
mediaHandle.addEventListener('touchmove', e => { if (!mediaTouching) return; mediaTouchLastY = e.touches[0].clientY; }, { passive: true });
mediaHandle.addEventListener('touchend', () => { if (!mediaTouching) return; const delta = mediaTouchLastY - mediaTouchStartY; if (delta < -35) $('mobileMediaSheet').classList.add('expanded'); else if (delta > 35) closeMobileMediaSheet(); mediaTouching = false; }, { passive: true });
mediaHandle.addEventListener('click', () => { const sheet = $('mobileMediaSheet'); sheet.classList.toggle('expanded'); });
mediaHandle.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('mobileMediaSheet').classList.toggle('expanded'); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeAttachmentChooser(); closeMobileMediaSheet(); } });
async function uploadChosenAttachment(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) { toastError('Максимальный размер файла сейчас 50 МБ.'); input.value = ''; return; }
  $('attachButton').disabled = true; $('typingIndicator').textContent = `Загрузка файла: ${file.name}`;
  try {
    const form = new FormData(); form.append('file', file);
    const response = await fetch('/api/upload', { method: 'POST', headers: { Authorization: `Bearer ${state.token}` }, body: form });
    let data = {}; try { data = await response.json(); } catch {}
    if (!response.ok) throw new Error(data.error || `Ошибка загрузки ${response.status}`);
    const payload = state.selected ? { type: 'private', toId: state.selected, text: `Файл: ${file.name}`, attachment: data.attachment } : { type: 'group', text: `Файл: ${file.name}`, attachment: data.attachment };
    const result = await api('/api/messages', { method: 'POST', body: JSON.stringify(payload) });
    if (result.message) await addMessage(result.message);
    await loadUsers();
    toastError('Вложение отправлено.');
  } catch (err) { toastError(err.message); }
  finally { $('attachButton').disabled = false; input.value = ''; $('typingIndicator').textContent = ''; }
}
$('fileInput').addEventListener('change', () => uploadChosenAttachment($('fileInput')));
$('mediaInput').addEventListener('change', () => { if ($('mediaInput').files?.length) closeMobileMediaSheet(); uploadChosenAttachment($('mediaInput')); });
$('messageForm').addEventListener('submit', async e => {
  e.preventDefault(); const text = $('messageInput').value.trim(); if (!text) return;
  $('sendButton').disabled = true;
  try { const isPrivate = !!state.selected; const replyTo = state.replyingTo ? { ...state.replyingTo } : null; const payload = { ...(isPrivate ? { type: 'private', toId: state.selected } : { type: 'group' }), text, ...(replyTo ? { replyTo } : {}) }; const result = await api('/api/messages', { method: 'POST', body: JSON.stringify(payload) }); if (result.message) await addMessage(result.message); await loadUsers(); $('messageInput').value = ''; $('messageInput').style.height = 'auto'; state.replyingTo = null; renderReplyComposer(); closeEmojiPicker(); sendTyping(false); }
  catch (err) { toastError(err.message); }
  finally { $('sendButton').disabled = false; $('messageInput').focus(); }
});
$('messageInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('messageForm').requestSubmit(); } });
$('messageInput').addEventListener('input', () => { const el = $('messageInput'); el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 140) + 'px'; if (state.selected) sendTyping(true); });
function sendTyping(active) { if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !state.selected) return; state.ws.send(JSON.stringify({ type: 'typing', toId: state.selected, active })); if (active) { clearTimeout(state.typingTimer); state.typingTimer = setTimeout(() => sendTyping(false), 1200); } }
function insertEmoji(emoji) {
  const el = $('messageInput');
  const isMobile = window.matchMedia('(max-width: 720px)').matches;
  const start = Number.isInteger(el.selectionStart) ? el.selectionStart : el.value.length;
  const end = Number.isInteger(el.selectionEnd) ? el.selectionEnd : start;
  el.value = el.value.slice(0, start) + emoji + el.value.slice(end);
  const caret = start + emoji.length;
  if (!isMobile) { el.focus(); el.setSelectionRange(caret, caret); }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function closeEmojiPicker() {
  $('emojiPicker').classList.add('hidden');
  $('emojiButton').setAttribute('aria-expanded', 'false');
}
$('emojiButton').addEventListener('click', event => {
  event.preventDefault(); event.stopPropagation();
  const picker = $('emojiPicker');
  const opening = picker.classList.contains('hidden');
  picker.classList.toggle('hidden', !opening);
  $('emojiButton').setAttribute('aria-expanded', String(opening));
  if (opening && window.matchMedia('(max-width: 720px)').matches) {
    // On phones, use the app's own picker instead of the native keyboard.
    $('messageInput').blur();
    $('messageForm').classList.remove('composer-away');
  }
});
$('emojiPicker').addEventListener('click', event => {
  const option = event.target.closest('[data-emoji]');
  if (!option) return;
  insertEmoji(option.dataset.emoji);
  // Keep the picker open so multiple emojis can be selected before sending.
});
function classifyEmojiMessage(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  let parts;
  try { parts = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map(x => x.segment); }
  catch { parts = Array.from(value); }
  const isEmoji = part => /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(part) && !/[\p{L}\p{N}]/u.test(part);
  if (!parts.length || !parts.every(isEmoji)) return null;
  const count = parts.length >= 4 ? 4 : parts.length;
  const kind = parts.length === 1 ? (/[❤️♥]/u.test(value) ? 'heart' : /👍/u.test(value) ? 'like' : /😂|🤣|😆/u.test(value) ? 'laugh' : /🎉|✨|🔥|👏/u.test(value) ? 'celebrate' : 'soft') : 'none';
  return { count, kind };
}
function toastError(message) { $('typingIndicator').textContent = message; $('typingIndicator').style.color = 'var(--danger)'; setTimeout(() => { $('typingIndicator').textContent = ''; $('typingIndicator').style.color = ''; }, 3500); }
// Требуется повторный вход с паролем, чтобы разблокировать приватный ключ E2EE.
setMode('login');

; (async () => {
  if (!state.token) return;
  try {
    const data = await api('/api/me');
    state.me = data.user;
    await enterApp();
  } catch (e) {
    state.token = '';
    state.me = null;
    localStorage.removeItem('messengerToken');
  }
})();
