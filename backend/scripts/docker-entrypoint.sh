#!/bin/sh
# 从 Docker secrets / 环境变量组装 DATABASE_URL、JWT_SECRET、REDIS_URL 后启动。
# 兼容：明文 env（开发）与 /run/secrets/*（一键部署）。
set -eu

read_secret() {
  path=$1
  fallback=${2:-}
  if [ -n "$path" ] && [ -f "$path" ]; then
    tr -d '\r\n' < "$path" | sed 's/[[:space:]]*$//'
    return 0
  fi
  printf '%s' "$fallback"
}

# ---- DB ----
DB_USER_VAL="${DB_USER:-sccloud_app}"
DB_NAME_VAL="${DB_NAME:-sccloud_v2}"
DB_HOST_VAL="${DB_HOST:-db}"
DB_PORT_VAL="${DB_PORT:-3306}"
DB_PASS_VAL=$(read_secret "${DB_PASS_FILE:-/run/secrets/db_password}" "${DB_PASS:-}")

if [ -z "${DATABASE_URL:-}" ]; then
  if [ -z "$DB_PASS_VAL" ]; then
    echo "docker-entrypoint: DATABASE_URL/DB_PASS missing" >&2
    exit 1
  fi
  DATABASE_URL=$(
    DB_USER_VAL="$DB_USER_VAL" DB_PASS_VAL="$DB_PASS_VAL" \
    DB_HOST_VAL="$DB_HOST_VAL" DB_PORT_VAL="$DB_PORT_VAL" DB_NAME_VAL="$DB_NAME_VAL" \
    python - <<'PY'
import os, urllib.parse
user = os.environ["DB_USER_VAL"]
pw = urllib.parse.quote_plus(os.environ["DB_PASS_VAL"])
host = os.environ["DB_HOST_VAL"]
port = os.environ["DB_PORT_VAL"]
name = os.environ["DB_NAME_VAL"]
print(f"mysql+pymysql://{user}:{pw}@{host}:{port}/{name}")
PY
  )
  export DATABASE_URL
fi

# ---- JWT ----
JWT_VAL=$(read_secret "${JWT_SECRET_FILE:-/run/secrets/jwt_secret}" "${JWT_SECRET:-}")
if [ -n "$JWT_VAL" ]; then
  export JWT_SECRET="$JWT_VAL"
fi
if [ -z "${JWT_SECRET:-}" ] || [ "$JWT_SECRET" = "CHANGE_ME" ]; then
  echo "docker-entrypoint: JWT_SECRET missing or placeholder" >&2
  exit 1
fi

# ---- Redis ----
REDIS_HOST_VAL="${REDIS_HOST:-redis}"
REDIS_PORT_VAL="${REDIS_PORT:-6379}"
REDIS_DB_VAL="${REDIS_DB:-0}"
REDIS_PASS_VAL=$(read_secret "${REDIS_PASSWORD_FILE:-/run/secrets/redis_password}" "${REDIS_PASSWORD:-}")
if [ -z "${REDIS_URL:-}" ]; then
  if [ -n "$REDIS_PASS_VAL" ]; then
    REDIS_PASS_ENC=$(
      REDIS_PASS_VAL="$REDIS_PASS_VAL" python - <<'PY'
import os, urllib.parse
print(urllib.parse.quote_plus(os.environ["REDIS_PASS_VAL"]))
PY
    )
    export REDIS_URL="redis://:${REDIS_PASS_ENC}@${REDIS_HOST_VAL}:${REDIS_PORT_VAL}/${REDIS_DB_VAL}"
  else
    export REDIS_URL="redis://${REDIS_HOST_VAL}:${REDIS_PORT_VAL}/${REDIS_DB_VAL}"
  fi
fi

# ---- Bootstrap admin password (optional secret) ----
BOOT_PASS=$(read_secret "${BOOTSTRAP_ADMIN_PASSWORD_FILE:-/run/secrets/bootstrap_admin_password}" "${BOOTSTRAP_ADMIN_PASSWORD:-}")
if [ -n "$BOOT_PASS" ]; then
  export BOOTSTRAP_ADMIN_PASSWORD="$BOOT_PASS"
fi

# 项目数据目录可写（named volume 首次可能是 root）
PROJECTS_ROOT_VAL="${PROJECTS_ROOT:-/data/projects}"
if [ "$(id -u)" = "0" ]; then
  if [ -d "$PROJECTS_ROOT_VAL" ]; then
    chown -R 10001:10001 "$PROJECTS_ROOT_VAL" 2>/dev/null || chmod 777 "$PROJECTS_ROOT_VAL" 2>/dev/null || true
  fi
  # drop to app user when possible
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid=10001 --regid=10001 --clear-groups -- "$@"
  fi
  if command -v runuser >/dev/null 2>&1; then
    exec runuser -u app -- "$@"
  fi
fi

exec "$@"
