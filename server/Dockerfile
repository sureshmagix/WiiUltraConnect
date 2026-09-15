FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY index.mjs ./
USER node
EXPOSE 8787
CMD ["npm", "start"]
