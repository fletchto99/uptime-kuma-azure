FROM louislam/uptime-kuma:2.5.11@sha256:7554dba313c84e44fee921ef3b5626ba1c711e412e82815e8c957517026112a9
COPY runtime/health.cjs /app/server/managed-health.js
COPY scripts/patch-managed-hosting.cjs /tmp/patch-managed-hosting.cjs
RUN node /tmp/patch-managed-hosting.cjs && rm /tmp/patch-managed-hosting.cjs
LABEL org.opencontainers.image.source="https://github.com/fletchto99/uptime-kuma-azure"
HEALTHCHECK --interval=60s --timeout=5s --start-period=180s --retries=3 CMD node -e "fetch('http://127.0.0.1:3001/healthz',{signal:AbortSignal.timeout(3000)}).then(async r=>process.exit(r.status===200&&(await r.json()).status==='ok'?0:1)).catch(()=>process.exit(1))"
