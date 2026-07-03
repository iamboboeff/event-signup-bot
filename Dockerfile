FROM node:22-slim

WORKDIR /app

# Сначала зависимости — кэшируется между сборками.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
# Cloud Run сам передаёт PORT; локально по умолчанию 8080.
EXPOSE 8080

CMD ["node", "bot.js"]
