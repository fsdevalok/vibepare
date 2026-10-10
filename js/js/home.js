// Vibe Pare — Home screen logic

// ---------- COUNTRY DROPDOWN ----------
const countrySelect = document.getElementById('countryInput');
COUNTRIES.forEach(c => {
  const opt = document.createElement('option');
  opt.value = c;
  opt.textContent = c;
  countrySelect.appendChild(opt);
});

// ---------- SESSION ID ----------
function getSessionId() {
  let sid = sessionStorage.getItem('vibepare_session');
  if (!sid) {
    sid = 'sess_' + Math.random().toString(36).slice(2) + Date.now();
    sessionStorage.setItem('vibepare_session', sid);
  }
  return sid;
}

// ---------- FORM SUBMIT ----------
const joinForm = document.getElementById('joinForm');
const statusMsg = document.getElementById('statusMsg');

joinForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const name = document.getElementById('nameInput').value.trim();
  const country = countrySelect.value;
  const genderEl = document.querySelector('input[name="gender"]:checked');
  const ageOk = document.getElementById('ageConfirm').checked;

  if (!name || !country || !genderEl) {
    statusMsg.textContent = 'Please fill all fields.';
    return;
  }
  if (!ageOk) {
    statusMsg.textContent = 'You must confirm you are 18+ to continue.';
    return;
  }

  const gender = genderEl.value;
  const sessionId = getSessionId();

  statusMsg.textContent = 'Connecting...';

  localStorage.setItem('vibepare_user', JSON.stringify({
    sessionId, name, country, gender
  }));

  const { error } = await supabaseClient
    .from('waiting_queue')
    .upsert({
      session_id: sessionId,
      name: name,
      country: country,
      gender: gender,
      joined_at: new Date().toISOString()
    }, { onConflict: 'session_id' });

  if (error) {
    console.error(error);
    statusMsg.textContent = 'Error: ' + error.message;
    return;
  }

  statusMsg.textContent = 'Finding a match...';
  window.location.href = 'match.html';
});