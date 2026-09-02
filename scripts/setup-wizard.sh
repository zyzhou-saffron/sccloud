#!/bin/sh
# 首次启动：从 .env.example 生成 .env，并填入随机 DB/JWT 密钥。
# 已存在的 .env 不会被覆盖（仅补缺失关键键可选，当前策略：完整文件已存在则跳过）。
# 不使用 set -e；使用 set -u。

set -u

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

DEFAULT_ADMIN_USER="admin"
DEFAULT_ADMIN_PASSWORD="admin123"

color() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
info()  { printf '%s %s\n' "$(color '1;36' '•')" "$*"; }
ok()    { printf '%s %s\n' "$(color '1;32' '✓')" "$*"; }
warn()  { printf '%s %s\n' "$(color '1;33' '!')" "$*" >&2; }
die()   { printf '%s %s\n' "$(color '1;31' '✗')" "$*" >&2; exit 1; }

if ! command -v openssl >/dev/null 2>&1 && ! command -v head >/dev/null 2>&1; then
  die "需要 openssl 或 head 以生成随机密钥"
fi

gen_hex() {
  bytes=${1:-32}
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes" 2>/dev/null
  else
    head -c "$bytes" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

gen_alnum() {
  bytes=${1:-24}
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$bytes" 2>/dev/null | tr -d '\n/+' | tr -d '=' | cut -c1-32
  else
    head -c "$bytes" /dev/urandom | base64 | tr -d '\n/+' | tr -d '=' | cut -c1-32
  fi
}

if [ -f .env ]; then
  ok ".env 已存在，跳过生成"
else
  if [ ! -f .env.example ]; then
    die "缺少 .env.example"
  fi
  cp .env.example .env
  ok "已从 .env.example 创建 .env"

  DB_PASS=$(gen_alnum 24)
  DB_ROOT_PASS=$(gen_alnum 24)
  JWT_SECRET=$(gen_hex 32)

  # 替换占位符（兼容 GNU/BSD sed：写临时文件）
  sed \
    -e "s/^DB_PASS=.*/DB_PASS=${DB_PASS}/" \
    -e "s/^DB_ROOT_PASS=.*/DB_ROOT_PASS=${DB_ROOT_PASS}/" \
    -e "s/^JWT_SECRET=.*/JWT_SECRET=${JWT_SECRET}/" \
    -e "s/^BOOTSTRAP_ADMIN_USER=.*/BOOTSTRAP_ADMIN_USER=${DEFAULT_ADMIN_USER}/" \
    -e "s/^BOOTSTRAP_ADMIN_PASSWORD=.*/BOOTSTRAP_ADMIN_PASSWORD=${DEFAULT_ADMIN_PASSWORD}/" \
    .env > .env.tmp && mv .env.tmp .env

  chmod 600 .env 2>/dev/null || true
  ok "已写入随机 DB_PASS / DB_ROOT_PASS / JWT_SECRET"
fi

mkdir -p ./data/initdb.d ./data/projects 2>/dev/null || true

cat <<EOF

$(ok "初始化完成")

默认管理员（空库首次启动由 backend bootstrap）：
  用户：${DEFAULT_ADMIN_USER}
  密码：${DEFAULT_ADMIN_PASSWORD}

$(warn "请尽快登录后修改密码")

下一步：
  sh ./start.sh

EOF
