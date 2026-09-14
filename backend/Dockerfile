# API de datos. Sin `npm install`: el backend no tiene dependencias, así que la
# imagen es el runtime de Node más seis archivos.

FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY test ./test
# Migraciones y siembra: hacen falta dentro del contenedor para poder correrlas
# contra el volumen de datos.
COPY herramientas ./herramientas

RUN node --test test/*.test.js

# Los datos llegan por volumen (ver docker-compose.yml); esta carpeta solo
# existe para que el servidor arranque aunque se corra la imagen suelta.
RUN mkdir -p /datos && chown node:node /datos

USER node
ENV PUERTO=4000 DATOS_DIR=/datos MOTOR_URL=http://engine:7000
EXPOSE 4000

CMD ["node", "src/server.js"]
