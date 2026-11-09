import { questionTitle } from "../dist/src/renderer/questionNav.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(questionTitle("一二三四五六七八九十甲乙").label === "一二三四五六七八九十甲乙", "12 chars stay whole");
assert(questionTitle("一二三四五六七八九十甲乙").label.endsWith("...") === false, "exact 12 has no dots");

const longer = questionTitle("一二三四五六七八九十甲乙丙");
assert(longer.label === "一二三四五六七八九十甲乙...", `truncate with three dots, got ${longer.label}`);
assert(longer.full === "一二三四五六七八九十甲乙丙", "full text kept");

const wrapped = questionTitle("  第一行\n第二行还要更长一些  ");
assert(wrapped.label === "第一行 第二行还要更长一...", `collapse whitespace, got ${wrapped.label}`);

assert(questionTitle("").label === "", "empty stays empty");
assert(questionTitle("短句").label === "短句", "short text is unchanged");

const emoji = questionTitle("👍🏻👍🏻👍🏻👍🏻👍🏻👍🏻好问题要继续写");
assert(emoji.label.startsWith("👍🏻"), "emoji counts as one grapheme");
assert([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(emoji.label.replace(/\.\.\.$/, ""))].length === 12, "limit is 12 graphemes");

console.log("question nav title ok");
