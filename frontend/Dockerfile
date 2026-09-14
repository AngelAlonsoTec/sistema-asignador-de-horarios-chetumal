# Interfaz. Se compila con Vite y se sirve como estáticos desde nginx, que
# además reenvía /api al backend: así el navegador ve un solo origen y no hay
# CORS ni URLs de servidor incrustadas en el paquete.

FROM node:22-alpine AS constructor

WORKDIR /origen

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js ./
COPY src ./src
COPY test ./test
# Las pruebas corren en la construcción, igual que en el backend: una imagen no
# debería poder publicarse con la interfaz rota.
RUN npm test
# `public/` lleva el favicon y el logo: Vite los copia tal cual a dist/, y sin
# esta línea nginx no los encuentra y los resuelve al index.html.
COPY public ./public
RUN npm run build

FROM nginx:1.27-alpine

# El entrypoint de la imagen oficial expande las variables de entorno de los
# archivos en templates/ y deja el resultado en conf.d/.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=constructor /origen/dist /usr/share/nginx/html

ENV BACKEND_URL=http://backend:4000
EXPOSE 80
