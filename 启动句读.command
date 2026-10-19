#!/bin/zsh
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请安装 Node.js 22 或更新版本后再启动句读。"
  read -r "?按回车关闭窗口…"
  exit 1
fi
node server.mjs --open
if [ $? -ne 0 ]; then
  read -r "?按回车关闭窗口…"
fi
