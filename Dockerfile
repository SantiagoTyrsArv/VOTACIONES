FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY shared/package.json ./shared/package.json
COPY server/package.json ./server/package.json
COPY publico/package.json ./publico/package.json
COPY carga/package.json ./carga/package.json
COPY jurado/package.json ./jurado/package.json
COPY herramientas/package.json ./herramientas/package.json
RUN npm ci --ignore-scripts
COPY . .
RUN npm run typecheck && npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/shared/package.json ./shared/package.json
COPY --from=build --chown=node:node /app/shared/dist ./shared/dist
COPY --from=build --chown=node:node /app/publico/dist ./publico/dist
COPY --from=build --chown=node:node /app/jurado/dist ./jurado/dist
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/web-dist ./web-dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/main.js"]
