# hub 多阶段镜像。构建层 golang:1.25-alpine，CGO 关死
# （glebarez/sqlite 纯 Go，交叉/静态构建无坑）。
# 运行层选 alpine 而非 distroless：busybox 自带 wget，容器 HEALTHCHECK 才能
# 探 /healthz；且留 shell 便于线上排障。体积差 <10MB，可接受。
FROM golang:1.25-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build ./... \
 && CGO_ENABLED=0 go build -ldflags="-s -w" -o /hub ./cmd/hub

FROM alpine:3.22
RUN addgroup -S hub && adduser -S -u 10001 -G hub hub \
 && mkdir -p /data/updates \
 && chown -R hub:hub /data
COPY --from=builder /hub /hub
USER hub
WORKDIR /data
EXPOSE 10440
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:10440/healthz || exit 1
ENTRYPOINT ["/hub"]
