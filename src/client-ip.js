export function getClientIp(headers) {
  return (
    headers.get("cf-connecting-ip") ||
    headers.get("true-client-ip") ||
    splitFirst(headers.get("x-forwarded-for")) ||
    headers.get("x-real-ip") ||
    ""
  );
}

function splitFirst(value) {
  if (!value) return "";
  return value.split(",")[0].trim();
}
