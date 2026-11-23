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

export type MediaNoteSource = "user" | "assistant" | "other";

/**
 * Turn stored image / video / audio references into chat content parts.
 * Only the latest **user** message may keep image/video bytes. Older media and
 * all audios become path notes on the outbound copy. Disk messages are not rewritten.
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
    const audios = message.audios ?? [];
    if (!images.length && !videos.length && !audios.length) {
      out.push(withoutMedia(message));
      sentImages.push([]);
      continue;
    }
    const text = typeof message.content === "string" ? message.content.trim() : "";
    const source = mediaNoteSource(message.role);
    const inlineHere = i === liveAt && message.role === "user" && (images.length > 0 || videos.length > 0);
    if (!inlineHere) {
      const notes = [
        images.length ? imageOmissionNote(images.map((row) => row.path), source) : "",
        videos.length ? videoOmissionNote(videos.map((row) => row.path), source) : "",
        audios.length ? audioOmissionNote(audios.map((row) => row.path), source) : "",
      ].filter(Boolean);
      const note = notes.join("\n");
      out.push({ ...withoutMedia(message), content: text ? `${text}\n${note}` : note });
      sentImages.push([]);
      continue;
    }
    const fallback = mediaFallbackCaption(images.length > 0, videos.length > 0, audios.length > 0);
    const parts: Exclude<OutboundContent, string> = [];
    const sent: SentImage[] = [];
    const leadNotes = [
      audios.length ? audioOmissionNote(audios.map((row) => row.path), source) : "",
    ].filter(Boolean);
    const lead = [text || (images.length || videos.length ? fallback : ""), ...leadNotes]
      .filter(Boolean)
      .join("\n");
    parts.push({ type: "text", text: lead || fallback });
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
    out.push({ ...withoutMedia(message), content: parts.length > 1 ? parts : lead || fallback });
    sentImages.push(sent);
  }
  return { messages: out, sentImages };
}

function mediaNoteSource(role: string): MediaNoteSource {
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  return "other";
}

function withoutMedia(message: AssembledMessage): AssembledMessage {
  const { images: _images, videos: _videos, audios: _audios, ...rest } = message;
  return rest;
}

function mediaFallbackCaption(hasImages: boolean, hasVideos: boolean, hasAudios = false): string {
  if (hasImages && hasVideos) return "请看附件。";
  if (hasVideos) return "请看视频。";
  if (hasImages) return "请看图片。";
  if (hasAudios) return "请看音频附件。";
  return "请看附件。";
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

function pathList(paths: string[]): string {
  return paths.filter(Boolean).join("、");
}

function whoLabel(source: MediaNoteSource): string {
  if (source === "assistant") return "助手生成";
  if (source === "user") return "附件";
  return "消息中的";
}

/** Path stub for chat outbound — never includes pixels. */
export function imageOmissionNote(paths: string[], source: MediaNoteSource = "user"): string {
  const list = pathList(paths);
  if (!list) return `（${whoLabel(source)}图片，未再次发送像素。）`;
  return `（${whoLabel(source)}图片，未再次发送像素：${list}）`;
}

export function videoOmissionNote(paths: string[], source: MediaNoteSource = "user"): string {
  const list = pathList(paths);
  if (!list) return `（${whoLabel(source)}视频，未再次发送文件。）`;
  return `（${whoLabel(source)}视频，未再次发送文件：${list}）`;
}

export function audioOmissionNote(paths: string[], source: MediaNoteSource = "user"): string {
  const list = pathList(paths);
  if (!list) return `（${whoLabel(source)}音频，未再次发送文件。）`;
  return `（${whoLabel(source)}音频，未再次发送文件：${list}）`;
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
