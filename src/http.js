export const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

export async function readJsonBody(request, maxBytes) {
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new Error(`Request body too large. Max ${maxBytes} bytes.`);
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("Invalid JSON body");
  }
}

export function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...headers }
  });
}
