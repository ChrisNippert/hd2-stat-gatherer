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
