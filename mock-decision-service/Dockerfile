FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js calculator.js scheme.json rates.json ./
CMD ["node", "index.js"]
