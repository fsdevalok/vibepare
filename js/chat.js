// Vibe Pare — Chat logic (v2 - fixed realtime)

// ---------- Get user + room ----------
let user = null;
try {
  user = JSON.parse(localStorage.getItem('vibepare_user') || 'null');
} catch (e) { user = null; }

const roomId = localStorage.getItem('vibepare_room');

if (!user || !roomId) {
  window.location.href = 'index.html';
}

// ---------- DOM ----------
const messagesEl = document.getElementById('messages');
const msgInput = document.getElementById('msgInput');
const sendBtn = document.getElementById('sendBtn');
const typingIndicator = document.getElementById('typingIndicator');
const partnerNameEl = document.getElementById('partnerName');
const partnerMetaEl = document.getElementById('partnerMeta');

let partnerSession = null;
let lastMessageTime = 0;
let roomChannel = null;
let presenceChannel = null;
let typingTimeout = null;
let renderedMessageIds = new Set();

// ---------- Load room ----------
async function loadRoom() {
  console.log('[chat] loading room', roomId);

  const { data: room, error } = await supabaseClient
    .from('rooms')
    .select('*')
    .eq('id', roomId)
    .single();

  if (error || !room) {
    console.error('[chat] room load failed', error);
    window.location.href = 'index.html';
    return;
  }

  console.log('[chat] room loaded', room);

  const isUserA = room.user_a_session === user.sessionId;
  partnerSession = isUserA ? room.user_b_session : room.user_a_session;
  const partnerName = isUserA ? room.user_b_name : room.user_a_name;
  const partnerGender = isUserA ? room.user_b_gender : room.user_a_gender;

  if (partnerNameEl) partnerNameEl.textContent = partnerName;
  if (partnerMetaEl) partnerMetaEl.textContent = `${partnerGender} • ${room.country}`;

  // Load existing messages
  await loadMessages();

  // Subscribe to new messages
  subscribeMessages();

  // Presence for typing + disconnect
  setupPresence();
}

// ---------- Load past messages ----------
async function loadMessages() {
  const { data, error } = await supabaseClient
    .from('messages')
    .select('*')
    .eq('room_id', roomId)
    .order('created_at', { ascending: true });

  if (error) { console.error('[chat] load messages failed', error); return; }

  (data || []).forEach(addMessageToUI);
  scrollToBottom();
  console.log('[chat] loaded', (data || []).length, 'messages');
}

// ---------- Realtime subscribe ----------
function subscribeMessages() {
  console.log('[chat] subscribing to realtime...');

  roomChannel = supabaseClient
    .channel('chat_' + roomId)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages'
      },
      (payload) => {
        console.log('[chat] realtime INSERT received', payload);
        // Filter in JS (server-side filter can fail)
        if (payload.new.room_id !== roomId) return;
        if (renderedMessageIds.has(payload.new.id)) return; // prevent dupes
        addMessageToUI(payload.new);
        scrollToBottom();
      }
    )
    .subscribe((status, err) => {
      console.log('[chat] realtime status:', status, err || '');
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.error('[chat] realtime connection failed');
      }
    });
}

// ---------- Add message to UI ----------
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

  // Optimistic UI (show immediately)
  const tempMsg = {
    id: 'temp_' + Date.now(),
    room_id: roomId,
    sender_session: user.sessionId,
    sender_name: user.name,
    content: text,
    created_at: new Date().toISOString()
  };
  addMessageToUI(tempMsg);
  scrollToBottom();

  const { error } = await supabaseClient.from('messages').insert({
    room_id: roomId,
    sender_session: user.sessionId,
    sender_name: user.name,
    content: text
  });

  if (error) {
    console.error('[chat] send failed', error);
    showSystemMessage('Failed to send: ' + error.message);
  } else {
    console.log('[chat] message sent');
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
  } else {
    broadcastTyping();
  }
});

// ---------- Presence ----------
let partnerWasHere = false;
let disconnectTimer = null;

function setupPresence() {
  presenceChannel = supabaseClient.channel('presence_' + roomId, {
    config: { presence: { key: user.sessionId } }
  });

  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      const state = presenceChannel.presenceState();
      const others = Object.keys(state).filter(k => k !== user.sessionId);
      console.log('[chat] presence sync, others:', others.length);

      if (others.length > 0) {
        partnerWasHere = true;
        if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
      } else if (partnerWasHere) {
        if (!disconnectTimer) {
          disconnectTimer = setTimeout(() => {
            showSystemMessage('Stranger disconnected.');
          }, 3000);
        }
      }
    })
    .on('presence', { event: 'leave' }, ({ key }) => {
      if (key !== user.sessionId && partnerWasHere && !disconnectTimer) {
        disconnectTimer = setTimeout(() => {
          showSystemMessage('Stranger disconnected.');
        }, 3000);
      }
    })
    .on('broadcast', { event: 'typing' }, ({ payload }) => {
      if (payload.session !== user.sessionId) showTyping();
    })
    .subscribe(async (status) => {
      console.log('[chat] presence status:', status);
      if (status === 'SUBSCRIBED') {
        await presenceChannel.track({ session: user.sessionId });
      }
    });
}

function broadcastTyping() {
  if (!presenceChannel) return;
  presenceChannel.send({
    type: 'broadcast',
    event: 'typing',
    payload: { session: user.sessionId }
  });
}

function showTyping() {
  if (!typingIndicator) return;
  typingIndicator.classList.remove('hidden');
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    typingIndicator.classList.add('hidden');
  }, 2000);
}

// ---------- Buttons ----------
document.getElementById('nextBtn').addEventListener('click', async () => {
  await endChat();
  await supabaseClient.from('waiting_queue').upsert({
    session_id: user.sessionId,
    name: user.name,
    country: user.country,
    gender: user.gender,
    joined_at: new Date().toISOString()
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
  if (!confirm('Block this person and never match again?')) return;
  await supabaseClient.from('blocks').insert({
    blocker_session: user.sessionId,
    blocked_session: partnerSession
  });
  await endChat();
  await supabaseClient.from('waiting_queue').upsert({
    session_id: user.sessionId,
    name: user.name,
    country: user.country,
    gender: user.gender,
    joined_at: new Date().toISOString()
  }, { onConflict: 'session_id' });
  window.location.href = 'match.html';
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

// Keep presence alive
setInterval(() => {
  if (presenceChannel) {
    presenceChannel.track({ session: user.sessionId });
  }
}, 25000);