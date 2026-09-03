FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc default-libmysqlclient-dev pkg-config curl util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /app --shell /usr/sbin/nologin app

COPY . .
RUN pip install --no-cache-dir -e . \
    && chmod +x /app/scripts/docker-entrypoint.sh \
    && mkdir -p /data/projects \
    && chown -R app:app /app /data/projects

# 入口需短暂 root 以修正 volume 权限，随后 drop 到 app（见 entrypoint）
# 生产 compose 仍 cap_drop + no-new-privileges
USER app

EXPOSE 8000

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["sh", "-c", "alembic upgrade head || true; exec uvicorn app.main:app --host 0.0.0.0 --port 8000"]
