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
 * Turn stored image and video references into chat content parts.
 * Only the latest user message keeps media bytes. Older media messages become
 * a one-line note on the outbound copy. Disk messages are not rewritten.
 * `sentImages` lists only the image files whose bytes were inlined.
 */
export async function prepareOutbound(
  messages: AssembledMessage[],
  readImage: (relativePath: string) => Promise<{ dataUrl: string; bytes: number } | null>,
  readVideo?: (relativePath: string) => Promise<{ dataUrl: string; bytes: number } | null>,
): Promise<PreparedOutbound> {
  const liveAt = liveMediaMessageIndex(messages);
  const out: AssembledMessage[] = [];
  const sentImages: SentImage[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const images = message.images ?? [];
    const videos = message.videos ?? [];
    if (!images.length && !videos.length) {
      out.push(withoutMedia(message));
      sentImages.push([]);
      continue;
    }
    const text = typeof message.content === "string" ? message.content.trim() : "";
    if (i !== liveAt) {
      const notes = [
        images.length ? imageOmissionNote(images.length) : "",
        videos.length ? videoOmissionNote(videos.length) : "",
      ].filter(Boolean);
      const note = notes.join("\n");
      out.push({ ...withoutMedia(message), content: text ? `${text}\n${note}` : note });
      sentImages.push([]);
      continue;
    }
    const fallback = mediaFallbackCaption(images.length > 0, videos.length > 0);
    const parts: Exclude<OutboundContent, string> = [];
    const sent: SentImage[] = [];
    parts.push({ type: "text", text: text || fallback });
    for (const image of images) {
      const loaded = await readImage(image.path);
      if (!loaded) continue;
      parts.push({ type: "image_url", image_url: { url: loaded.dataUrl } });
      sent.push({ path: image.path, bytes: loaded.bytes });
    }
    for (const video of videos) {
      const loaded = readVideo ? await readVideo(video.path) : null;
      if (!loaded) continue;
      parts.push({ type: "video_url", video_url: { url: loaded.dataUrl } });
    }
    out.push({ ...withoutMedia(message), content: parts.length > 1 ? parts : text || fallback });
    sentImages.push(sent);
  }
  return { messages: out, sentImages };
}

function withoutMedia(message: AssembledMessage): AssembledMessage {
  const { images: _images, videos: _videos, ...rest } = message;
  return rest;
}

function mediaFallbackCaption(hasImages: boolean, hasVideos: boolean): string {
  if (hasImages && hasVideos) return "请看附件。";
  if (hasVideos) return "请看视频。";
  return "请看图片。";
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

/** Last user message keeps its media only when that message itself has images or videos. */
export function liveMediaMessageIndex(messages: AssembledMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    return message.images?.length || message.videos?.length ? i : -1;
  }
  return -1;
}

export function imageOmissionNote(count: number): string {
  return `（此轮附有 ${count} 张图片，像素未再次发送。）`;
}

export function videoOmissionNote(count: number): string {
  return `（此轮附有 ${count} 个视频，未再次发送。）`;
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
