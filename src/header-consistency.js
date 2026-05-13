export function parseAcceptLanguage(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim().split(";")[0])
    .filter(Boolean)
    .map(normalizeLanguageTag);
}

export function normalizeBrowserLanguages(languages) {
  if (!Array.isArray(languages)) return [];
  return languages.filter(Boolean).map(normalizeLanguageTag);
}

export function languageListsOverlap(requestLanguages, browserLanguages) {
  return requestLanguages.some((requestLanguage) => {
    const requestBase = requestLanguage.split("-")[0];
    return browserLanguages.some((browserLanguage) => {
      const browserBase = browserLanguage.split("-")[0];
      return requestLanguage === browserLanguage || requestBase === browserBase;
    });
  });
}

export function parseClientHintToken(value) {
  if (!value) return null;
  return String(value).trim().replace(/^"|"$/g, "") || null;
}

export function normalizePlatformLabel(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeLanguageTag(value) {
  return String(value).toLowerCase();
}
