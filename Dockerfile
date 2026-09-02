FROM node:20-slim
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package*.json ./
RUN npm install --production
COPY servers/legal-mcp/package*.json ./servers/legal-mcp/
RUN npm install --production --prefix servers/legal-mcp
COPY servers/saij-mcp/package*.json ./servers/saij-mcp/
RUN npm install --production --prefix servers/saij-mcp
COPY . .
EXPOSE 3000
ENV PORT=3000
CMD ["node", "build/index.js"]