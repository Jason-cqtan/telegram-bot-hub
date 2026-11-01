#!/usr/bin/env bash
# 在本机运行：把代码同步到 VPS 并重启服务。首次运行会安装 Node.js、创建用户和 systemd 服务，
# 并在 Caddy 中加入后台域名（不改动 Caddyfile 里已有的站点）。
#   deploy/deploy.sh                 # 默认 ssh hk、bot.mdyrbz.com
#   SSH_TARGET=x DOMAIN=y deploy/deploy.sh
set -euo pipefail

SSH_TARGET=${SSH_TARGET:-hk}
DOMAIN=${DOMAIN:-bot.mdyrbz.com}
NODE_VERSION=${NODE_VERSION:-v24.22.2}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

node --test >/dev/null
echo "本地测试通过"

ssh "$SSH_TARGET" 'bash -s' <<REMOTE
set -euo pipefail
id tgbot >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin tgbot
mkdir -p /opt/telegram-bot-hub/app
if [ "\$(/opt/telegram-bot-hub/node/bin/node --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  echo "安装 Node.js $NODE_VERSION"
  work=\$(mktemp -d)
  file=node-$NODE_VERSION-linux-x64.tar.xz
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/\$file" -o "\$work/\$file"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | grep " \$file\\\$" > "\$work/sum"
  (cd "\$work" && sha256sum -c sum)
  rm -rf /opt/telegram-bot-hub/node.new
  mkdir /opt/telegram-bot-hub/node.new
  tar -xJf "\$work/\$file" -C /opt/telegram-bot-hub/node.new --strip-components=1
  rm -rf /opt/telegram-bot-hub/node
  mv /opt/telegram-bot-hub/node.new /opt/telegram-bot-hub/node
  rm -rf "\$work"
fi
REMOTE

rsync -az --delete --chmod=D755,F644 --exclude '.git' --exclude '.claude' --exclude 'data' --exclude 'node_modules' ./ "$SSH_TARGET:/opt/telegram-bot-hub/app/"

ssh "$SSH_TARGET" 'bash -s' <<REMOTE
set -euo pipefail
install -m 644 /opt/telegram-bot-hub/app/deploy/telegram-bot-hub.service /etc/systemd/system/telegram-bot-hub.service
install -m 755 /opt/telegram-bot-hub/app/deploy/tg-bot-hub /usr/local/bin/tg-bot-hub
systemctl daemon-reload
systemctl enable --quiet telegram-bot-hub
systemctl restart telegram-bot-hub

# 只在域名还没配置时追加站点；验证失败则恢复，避免影响已有站点。
if ! grep -q "^$DOMAIN {" /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-before-bot-hub
  cat >> /etc/caddy/Caddyfile <<'CADDY'

$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8090
}
CADDY
  if caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    systemctl reload caddy
    echo "Caddy 已加入 $DOMAIN"
  else
    cp /etc/caddy/Caddyfile.bak-before-bot-hub /etc/caddy/Caddyfile
    echo "Caddy 配置校验失败，已恢复原文件" >&2
    exit 1
  fi
fi

for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -fsS -o /dev/null http://127.0.0.1:8090/ && break
  sleep 1
done
curl -fsS -o /dev/null http://127.0.0.1:8090/
systemctl is-active telegram-bot-hub
REMOTE
echo "部署完成：https://$DOMAIN"
