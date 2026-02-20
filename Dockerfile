FROM node:20-alpine

WORKDIR /app

# Copy server files and install dependencies
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --production

# Copy application code
COPY server/index.mjs ./server/
COPY frontend/ ./frontend/

EXPOSE 7777

ENV PORT=7777
ENV NODE_ENV=production

CMD ["node", "server/index.mjs"]
