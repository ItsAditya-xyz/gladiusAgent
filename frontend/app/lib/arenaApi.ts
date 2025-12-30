const ARENA_BASE_URL = "https://api.starsarena.com";

export const arenaFetch = async (
  path: string,
  options: RequestInit = {}
) => {
  const jwt = process.env.ARENA_JWT || process.env.JWT;
  const headers: HeadersInit = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (jwt) {
    headers.Authorization = `Bearer ${jwt}`;
  }

  const response = await fetch(`${ARENA_BASE_URL}${path}`, {
    ...options,
    headers,
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Arena API error (${response.status}): ${text}`);
  }

  return response.json();
};
