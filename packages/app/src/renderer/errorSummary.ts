/** One line for a folded error row: `错误 · HTTP 429 · Token Plan quota has been exceeded`. */

const MAX_MESSAGE = 80;

function messageOf(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const json = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
    const nested = json.error;
    if (nested && typeof nested === "object") {
      const message = (nested as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
    if (typeof nested === "string" && nested.trim()) return nested;
    if (typeof json.message === "string" && json.message.trim()) return json.message;
  } catch {
    // Not JSON after all: show the text itself.
  }
  return trimmed;
}

export function errorSummary(raw: string): string {
  const text = raw.trim();
  const http = /^HTTP\s+(\d{3})\s*:?\s*([\s\S]*)$/i.exec(text);
  const status = http ? `HTTP ${http[1]}` : "";
  let message = messageOf(http ? http[2] : text)
    // The request id is long and only useful in the expanded text.
    .replace(/\s*\(\s*request[_ ]?id\s*:[^)]*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (message.length > MAX_MESSAGE) message = `${message.slice(0, MAX_MESSAGE)}…`;
  return ["错误", status, message].filter(Boolean).join(" · ");
}
