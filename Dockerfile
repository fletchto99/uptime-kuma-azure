FROM louislam/uptime-kuma:2.5.9@sha256:e88415a90dd2f7efecdbc18de0490aff292764a3ac471531bf1d0481725591bd
COPY runtime/health.cjs /app/server/managed-health.js
COPY scripts/patch-managed-hosting.cjs /tmp/patch-managed-hosting.cjs
RUN node /tmp/patch-managed-hosting.cjs && rm /tmp/patch-managed-hosting.cjs
LABEL org.opencontainers.image.source="https://github.com/fletchto99/uptime-kuma-azure"
HEALTHCHECK --interval=60s --timeout=5s --start-period=180s --retries=3 CMD node -e "fetch('http://127.0.0.1:3001/healthz',{signal:AbortSignal.timeout(3000)}).then(async r=>process.exit(r.status===200&&(await r.json()).status==='ok'?0:1)).catch(()=>process.exit(1))"
