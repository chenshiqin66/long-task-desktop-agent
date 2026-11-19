import assert from "node:assert/strict";
import {
  discardStreamPaint,
  flushStreamPaint,
  paintStream,
  resetStreamTarget,
} from "../dist/src/renderer/streamPaint.js";

/** A frame scheduler the test steps by hand, standing in for requestAnimationFrame. */
function harness() {
  const frames = new Map();
  let nextHandle = 1;
  const painted = [];
  const env = {
    requestFrame(callback) {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame(handle) {
      frames.delete(handle);
    },
    render(el, text) {
      painted.push({ el, text });
    },
  };
  const state = { streamBuffer: "", streamingEl: null, streamRaf: 0 };
  const runFrames = () => {
    for (const [handle, callback] of [...frames]) {
      frames.delete(handle);
      callback();
    }
  };
  /** Same order as applyTranscript: grow the buffer, then ask for a paint. */
  const receive = (delta) => {
    state.streamBuffer += delta;
    paintStream(state, env, false);
  };
  return { env, state, painted, frames, runFrames, receive };
}

// deltas inside one frame coalesce into a single paint of the whole buffer
{
  const h = harness();
  h.state.streamingEl = "bubble";
  h.receive("你好，");
  h.receive("世界");
  assert.equal(h.painted.length, 0, "nothing paints before the frame fires");
  assert.equal(h.frames.size, 1, "only one frame is scheduled");
  h.runFrames();
  assert.deepEqual(h.painted, [{ el: "bubble", text: "你好，世界" }]);
  assert.equal(h.state.streamRaf, 0);
}

// regression: the reply ends in the same frame as its last deltas. The tail must still be painted.
{
  const h = harness();
  h.state.streamingEl = "bubble";
  h.receive("说一句就行，或者直接说你的目标，");
  h.runFrames();
  h.receive("我");
  h.receive("就开始");
  assert.equal(h.painted.at(-1).text, "说一句就行，或者直接说你的目标，", "the tail has not been painted yet");

  resetStreamTarget(h.state, h.env, null);
  assert.equal(
    h.painted.at(-1).text,
    "说一句就行，或者直接说你的目标，我就开始",
    "resetting the target must paint the pending tail first",
  );
  assert.equal(h.painted.at(-1).el, "bubble", "the tail goes to the bubble it belongs to");
  assert.equal(h.frames.size, 0, "no stray frame is left behind");
  assert.equal(h.state.streamingEl, null);
  assert.equal(h.state.streamBuffer, "");
}

// discarding is the only path that may drop a pending frame, and it is opt-in
{
  const h = harness();
  h.state.streamingEl = "bubble";
  h.receive("尾巴");
  discardStreamPaint(h.state, h.env);
  assert.equal(h.painted.length, 0);
  assert.equal(h.frames.size, 0);
  assert.equal(h.state.streamRaf, 0);
}

// switching to a new bubble paints the old one in full and does not leak text into the new one
{
  const h = harness();
  h.state.streamingEl = "first";
  h.receive("第一段");
  resetStreamTarget(h.state, h.env, "second");
  assert.deepEqual(h.painted, [{ el: "first", text: "第一段" }]);
  assert.equal(h.state.streamingEl, "second");
  assert.equal(h.state.streamBuffer, "");

  h.receive("第二段");
  h.runFrames();
  assert.deepEqual(h.painted.at(-1), { el: "second", text: "第二段" });
  assert.equal(h.painted.length, 2);
}

// an immediate paint replaces the pending frame instead of painting twice
{
  const h = harness();
  h.state.streamingEl = "bubble";
  h.receive("abc");
  paintStream(h.state, h.env, true);
  assert.equal(h.painted.length, 1);
  assert.equal(h.frames.size, 0);
  h.runFrames();
  assert.equal(h.painted.length, 1, "the cancelled frame must not paint again");
}

// nothing pending means nothing to repaint
{
  const h = harness();
  h.state.streamingEl = "bubble";
  h.receive("abc");
  h.runFrames();
  assert.equal(h.painted.length, 1);
  resetStreamTarget(h.state, h.env, null);
  assert.equal(h.painted.length, 1, "an already painted bubble is not painted again");
}

// no bubble: scheduling and flushing are no-ops
{
  const h = harness();
  paintStream(h.state, h.env, false);
  paintStream(h.state, h.env, true);
  flushStreamPaint(h.state, h.env);
  assert.equal(h.painted.length, 0);
  assert.equal(h.frames.size, 0);
}

// the bubble can vanish before the frame fires
{
  const h = harness();
  h.state.streamingEl = "bubble";
  h.receive("abc");
  h.state.streamingEl = null;
  h.runFrames();
  assert.equal(h.painted.length, 0);
  assert.equal(h.state.streamRaf, 0);
}

console.log("streamPaint tests ok");
