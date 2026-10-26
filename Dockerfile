FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    ROLEMEM_DB=/data/rolemem.db

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY web ./web

VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
