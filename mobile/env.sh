#!/bin/bash
# Source this before running gradle from the command line:  source mobile/env.sh
#
# Two things bite on a fresh machine:
#
#   * ANDROID_HOME. Android Studio knows where the SDK is; the CLI does not.
#   * The JDK. Gradle 8.2 (what Capacitor 6 pins) cannot run on Java 20+ — it fails with
#     "Unsupported class file major version 67", an error that looks nothing like "wrong Java
#     version". This machine's default `java` is 23. Android Studio sidesteps it with its own
#     bundled JBR; this picks a compatible JDK for the terminal.
#
# NOTE: `/usr/libexec/java_home -v 17` means "17 OR NEWER" on macOS, so it happily returns
# Java 23. Every candidate here is therefore checked by asking the binary what it actually is.

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

GRADLE_MIN_JAVA=17
GRADLE_MAX_JAVA=19   # raise this when the Gradle wrapper is upgraded

_java_major() {
  "$1/bin/java" -version 2>&1 | head -1 | sed -E 's/[^"]*"([0-9]+).*/\1/'
}

_java_ok() {
  [ -x "$1/bin/java" ] || return 1
  local major
  major=$(_java_major "$1")
  [ -n "$major" ] && [ "$major" -ge "$GRADLE_MIN_JAVA" ] && [ "$major" -le "$GRADLE_MAX_JAVA" ]
}

pick_java() {
  # Android Studio's bundled runtime first — it's the one the IDE builds with.
  local jbr="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  _java_ok "$jbr" && { echo "$jbr"; return; }

  # Otherwise the newest installed JDK that Gradle can actually run on.
  local home
  while IFS= read -r home; do
    _java_ok "$home" && { echo "$home"; return; }
  done < <(/usr/libexec/java_home -V 2>&1 | awk '/\/Contents\/Home$/ {print $NF}')
}

_java_home="$(pick_java)"
if [ -n "$_java_home" ]; then
  export JAVA_HOME="$_java_home"
else
  echo "⚠  No JDK ${GRADLE_MIN_JAVA}-${GRADLE_MAX_JAVA} found — Gradle 8.2 cannot run on Java 20+."
  echo "   Install one:  brew install openjdk@17"
  echo "   ...or open mobile/android in Android Studio, which uses its own bundled runtime."
fi

echo "ANDROID_HOME=$ANDROID_HOME"
echo "JAVA_HOME=${JAVA_HOME:-<unset>}"
[ -n "${JAVA_HOME:-}" ] && "$JAVA_HOME/bin/java" -version 2>&1 | head -1
