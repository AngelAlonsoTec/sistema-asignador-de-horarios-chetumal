# Motor genético. Compilación estática contra musl: como no hay dependencias
# externas, `cargo build` no necesita red y la imagen final no necesita ni
# libc — solo los dos binarios.

FROM rust:1-alpine AS constructor

RUN apk add --no-cache musl-dev

WORKDIR /origen
COPY Cargo.toml Cargo.lock ./
COPY src ./src

# Las pruebas corren aquí: una imagen no debería construirse si el motor está
# roto, y son menos de un segundo.
RUN cargo test --release --quiet && cargo build --release

FROM alpine:3.21

RUN adduser -D -u 10001 motor

COPY --from=constructor /origen/target/release/schedulai-engine /usr/local/bin/schedulai-engine
COPY --from=constructor /origen/target/release/salud /usr/local/bin/salud

USER motor
ENV PUERTO=7000
EXPOSE 7000

ENTRYPOINT ["/usr/local/bin/schedulai-engine"]
