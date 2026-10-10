// Vibe Pare — Chat logic

const user = JSON.parse(localStorage.getItem('vibepare_user') || 'null');
const roomId = localStorage.getItem('vibepare_room');

window.addEventListener('beforeunload', async () => {
  if (presenceChannel) {
    await presenceChannel.untrack();
  }
});

if (!user || !roomId) {
  window.location.href = 'index.html';
}

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

// ---------- Load room info ----------
async function loadRoom() {
  const { data: room } = await supabaseClient
    .from('rooms')
    .select('*')
    .eq('id', roomId)
    .single();

  if (!room) {
    window.location.href = 'index.html';
    return;
  }

  const isUserA = room.user_a_session === user.sessionId;
  partnerSession = isUserA ? room.user_b_session : room.user_a_session;
  const partnerName = isUserA ? room.user_b_name : room.user_a_name;
  const partnerGender = isUserA ? room.user_b_gender : room.user_a_gender;

  partnerNameEl.textContent = partnerName;
  partnerMetaEl.textContent = `${partnerGender} • ${room.country}`;

  loadMessages();
  subscribeMessages();
  setupPresence();
}

// ---------- Load past messages ----------
async function loadMessages() {
  const { data } = await supabaseClient
    .from('messages')
    .select('*')
    .eq('room_id', roomId)
    .order('created_at', { ascending: true });

  (data || []).forEach(addMessageToUI);
  scrollToBottom();
}

// ---------- Realtime: new messages ----------
function subscribeMessages() {
  roomChannel = supabaseClient
    .channel('room:' + roomId)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      (payload) => {
        // Filter in JS instead of server-side
        if (payload.new.room_id !== roomId) return;
        addMessageToUI(payload.new);
        scrollToBottom();
      }
    )
    .subscribe((status) => {
      console.log('Realtime status:', status);
    });
}

// ---------- Add message to UI ----------
function addMessageToUI(msg) {
  const isMine = msg.sender_session === user.sessionId;
  const div = document.createElement('div');
  div.className = 'msg ' + (isMine ? 'mine' : 'theirs');
  div.innerHTML = `
    <div class="msg-bubble">${escapeHtml(msg.content)}</div>
    <div class="msg-time">${formatTime(msg.created_at)}</div>
  `;
  messagesEl.appendChild(div);
}

// ---------- Send message ----------
async function sendMessage() {
  const text = msgInput.value.trim();
  if (!text) {
    msgInput.focus();
    return;
  }

  // Rate limit: 1 message per second
  const now = Date.now();
  if (now - lastMessageTime < 1000) {
    msgInput.focus();
    return;
  }
  lastMessageTime = now;

  msgInput.value = '';

  await supabaseClient.from('messages').insert({
    room_id: roomId,
    sender_session: user.sessionId,
    sender_name: user.name,
    content: text
  });

  // ✅ Keep keyboard open on mobile
  msgInput.focus();
}

// ---------- Input events ----------
sendBtn.addEventListener('click', (e) => {
  e.preventDefault();      // stops button from stealing focus
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

// ---------- Typing indicator (Presence) ----------
let presenceReady = false;
let partnerWasHere = false;
let disconnectTimer = null;

function setupPresence() {
  presenceChannel = supabaseClient.channel('presence:' + roomId, {
    config: { presence: { key: user.sessionId } }
  });

  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      const state = presenceChannel.presenceState();
      const others = Object.keys(state).filter(k => k !== user.sessionId);

      if (others.length > 0) {
        // Partner is here
        partnerWasHere = true;
        if (disconnectTimer) {
          clearTimeout(disconnectTimer);
          disconnectTimer = null;
        }
      } else if (partnerWasHere) {
        // Partner was here, now gone — wait 2s before showing message
        if (!disconnectTimer) {
          disconnectTimer = setTimeout(() => {
            showSystemMessage('Stranger disconnected.');
          }, 2000);
        }
      }
      // If partner was never here yet, do nothing (avoid false alarm)
    })
    .on('presence', { event: 'leave' }, ({ key }) => {
      if (key !== user.sessionId && partnerWasHere) {
        if (!disconnectTimer) {
          disconnectTimer = setTimeout(() => {
            showSystemMessage('Stranger disconnected.');
          }, 2000);
        }
      }
    })
    .on('broadcast', { event: 'typing' }, ({ payload }) => {
      if (payload.session !== user.sessionId) {
        showTyping();
      }
    })
    .subscribe(async (status) => {
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

// ---------- End chat ----------
async function endChat() {
  if (roomChannel) supabaseClient.removeChannel(roomChannel);
  if (presenceChannel) supabaseClient.removeChannel(presenceChannel);

  await supabaseClient
    .from('rooms')
    .update({ status: 'ended' })
    .eq('id', roomId);

  await supabaseClient.from('messages').delete().eq('room_id', roomId);
}

// ---------- Helpers ----------
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ m ]));
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2, '0') + ':' +
    d.getMinutes().toString().padStart(2, '0');
}

function showSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
}

// ---------- Init ----------
loadRoom();