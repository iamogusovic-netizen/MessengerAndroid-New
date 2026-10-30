FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 MESSENGER_DATA_DIR=/data
WORKDIR /app
COPY backend/package.json ./backend/package.json
RUN npm install --omit=dev --prefix backend && npm cache clean --force
COPY backend/server.js ./backend/server.js
COPY frontend ./frontend
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "backend/server.js"]
