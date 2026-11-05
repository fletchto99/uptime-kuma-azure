FROM louislam/uptime-kuma:2.5.9@sha256:e88415a90dd2f7efecdbc18de0490aff292764a3ac471531bf1d0481725591bd
COPY scripts/patch-database-tls.cjs /tmp/patch-database-tls.cjs
RUN node /tmp/patch-database-tls.cjs && rm /tmp/patch-database-tls.cjs
LABEL org.opencontainers.image.source="https://github.com/fletchto99/uptime-kuma-azure"
