# The ffmpeg the desktop app ships, built from source with our patches.
#
# Why not the gyan.dev build any more: its WHIP muxer refuses every NACK
# LiveKit sends (patches/0001), so on the AMD and Intel path a lost packet is
# never retransmitted and viewers sit on a broken picture until the next
# keyframe. Upstream has the same code; a binary off the shelf cannot fix it.
#
# Cross-compiled for win64 with mingw-w64, statically, so the result is one
# ffmpeg.exe with no DLLs beside it — what vendor/ffmpeg-gnutls.exe has always
# been. Only what the app uses is enabled (see src/main/encoder.ts):
#
#   GnuTLS      WHIP's DTLS-SRTP. SChannel cannot do use_srtp (ffmpeg.json)
#   AMF         h264_amf, Radeon
#   libvpl      h264_qsv, Intel
#   nvenc       h264_nvenc, the screen path on NVIDIA (ddagrab)
#   libx264     the CPU fallback for an unknown adapter
#   libopus     the audio WHIP sends
#   d3d11va     ddagrab and hwdownload
#
# Build with build.sh next to this file; it leaves the binary at
# vendor/ffmpeg-gnutls.exe.

FROM ubuntu:24.04 AS build

ARG FFMPEG_VERSION=9.0.2
ARG GMP_VERSION=6.3.0
ARG NETTLE_VERSION=3.10.2
ARG GNUTLS_VERSION=3.8.13
ARG OPUS_VERSION=1.5.2
ARG VPL_VERSION=2.17.0
ARG AMF_VERSION=1.5.3
ARG NVCODEC_VERSION=13.0.19.0

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils bzip2 make m4 nasm pkg-config patch \
      autoconf automake libtool cmake ninja-build python3 git \
      gcc-mingw-w64-x86-64-posix g++-mingw-w64-x86-64-posix \
      binutils-mingw-w64-x86-64 mingw-w64-x86-64-dev \
    && rm -rf /var/lib/apt/lists/*

# The posix flavour: libvpl is C++ and wants std::thread.
RUN update-alternatives --set x86_64-w64-mingw32-gcc /usr/bin/x86_64-w64-mingw32-gcc-posix \
 && update-alternatives --set x86_64-w64-mingw32-g++ /usr/bin/x86_64-w64-mingw32-g++-posix

ENV HOST=x86_64-w64-mingw32 \
    PREFIX=/opt/w64
ENV PKG_CONFIG_LIBDIR=$PREFIX/lib/pkgconfig \
    PKG_CONFIG_PATH=$PREFIX/lib/pkgconfig \
    CPPFLAGS=-I/opt/w64/include \
    LDFLAGS=-L/opt/w64/lib
WORKDIR /src

# Every download fails the build on a 404 rather than continuing without it.
RUN curl -fsSL https://mirrors.kernel.org/gnu/gmp/gmp-${GMP_VERSION}.tar.xz | tar xJ \
 && cd gmp-${GMP_VERSION} \
 && ./configure --host=$HOST --prefix=$PREFIX --disable-shared --enable-static \
 && make -j"$(nproc)" && make install

RUN curl -fsSL https://mirrors.kernel.org/gnu/nettle/nettle-${NETTLE_VERSION}.tar.gz | tar xz \
 && cd nettle-${NETTLE_VERSION} \
 && ./configure --host=$HOST --prefix=$PREFIX --disable-shared --enable-static \
      --disable-documentation --disable-openssl --libdir=$PREFIX/lib \
 && make -j"$(nproc)" && make install

RUN curl -fsSL https://www.gnupg.org/ftp/gcrypt/gnutls/v3.8/gnutls-${GNUTLS_VERSION}.tar.xz | tar xJ \
 && cd gnutls-${GNUTLS_VERSION} \
 && ./configure --host=$HOST --prefix=$PREFIX --disable-shared --enable-static \
      --with-included-libtasn1 --with-included-unistring --without-p11-kit \
      --without-idn --without-zlib --without-brotli --without-zstd \
      --without-tpm --without-tpm2 --disable-libdane \
      --disable-doc --disable-tests --disable-tools --disable-cxx --disable-nls \
 && make -j"$(nproc)" && make install

RUN curl -fsSL https://downloads.xiph.org/releases/opus/opus-${OPUS_VERSION}.tar.gz | tar xz \
 && cd opus-${OPUS_VERSION} \
 && ./configure --host=$HOST --prefix=$PREFIX --disable-shared --enable-static \
      --disable-doc --disable-extra-programs \
 && make -j"$(nproc)" && make install

RUN curl -fsSL https://code.videolan.org/videolan/x264/-/archive/stable/x264-stable.tar.bz2 | tar xj \
 && cd x264-stable \
 && ./configure --host=$HOST --cross-prefix=$HOST- --prefix=$PREFIX \
      --enable-static --disable-cli \
 && make -j"$(nproc)" && make install

RUN curl -fsSL https://github.com/intel/libvpl/archive/refs/tags/v${VPL_VERSION}.tar.gz | tar xz \
 && cmake -S libvpl-${VPL_VERSION} -B vpl-build -G Ninja \
      -DCMAKE_SYSTEM_NAME=Windows \
      -DCMAKE_C_COMPILER=$HOST-gcc -DCMAKE_CXX_COMPILER=$HOST-g++ \
      -DCMAKE_RC_COMPILER=$HOST-windres \
      -DCMAKE_INSTALL_PREFIX=$PREFIX -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF -DBUILD_TOOLS=OFF -DBUILD_EXAMPLES=OFF \
      -DBUILD_TESTS=OFF -DINSTALL_EXAMPLES=OFF \
 && cmake --build vpl-build && cmake --install vpl-build

# Headers only: both load the vendor's runtime from the driver at run time.
RUN curl -fsSL https://github.com/GPUOpen-LibrariesAndSDKs/AMF/archive/refs/tags/v${AMF_VERSION}.tar.gz | tar xz \
 && mkdir -p $PREFIX/include/AMF \
 && cp -r AMF-${AMF_VERSION}/amf/public/include/* $PREFIX/include/AMF/
RUN curl -fsSL https://github.com/FFmpeg/nv-codec-headers/releases/download/n${NVCODEC_VERSION}/nv-codec-headers-${NVCODEC_VERSION}.tar.gz | tar xz \
 && make -C nv-codec-headers-${NVCODEC_VERSION} PREFIX=$PREFIX install

COPY patches /patches
RUN curl -fsSL https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz | tar xJ \
 && cd ffmpeg-${FFMPEG_VERSION} \
 && for p in /patches/*.patch; do echo "applying $p" && patch -p1 --forward < "$p" || exit 1; done \
 && ./configure \
      --prefix=$PREFIX --arch=x86_64 --target-os=mingw32 --cross-prefix=$HOST- \
      --pkg-config=pkg-config --pkg-config-flags=--static \
      --extra-cflags="-I$PREFIX/include" \
      --extra-ldflags="-L$PREFIX/lib -static -static-libgcc -static-libstdc++" \
      --extra-libs="-lstdc++ -lole32 -luuid -lcrypt32 -lncrypt -lbcrypt -lws2_32 -ladvapi32" \
      --extra-version=zoia \
      --enable-gpl --enable-version3 --enable-static --disable-shared \
      --disable-autodetect --enable-w32threads \
      --enable-gnutls --enable-libopus --enable-libx264 \
      --enable-amf --enable-libvpl --enable-ffnvcodec --enable-nvenc \
      --enable-d3d11va --enable-dxva2 \
      --disable-doc --disable-ffplay --disable-debug \
 && make -j"$(nproc)" \
 && $HOST-strip ffmpeg.exe \
 && mkdir -p /out && cp ffmpeg.exe /out/ffmpeg-gnutls.exe

FROM scratch
COPY --from=build /out/ /
