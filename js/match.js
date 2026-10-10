// Vibe Pare — Matching logic

const FALLBACK_SECONDS = 15;

const user = JSON.parse(localStorage.getItem('vibepare_user') || 'null');
if (!user) {
  window.location.href = 'index.html';
}

const statusEl = document.getElementById('matchStatus');
const hintEl = document.getElementById('matchHint');
let matchFound = false;
let fallbackActive = false;

async function tryMatch(allowSameGender) {
  if (matchFound) return;

  let genderFilter;
  if (!allowSameGender) {
    if (user.gender === 'male') genderFilter = [ 'female', 'other' ];
    else if (user.gender === 'female') genderFilter = [ 'male', 'other' ];
    else genderFilter = [ 'male', 'female' ];
  } else {
    genderFilter = [ 'male', 'female', 'other' ];
  }

  const { data: candidates, error } = await supabaseClient
    .from('waiting_queue')
    .select('*')
    .eq('country', user.country)
    .neq('session_id', user.sessionId)
    .in('gender', genderFilter)
    .order('joined_at', { ascending: true })
    .limit(5);

  if (error) { console.error(error); return; }
  if (!candidates || candidates.length === 0) return;

  const { data: blocks } = await supabaseClient
    .from('blocks')
    .select('blocked_session')
    .eq('blocker_session', user.sessionId);

  const blockedList = (blocks || []).map(b => b.blocked_session);
  const partner = candidates.find(c => !blockedList.includes(c.session_id));
  if (!partner) return;

  matchFound = true;
  statusEl.textContent = 'Match found! Connecting...';

  const matchType =
    (user.gender === 'other' || partner.gender === 'other' || user.gender !== partner.gender)
      ? 'opposite' : 'same';

  const { data: room, error: roomErr } = await supabaseClient
    .from('rooms')
    .insert({
      user_a_session: user.sessionId,
      user_b_session: partner.session_id,
      user_a_name: user.name,
      user_b_name: partner.name,
      user_a_gender: user.gender,
      user_b_gender: partner.gender,
      country: user.country,
      match_type: matchType,
      status: 'active'
    })
    .select()
    .single();

  if (roomErr) { console.error(roomErr); matchFound = false; return; }

  await supabaseClient
    .from('waiting_queue')
    .delete()
    .in('session_id', [ user.sessionId, partner.session_id ]);

  localStorage.setItem('vibepare_room', room.id);
  window.location.href = 'chat.html';
}

setTimeout(() => {
  if (matchFound) return;
  fallbackActive = true;
  statusEl.textContent = 'Still searching... broadening your match';
  hintEl.textContent = 'Hang tight, we\'re widening the search';
  tryMatch(true);
}, FALLBACK_SECONDS * 1000);

const pollInterval = setInterval(() => {
  tryMatch(fallbackActive);
}, 2000);

tryMatch(false);

document.getElementById('cancelBtn').addEventListener('click', async () => {
  clearInterval(pollInterval);
  await supabaseClient.from('waiting_queue').delete().eq('session_id', user.sessionId);
  localStorage.removeItem('vibepare_user');
  window.location.href = 'index.html';
});
