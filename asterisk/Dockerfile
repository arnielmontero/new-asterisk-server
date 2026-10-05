# Asterisk 22.11.0 (22.x LTS) built from source on a pinned Debian 12 base.
# Version, source checksum and the Opus binary checksum are all pinned below.

# debian:12.12-slim
ARG DEBIAN_IMAGE=debian@sha256:d5d3f9c23164ea16f31852f95bd5959aad1c5e854332fe00f7b3a20fcc9f635c

# ---------------------------------------------------------------- build stage
FROM ${DEBIAN_IMAGE} AS build

ARG ASTERISK_VERSION=22.11.0
# Matches https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-22-current.sha256
ARG ASTERISK_SHA256=3bd5ee040509a3d3cd9b1ba9520c18e6ec0a7e7981ca68c457dcd36ba3c54d94
# Sangoma binary Opus transcoding module (the in-tree source only passes Opus through).
ARG OPUS_CODEC_VERSION=22.0_1.3.0
ARG OPUS_CODEC_SHA256=889e6b3d7f096c84271e9b10c1a2050382738bd2dda82e1fc76cb1e10472e20d

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl bzip2 patch pkg-config xmlstarlet \
      libssl-dev libxml2-dev libsqlite3-dev uuid-dev libjansson-dev libedit-dev \
      libxslt1-dev libcurl4-openssl-dev libsrtp2-dev libopus-dev libopusfile-dev \
      libspeex-dev libspeexdsp-dev libogg-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src
RUN curl -fsSL -o asterisk.tar.gz \
      "https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-${ASTERISK_VERSION}.tar.gz" \
 && echo "${ASTERISK_SHA256}  asterisk.tar.gz" | sha256sum -c - \
 && tar xzf asterisk.tar.gz \
 && mv "asterisk-${ASTERISK_VERSION}" asterisk

WORKDIR /usr/src/asterisk
# pjproject is downloaded and checksum-verified by Asterisk's own build system.
RUN ./configure --prefix=/usr --libdir=/usr/lib --with-pjproject-bundled \
 && make menuselect.makeopts \
 && menuselect/menuselect \
      --disable BUILD_NATIVE \
      --disable-category MENUSELECT_CORE_SOUNDS \
      --disable-category MENUSELECT_MOH \
      --disable-category MENUSELECT_EXTRA_SOUNDS \
      menuselect.makeopts \
 && make -j"$(nproc)" \
 && make install DESTDIR=/out \
 && rm -rf /out/var/run /out/run

WORKDIR /usr/src
RUN curl -fsSL -o opus.tar.gz \
      "https://downloads.digium.com/pub/telephony/codec_opus/asterisk-22.0/x86-64/codec_opus-${OPUS_CODEC_VERSION}-x86_64.tar.gz" \
 && echo "${OPUS_CODEC_SHA256}  opus.tar.gz" | sha256sum -c - \
 && tar xzf opus.tar.gz \
 && install -m 0755 "codec_opus-${OPUS_CODEC_VERSION}-x86_64/codec_opus.so" /out/usr/lib/asterisk/modules/ \
 && install -m 0755 "codec_opus-${OPUS_CODEC_VERSION}-x86_64/format_ogg_opus.so" /out/usr/lib/asterisk/modules/ \
 && install -d /out/var/lib/asterisk/documentation/thirdparty/codec_opus \
 && install -m 0644 "codec_opus-${OPUS_CODEC_VERSION}-x86_64/codec_opus_config-en_US.xml" /out/var/lib/asterisk/documentation/thirdparty/ \
 && install -m 0644 "codec_opus-${OPUS_CODEC_VERSION}-x86_64/LICENSE" "codec_opus-${OPUS_CODEC_VERSION}-x86_64/README" /out/var/lib/asterisk/documentation/thirdparty/codec_opus/

# ------------------------------------------------------------- runtime stage
FROM ${DEBIAN_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates gettext-base libssl3 libxml2 libsqlite3-0 libuuid1 \
      libjansson4 libedit2 libxslt1.1 libcurl4 libsrtp2-1 libopus0 \
      libopusfile0 libspeex1 libspeexdsp1 libogg0 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 asterisk \
 && useradd --system --uid 10001 --gid asterisk --home-dir /var/lib/asterisk \
      --shell /usr/sbin/nologin asterisk

COPY --from=build /out/ /
# /var/lib/asterisk is a persistent volume, so keep an image copy of the XML
# documentation (core + third-party Opus) that the entrypoint refreshes on start.
RUN cp -a /var/lib/asterisk/documentation /usr/share/asterisk-documentation \
 && ldconfig \
 && mkdir -p /var/lib/asterisk /var/log/asterisk /var/spool/asterisk /run/asterisk \
 && chown -R asterisk:asterisk /var/lib/asterisk /var/log/asterisk /var/spool/asterisk /run/asterisk

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY healthcheck.sh /usr/local/bin/healthcheck.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh /usr/local/bin/healthcheck.sh

# SIP UDP 5060, AMI 5038, HTTP/WS 8088, RTP range from rtp.conf (host networking).
EXPOSE 5060/udp 5038/tcp 8088/tcp

# The entrypoint starts as root only to render config and fix ownership, then
# drops to the unprivileged asterisk user before launching the daemon.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
