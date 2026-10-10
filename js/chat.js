// Vibe Pare — Chat logic (v3 - debug)

console.log('=== CHAT.JS LOADED ===');

let user = null;
try {
  user = JSON.parse(localStorage.getItem('vibepare_user') || 'null');
} catch (e) { user = null; }

const roomId = localStorage.getItem('vibepare_room');
console.log('User:', user);
console.log('Room ID:', roomId);

if (!user || !roomId) {
  console.log('Missing user or room — redirecting');
  window.location.href = 'index.html';
}

const messagesEl = document.getElementById('messages');
const msgInput = document.getElementById('msgInput');
const sendBtn = document.getElementById('sendBtn');
const typingIndicator = document.getElementById('typingIndicator');
const partnerNameEl = document.getElementById('partnerName');
const partnerMetaEl = document.getElementById('partnerMeta');

console.log('Elements found:', {
  messages: !!messagesEl,
  input: !!msgInput,
  sendBtn: !!sendBtn,
  typing: !!typingIndicator
});

let partnerSession = null;
let lastMessageTime = 0;
let roomChannel = null;
let presenceChannel = null;
let typingTimeout = null;
let renderedMessageIds = new Set();

// ---------- Load room ----------
async function loadRoom() {
  console.log('[1] Loading room...');

  const { data: room, error } = await supabaseClient
    .from('rooms')
    .select('*')
    .eq('id', roomId)
    .single();

  if (error || !room) {
    console.error('[1] Failed:', error);
    return;
  }

  console.log('[1] Room loaded:', room);

  const isUserA = room.user_a_session === user.sessionId;
  partnerSession = isUserA ? room.user_b_session : room.user_a_session;
  const partnerName = isUserA ? room.user_b_name : room.user_a_name;
  const partnerGender = isUserA ? room.user_b_gender : room.user_a_gender;

  if (partnerNameEl) partnerNameEl.textContent = partnerName;
  if (partnerMetaEl) partnerMetaEl.textContent = `${partnerGender} • ${room.country}`;

  await loadMessages();
  subscribeMessages();
  setupPresence();

  // Fallback: also poll every 3 seconds (in case realtime fails)
  setInterval(loadMessages, 3000);
  console.log('[1] Setup complete');
}

// ---------- Load messages ----------
async function loadMessages() {
  const { data, error } = await supabaseClient
    .from('messages')
    .select('*')
    .eq('room_id', roomId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[2] Load messages error:', error);
    return;
  }

  console.log('[2] Loaded', (data || []).length, 'messages from DB');

  (data || []).forEach(msg => {
    if (!renderedMessageIds.has(msg.id)) {
      addMessageToUI(msg);
    }
  });
  scrollToBottom();
}

// ---------- Realtime subscribe ----------
function subscribeMessages() {
  console.log('[3] Subscribing to realtime channel: chat_' + roomId);

  roomChannel = supabaseClient
    .channel('chat_' + roomId)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      (payload) => {
        console.log('[3] REALTIME EVENT:', payload);
        if (payload.new.room_id !== roomId) {
          console.log('[3] Ignoring — wrong room');
          return;
        }
        if (renderedMessageIds.has(payload.new.id)) {
          console.log('[3] Ignoring — already rendered');
          return;
        }
        addMessageToUI(payload.new);
        scrollToBottom();
      }
    )
    .subscribe((status, err) => {
      console.log('[3] Channel status:', status, err || '');
    });
}

// ---------- Add message ----------
function addMessageToUI(msg) {
  if (!messagesEl) return;
  if (renderedMessageIds.has(msg.id)) return;
  renderedMessageIds.add(msg.id);

  const isMine = msg.sender_session === user.sessionId;
  const div = document.createElement('div');
  div.className = 'msg ' + (isMine ? 'mine' : 'theirs');
  div.innerHTML = `
    <div class="msg-bubble">${escapeHtml(msg.content)}</div>
    <div class="msg-time">${formatTime(msg.created_at)}</div>
  `;
  messagesEl.appendChild(div);
}

// ---------- Send ----------
async function sendMessage() {
  const text = msgInput.value.trim();
  if (!text) { msgInput.focus(); return; }

  const now = Date.now();
  if (now - lastMessageTime < 1000) { msgInput.focus(); return; }
  lastMessageTime = now;

  msgInput.value = '';
  console.log('[4] Sending message:', text);

  const { data, error } = await supabaseClient.from('messages').insert({
    room_id: roomId,
    sender_session: user.sessionId,
    sender_name: user.name,
    content: text
  }).select();

  if (error) {
    console.error('[4] Send FAILED:', error);
    showSystemMessage('Send failed: ' + error.message);
  } else {
    console.log('[4] Send SUCCESS:', data);
  }

  msgInput.focus();
}

sendBtn.addEventListener('click', (e) => {
  e.preventDefault();
  sendMessage();
});

msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendMessage();
  }
});

// ---------- Presence ----------
function setupPresence() {
  presenceChannel = supabaseClient.channel('presence_' + roomId, {
    config: { presence: { key: user.sessionId } }
  });

  presenceChannel
    .on('presence', { event: 'sync' }, () => {})
    .on('broadcast', { event: 'typing' }, ({ payload }) => {
      if (payload.session !== user.sessionId) showTyping();
    })
    .subscribe(async (status) => {
      console.log('[5] Presence status:', status);
      if (status === 'SUBSCRIBED') {
        await presenceChannel.track({ session: user.sessionId });
      }
    });
}

function showTyping() {
  if (!typingIndicator) return;
  typingIndicator.classList.remove('hidden');
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => typingIndicator.classList.add('hidden'), 2000);
}

// ---------- Buttons ----------
document.getElementById('nextBtn').addEventListener('click', async () => {
  await endChat();
  await supabaseClient.from('waiting_queue').upsert({
    session_id: user.sessionId, name: user.name, country: user.country,
    gender: user.gender, joined_at: new Date().toISOString()
  }, { onConflict: 'session_id' });
  window.location.href = 'match.html';
});

document.getElementById('stopBtn').addEventListener('click', async () => {
  await endChat();
  localStorage.removeItem('vibepare_room');
  localStorage.removeItem('vibepare_user');
  window.location.href = 'index.html';
});

document.getElementById('blockBtn').addEventListener('click', async () => {
  if (!confirm('Block this person?')) return;
  await supabaseClient.from('blocks').insert({
    blocker_session: user.sessionId, blocked_session: partnerSession
  });
  await endChat();
  window.location.href = 'index.html';
});

async function endChat() {
  if (roomChannel) supabaseClient.removeChannel(roomChannel);
  if (presenceChannel) supabaseClient.removeChannel(presenceChannel);
  await supabaseClient.from('rooms').update({ status: 'ended' }).eq('id', roomId);
}

// ---------- Helpers ----------
function scrollToBottom() {
  if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2, '0') + ':' +
         d.getMinutes().toString().padStart(2, '0');
}

function showSystemMessage(text) {
  if (!messagesEl) return;
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
}

// ---------- Init ----------
loadRoom();