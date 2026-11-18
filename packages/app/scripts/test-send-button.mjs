import assert from "node:assert/strict";
import {
  SEND_ICON_PATH,
  STOP_ICON_PATH,
  sendButtonLabel,
  sendIconKind,
} from "../dist/src/renderer/sendButton.js";

assert.equal(sendButtonLabel("send", true), "发送");
assert.equal(sendButtonLabel("send", false), "发送已禁用");
assert.equal(sendButtonLabel("stop"), "停止");
assert.equal(sendButtonLabel("stopping"), "正在停止");
assert.equal(sendButtonLabel("answer"), "回答");

assert.equal(sendIconKind("send"), "send");
assert.equal(sendIconKind("stop"), "stop");
assert.equal(sendIconKind("stopping"), "stop");
assert.equal(sendIconKind("answer"), null);

assert.match(SEND_ICON_PATH, /M512 0a512 512/);
assert.match(STOP_ICON_PATH, /48\.006035-48\.006034h-255/);

console.log("sendButton tests ok");
