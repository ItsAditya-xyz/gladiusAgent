const UUID_RE = /^[0-9a-fA-F-]{8}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{12}$/;
const POST_UUID_RE = /[0-9a-fA-F-]{36}/;

export const isUuid = (value: string) => UUID_RE.test(value);

export const extractPostIdFromUrl = (urlOrId: string) => {
  const trimmed = (urlOrId || "").trim();
  if (POST_UUID_RE.test(trimmed) && trimmed.length === 36) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(POST_UUID_RE);
    if (match) return match[0];
  } catch {
    const match = trimmed.match(POST_UUID_RE);
    if (match) return match[0];
  }
  return trimmed;
};
