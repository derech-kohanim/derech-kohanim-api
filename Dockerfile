# Build context is the project root, because the shared contract sits in a sibling
# repository (see docker-compose.yml).
FROM node:22-alpine AS build
WORKDIR /app

# Networks that inspect TLS present a certificate chain Node does not trust, and the
# failure looks like an outage at the upstream package host. Any .crt dropped into
# derech-kohanim-api/certs is trusted here. See certs/README.md.
COPY derech-kohanim-api/certs/ /usr/local/share/ca-certificates/
RUN apk add --no-cache ca-certificates && update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

COPY derech-kohanim-api/package.json ./derech-kohanim-api/
COPY derech-kohanim-api/prisma ./derech-kohanim-api/prisma
RUN cd derech-kohanim-api && npm install

COPY derech-kohanim-shared ./derech-kohanim-shared
COPY derech-kohanim-api ./derech-kohanim-api

RUN cd derech-kohanim-api && npm run build

FROM node:22-alpine
WORKDIR /app/derech-kohanim-api
ENV NODE_ENV=production

COPY --from=build /usr/local/share/ca-certificates/ /usr/local/share/ca-certificates/
RUN apk add --no-cache ca-certificates && update-ca-certificates

COPY --from=build /app/derech-kohanim-api/package.json ./package.json
COPY --from=build /app/derech-kohanim-api/node_modules ./node_modules
COPY --from=build /app/derech-kohanim-api/prisma ./prisma
COPY --from=build /app/derech-kohanim-api/dist ./dist

EXPOSE 3000
CMD ["npm", "run", "start"]
