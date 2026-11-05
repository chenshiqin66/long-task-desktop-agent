import { formatMarkdown } from "../dist/src/renderer/ui.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const heading = formatMarkdown("## 标题\n\n正文");
assert(heading.includes('<h2 class="md-h md-h2">标题</h2>'), "heading h2");
assert(heading.includes('<p class="md-p">正文</p>'), "paragraph after heading");

const table = formatMarkdown(
  "| 公园 | 距离 |\n| --- | --- |\n| **世纪公园** | 8km |\n| 共青森林公园 | 12km |",
);
assert(table.includes('<table class="md-table">'), "table tag");
assert(table.includes("<th>公园</th>"), "table header");
assert(table.includes("<strong>世纪公园</strong>"), "bold in cell");
assert(table.includes("<td>12km</td>"), "table cell");

const trailingPipe = formatMarkdown(
  "| 字段 | 内容 |\n| --- | --- |\n| 公园名称 | 标题 |\n| 地理位置 | 地址 | |",
);
assert((trailingPipe.match(/<th>/g) || []).length === 2, "no blank header col from trailing |");
assert((trailingPipe.match(/<td>/g) || []).length === 4, "body cells match 2 cols");

const h1 = formatMarkdown("# 一级");
assert(h1.includes('<h1 class="md-h md-h1">一级</h1>'), "heading h1");

const list = formatMarkdown(
  "- 首批 7 座（2013 年启动）：廊下、青西\n- 第二批 3 座（2018 年启动）：合庆\n- 2023 年两批全部建成开园",
);
assert(list.includes('<ul class="md-list md-ul">'), "ul list");
assert(list.includes("<li>首批 7 座"), "ul item");
assert(!list.includes("- 首批"), "raw dash removed");

const ordered = formatMarkdown("1. 甲\n2. 乙");
assert(ordered.includes('<ol class="md-list md-ol">'), "ol list");
assert(ordered.includes("<li>乙</li>"), "ol item");

const pathLink = formatMarkdown(
  "文件位置：/mnt/c/Users/陈仕勤/Desktop/temp-20261029/shanghai-country-parks.html；双击即可",
);
assert(pathLink.includes('class="md-link"'), "path autolink");
const openAttr = pathLink.match(/data-open="([^"]+)"/)?.[1] ?? "";
assert(
  openAttr ===
    "/mnt/c/Users/陈仕勤/Desktop/temp-20261029/shanghai-country-parks.html",
  `mnt path data-open got ${openAttr}`,
);
assert(!openAttr.includes("；"), "punct not in href");

const mdUrl = formatMarkdown("见 [文档](https://example.com/a)");
assert(mdUrl.includes('data-open="https://example.com/a"'), "md link");

const citeDash = formatMarkdown(
  "1. [1] WTT赛程 — https://www.example.com/a/path?x=1&y=2",
);
assert(citeDash.includes("[1]"), "cite keeps index");
assert(citeDash.includes(">WTT赛程</a>"), "cite title is link text");
assert(
  citeDash.includes('data-open="https://www.example.com/a/path?x=1&amp;y=2"') ||
    citeDash.includes('data-open="https://www.example.com/a/path?x=1&y=2"'),
  "cite url in data-open",
);
assert(!citeDash.includes(" — https://"), "bare url after dash hidden");
assert(!/>https:\/\/www\.example\.com/.test(citeDash), "url not used as visible label");

const citeMd = formatMarkdown("1. [2] [标题文字](https://news.example.com/z)");
assert(citeMd.includes(">标题文字</a>"), "md cite title");
assert(citeMd.includes('data-open="https://news.example.com/z"'), "md cite href");

const backticked = formatMarkdown(
  "打开 `/mnt/c/Users/陈仕勤/Desktop/temp-20261029/shanghai-country-parks.html` 查看",
);
assert(backticked.includes("md-link"), "backtick path is link");
assert(backticked.includes('data-local="1"'), "absolute path is a local link");

const bareName = formatMarkdown("你打开看一眼 `system-architecture.png`，如果出现方块");
assert(!bareName.includes("md-link"), "bare file name is not a link");
assert(bareName.includes("system-architecture.png"), "bare file name still shown");

const missingRel = formatMarkdown("见 [图](diagrams/system-architecture.png)");
assert(missingRel.includes('data-open="diagrams/system-architecture.png"'), "relative path stays a candidate");
assert(missingRel.includes('data-local="1"'), "relative path is checked locally");

const bareMd = formatMarkdown("见 [图](system-architecture.png)");
assert(!bareMd.includes("md-link"), "markdown bare file name is not a link");
assert(bareMd.includes(">图<") || bareMd.includes("图"), "markdown label kept");
assert(
  backticked.includes(
    'data-open="/mnt/c/Users/陈仕勤/Desktop/temp-20261029/shanghai-country-parks.html"',
  ),
  "backtick path data-open",
);

console.log("markdown headings+tables+lists+links ok");
