# @agent/app

Electron 外壳：窗口、IPC 和界面。整体说明见仓库根目录的 [README](../../README.md)。

```bash
# 在仓库根目录
npm install
npm start    # 先构建 @agent/core，再构建并启动本包
```

只改了本包时可以用 `npm start -w @agent/app`，它不会重新构建 core。
