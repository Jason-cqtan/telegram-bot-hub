FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund
COPY src ./src
COPY test ./test
COPY config ./config
COPY public ./public
RUN npm test && mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production TZ=Asia/Shanghai DATA_DIR=/app/data CONFIG_PATH=/app/config/config.json ADMIN_HOST=0.0.0.0 ADMIN_PORT=8080
EXPOSE 8080
USER node
ENTRYPOINT ["node", "src/cli.js"]
CMD ["start"]
