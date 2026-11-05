import type { AssembledMessage, OutboundContent } from "./assemble.js";

/** An image that was actually inlined into this request. */
export interface SentImage {
  path: string;
  bytes: number;
}

export interface PreparedOutbound {
  messages: AssembledMessage[];
  /** Parallel to `messages`. Empty when that message contributed no pixels. */
  sentImages: SentImage[][];
}

/**
 * Turn stored image references into OpenAI-style content parts.
 * Only the latest user message keeps pixels. Older image messages become a
 * one-line note on the outbound copy. Disk messages are not rewritten.
 * `sentImages` lists only the files whose bytes were inlined.
 */
export async function prepareOutbound(
  messages: AssembledMessage[],
  readImage: (relativePath: string) => Promise<{ dataUrl: string; bytes: number } | null>,
): Promise<PreparedOutbound> {
  const liveAt = liveImageMessageIndex(messages);
  const out: AssembledMessage[] = [];
  const sentImages: SentImage[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (!message.images?.length) {
      const { images: _images, ...rest } = message;
      out.push(rest);
      sentImages.push([]);
      continue;
    }
    const text = typeof message.content === "string" ? message.content.trim() : "";
    if (i !== liveAt) {
      const { images: _images, ...rest } = message;
      const note = imageOmissionNote(message.images.length);
      out.push({ ...rest, content: text ? `${text}\n${note}` : note });
      sentImages.push([]);
      continue;
    }
    const parts: Exclude<OutboundContent, string> = [];
    const sent: SentImage[] = [];
    parts.push({ type: "text", text: text || "请看图片。" });
    for (const image of message.images) {
      const loaded = await readImage(image.path);
      if (!loaded) continue;
      parts.push({ type: "image_url", image_url: { url: loaded.dataUrl } });
      sent.push({ path: image.path, bytes: loaded.bytes });
    }
    const { images: _images, ...rest } = message;
    out.push({ ...rest, content: parts.length > 1 ? parts : text || "请看图片。" });
    sentImages.push(sent);
  }
  return { messages: out, sentImages };
}

export async function materializeImages(
  messages: AssembledMessage[],
  readDataUrl: (relativePath: string) => Promise<string | null>,
): Promise<AssembledMessage[]> {
  const prepared = await prepareOutbound(messages, async (relativePath) => {
    const dataUrl = await readDataUrl(relativePath);
    return dataUrl ? { dataUrl, bytes: 0 } : null;
  });
  return prepared.messages;
}

/** Last user message keeps its pixels only when that message itself has images. */
export function liveImageMessageIndex(messages: AssembledMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    return message.images?.length ? i : -1;
  }
  return -1;
}

export function imageOmissionNote(count: number): string {
  return `（此轮附有 ${count} 张图片，像素未再次发送。）`;
}

export function countOutboundImages(messages: AssembledMessage[]): number {
  let n = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "image_url") n += 1;
    }
  }
  return n;
}

export function outboundTextChars(content: OutboundContent): number {
  if (typeof content === "string") return content.length;
  return content.reduce((n, part) => n + (part.type === "text" ? part.text.length : 0), 0);
}
