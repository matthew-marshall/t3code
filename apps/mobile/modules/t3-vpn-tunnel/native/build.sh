#!/usr/bin/env bash
# Builds static OpenSSL + libopenconnect (with the GlobalProtect-openconnect patches) + occore
# for one target: macos | ios | iossim. Output lands in .build/<target>/prefix.
#
#   ./build.sh macos      # host build for the CLI test harness
#   ./build.sh ios        # device arm64
#   ./build.sh iossim     # simulator arm64
#   ./build.sh all        # ios + iossim, then ../Vendor/OCCore.xcframework
#
# Sources are fetched once into .build/src (see fetch_sources).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/.build"
SRC="$BUILD/src"
TARGET="${1:?usage: build.sh macos|ios|iossim|all}"

if [[ "$TARGET" == all ]]; then
  "$0" ios
  "$0" iossim
  OUT="$HERE/../Vendor/OCCore.xcframework"
  rm -rf "$OUT"
  xcodebuild -create-xcframework \
    -library "$BUILD/ios/libOCCore.a" -headers "$BUILD/ios/prefix/include/occore-headers" \
    -library "$BUILD/iossim/libOCCore.a" -headers "$BUILD/iossim/prefix/include/occore-headers" \
    -output "$OUT" >/dev/null
  echo "xcframework: $OUT"
  exit 0
fi

OPENCONNECT_COMMIT=0dcdff87db65daf692dc323732831391d595d98d
OPENSSL_VERSION=3.5.4
LWIP_TAG=STABLE-2_2_1_RELEASE
GP_PATCHES="${GP_PATCHES:-$HOME/GlobalProtect-openconnect/crates/openconnect/deps/patches}"
IOS_MIN=16.0
JOBS="$(sysctl -n hw.ncpu)"

fetch_sources() {
  mkdir -p "$SRC"
  if [[ ! -d "$SRC/openconnect" ]]; then
    git clone -q https://gitlab.com/openconnect/openconnect.git "$SRC/openconnect"
    git -C "$SRC/openconnect" checkout -q "$OPENCONNECT_COMMIT"
    for p in "$GP_PATCHES"/*.patch; do patch -s -p1 -d "$SRC/openconnect" -i "$p"; done
  fi
  if [[ ! -d "$SRC/lwip" ]]; then
    git clone -q --depth 1 --branch "$LWIP_TAG" https://github.com/lwip-tcpip/lwip.git "$SRC/lwip"
  fi
  if [[ ! -d "$SRC/openssl-$OPENSSL_VERSION" ]]; then
    curl -sSL "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz" |
      tar xz -C "$SRC"
  fi
  if [[ ! -x "$SRC/openconnect/configure" ]]; then
    (cd "$SRC/openconnect" && ./autogen.sh >/dev/null)
  fi
}

case "$TARGET" in
  macos)
    SDK=macosx; HOST=aarch64-apple-darwin; OSSL_TARGET=darwin64-arm64-cc
    MINFLAG="-mmacosx-version-min=13.0" ;;
  ios)
    SDK=iphoneos; HOST=aarch64-apple-darwin; OSSL_TARGET=ios64-xcrun
    MINFLAG="-miphoneos-version-min=$IOS_MIN" ;;
  iossim)
    SDK=iphonesimulator; HOST=aarch64-apple-darwin; OSSL_TARGET=iossimulator-arm64-xcrun
    MINFLAG="-mios-simulator-version-min=$IOS_MIN" ;;
  *) echo "unknown target $TARGET" >&2; exit 1 ;;
esac

SYSROOT="$(xcrun --sdk "$SDK" --show-sdk-path)"
PREFIX="$BUILD/$TARGET/prefix"
WORK="$BUILD/$TARGET/work"
export CC="$(xcrun --sdk "$SDK" -f clang)"
export CFLAGS="-arch arm64 -isysroot $SYSROOT $MINFLAG -O2"
export LDFLAGS="-arch arm64 -isysroot $SYSROOT $MINFLAG"

fetch_sources
mkdir -p "$PREFIX" "$WORK"

build_openssl() {
  [[ -f "$PREFIX/lib/libssl.a" ]] && return
  rm -rf "$WORK/openssl" && cp -R "$SRC/openssl-$OPENSSL_VERSION" "$WORK/openssl"
  (
    cd "$WORK/openssl"
    ./Configure "$OSSL_TARGET" no-shared no-tests no-apps no-docs no-module \
      --prefix="$PREFIX" --libdir=lib >/dev/null
    make -j"$JOBS" build_libs >/dev/null
    make install_dev >/dev/null
  )
}

build_openconnect() {
  [[ -f "$PREFIX/lib/libopenconnect.a" ]] && return
  rm -rf "$WORK/openconnect" && cp -R "$SRC/openconnect" "$WORK/openconnect"
  (
    cd "$WORK/openconnect"
    # Only look at our prefix so Homebrew's gnutls/lz4/etc never leak in.
    export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
    export PKG_CONFIG_PATH=""
    ./configure --host="$HOST" --prefix="$PREFIX" \
      --enable-static --disable-shared --disable-nls --disable-docs --disable-dsa-tests \
      --with-openssl --without-gnutls \
      --without-libproxy --without-stoken --without-libpcsclite --without-libpskc \
      --without-gssapi --without-lz4 --without-java --without-tss2 \
      --with-vpnc-script=/dev/null \
      LIBXML2_CFLAGS="-I$SYSROOT/usr/include/libxml2" LIBXML2_LIBS="-lxml2" \
      ZLIB_CFLAGS="" ZLIB_LIBS="-lz" \
      ac_cv_func_strchrnul=no >/dev/null
    make -j"$JOBS" libopenconnect.la >/dev/null
    mkdir -p "$PREFIX/include" "$PREFIX/lib"
    cp .libs/libopenconnect.a "$PREFIX/lib/"
    cp openconnect.h "$PREFIX/include/"
  )
}

# occore + the lwIP sources it needs, compiled straight into libocore.a.
build_core() {
  local obj="$WORK/core" lwip="$SRC/lwip/src"
  rm -rf "$obj" && mkdir -p "$obj"
  local srcs
  srcs=(
    "$HERE/occore.c"
    "$lwip"/core/{init,def,dns,inet_chksum,ip,mem,memp,netif,pbuf,raw,stats,sys,tcp,tcp_in,tcp_out,timeouts,udp}.c
    "$lwip"/core/ipv4/{icmp,ip4,ip4_addr,ip4_frag}.c
  )
  for f in "${srcs[@]}"; do
    "$CC" $CFLAGS -Wall -c "$f" -o "$obj/$(basename "${f%.c}").o" \
      -I"$HERE" -I"$HERE/lwip-port" -I"$lwip/include" -I"$PREFIX/include"
  done
  rm -f "$PREFIX/lib/libocore.a"
  xcrun ar rcs "$PREFIX/lib/libocore.a" "$obj"/*.o
  cp "$HERE/occore.h" "$PREFIX/include/"
  # Only occore.h is public; the Swift side never sees openconnect/OpenSSL headers.
  mkdir -p "$PREFIX/include/occore-headers"
  cp "$HERE/occore.h" "$PREFIX/include/occore-headers/"
  printf 'module OCCore {\n  header "occore.h"\n  export *\n}\n' > "$PREFIX/include/occore-headers/module.modulemap"
}

# One static library per target so the Xcode side links a single archive.
bundle() {
  xcrun libtool -static -o "$BUILD/$TARGET/libOCCore.a" \
    "$PREFIX"/lib/{libocore,libopenconnect,libssl,libcrypto}.a 2>/dev/null
}

build_openssl
build_openconnect
build_core
bundle

if [[ "$TARGET" == macos ]]; then
  "$CC" $CFLAGS -Wall -o "$BUILD/occore-cli" "$HERE/cli.c" -I"$HERE" \
    "$BUILD/macos/libOCCore.a" -lxml2 -lz -liconv
  echo "CLI: $BUILD/occore-cli"
fi
echo "$TARGET ready: $BUILD/$TARGET/libOCCore.a"
