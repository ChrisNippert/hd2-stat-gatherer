export async function pingServer(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function submitMission(baseUrl, clientId, mission) {
  const res = await fetch(`${baseUrl}/api/missions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, mission }),
  });
  if (!res.ok) throw new Error(`Submit failed: ${res.status}`);
  return res.json();
}

export async function fetchMissions(baseUrl, clientId) {
  const url = clientId
    ? `${baseUrl}/api/missions?clientId=${encodeURIComponent(clientId)}`
    : `${baseUrl}/api/missions`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const data = await res.json();
  return data.missions;
}

export async function deleteMissionRemote(baseUrl, missionId, clientId) {
  const res = await fetch(`${baseUrl}/api/missions/${encodeURIComponent(missionId)}?clientId=${encodeURIComponent(clientId)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
  return res.json();
}

export async function submitDenomCount(baseUrl, clientId, itemId, denom, count) {
  const res = await fetch(`${baseUrl}/api/denominations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, itemId, denom, count }),
  });
  if (!res.ok) throw new Error(`Submit failed: ${res.status}`);
  return res.json();
}

export async function fetchDenominations(baseUrl, clientId) {
  const url = clientId
    ? `${baseUrl}/api/denominations?clientId=${encodeURIComponent(clientId)}`
    : `${baseUrl}/api/denominations`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const data = await res.json();
  return data.denominations;
}
