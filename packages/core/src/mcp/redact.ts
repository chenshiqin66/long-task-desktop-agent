const SECRET_PARAM = /^(?:key|api_key|apikey|token|access_token|secret|password)$/i;
const SECRET_IN_TEXT = /([?&](?:key|api_key|apikey|token|access_token|secret|password)=)[^&\s#]+/gi;

/** Display form of a URL. Query secrets and userinfo are masked; the path stays. */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.replace(SECRET_IN_TEXT, "$1***");
  }
  if (url.username) url.username = "***";
  if (url.password) url.password = "***";
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_PARAM.test(key)) url.searchParams.set(key, "***");
  }
  return url.toString();
}

/** Mask query secrets and any exact secret the caller still has in memory. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(SECRET_IN_TEXT, "$1***");
  const seen = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < 6 || seen.has(secret)) continue;
    seen.add(secret);
    out = out.split(secret).join("***");
  }
  return out;
}
