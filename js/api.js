const REQUEST_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, options = {}) {
  if (typeof AbortController !== 'function') return fetch(url, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function pingServer(baseUrl) {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/api/health`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

async function parseResponse(res, fallbackMessage) {
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(data?.error || fallbackMessage || `Request failed: ${res.status}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

export async function submitMission(baseUrl, clientId, mission) {
  const res = await fetchWithTimeout(`${baseUrl}/api/missions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, mission }),
  });
  return parseResponse(res, `Submit failed: ${res.status}`);
}

export async function fetchMissions(baseUrl, clientId) {
  const url = clientId
    ? `${baseUrl}/api/missions?clientId=${encodeURIComponent(clientId)}`
    : `${baseUrl}/api/missions`;
  const res = await fetchWithTimeout(url);
  const data = await parseResponse(res, `Fetch failed: ${res.status}`);
  return data.missions;
}

export async function deleteMissionRemote(baseUrl, missionId, clientId) {
  const res = await fetchWithTimeout(`${baseUrl}/api/missions/${encodeURIComponent(missionId)}?clientId=${encodeURIComponent(clientId)}`, { method: 'DELETE' });
  return parseResponse(res, `Delete failed: ${res.status}`);
}

export async function createParty(baseUrl, clientId, mission, displayName = '') {
  const res = await fetchWithTimeout(`${baseUrl}/api/parties`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, mission, displayName }),
  });
  return parseResponse(res, `Create party failed: ${res.status}`);
}

export async function joinParty(baseUrl, code, clientId, displayName = '') {
  const res = await fetchWithTimeout(`${baseUrl}/api/parties/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, clientId, displayName }),
  });
  return parseResponse(res, `Join party failed: ${res.status}`);
}

export async function fetchParty(baseUrl, code, memberToken) {
  const res = await fetchWithTimeout(`${baseUrl}/api/parties/${encodeURIComponent(code)}?memberToken=${encodeURIComponent(memberToken)}`);
  return parseResponse(res, `Fetch party failed: ${res.status}`);
}

export async function updatePartyMission(baseUrl, code, memberToken, missionMeta) {
  const res = await fetchWithTimeout(`${baseUrl}/api/parties/${encodeURIComponent(code)}/mission`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberToken, missionMeta }),
  });
  return parseResponse(res, `Party mission update failed: ${res.status}`);
}

export async function setPartyReady(baseUrl, code, memberToken, ready, mission = null) {
  const res = await fetchWithTimeout(`${baseUrl}/api/parties/${encodeURIComponent(code)}/ready`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberToken, ready, mission }),
  });
  return parseResponse(res, `Party ready update failed: ${res.status}`);
}

export async function kickPartyMember(baseUrl, code, memberToken, targetMemberId) {
  const res = await fetchWithTimeout(`${baseUrl}/api/parties/${encodeURIComponent(code)}/kick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberToken, targetMemberId }),
  });
  return parseResponse(res, `Kick party member failed: ${res.status}`);
}

export async function leaveParty(baseUrl, code, memberToken) {
  const res = await fetchWithTimeout(`${baseUrl}/api/parties/${encodeURIComponent(code)}/leave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberToken }),
  });
  return parseResponse(res, `Leave party failed: ${res.status}`);
}

export async function finalizeParty(baseUrl, code, memberToken, allMinorPlacesCollected, mission) {
  const res = await fetchWithTimeout(`${baseUrl}/api/parties/${encodeURIComponent(code)}/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberToken, allMinorPlacesCollected, mission }),
  });
  return parseResponse(res, `Finalize party failed: ${res.status}`);
}
