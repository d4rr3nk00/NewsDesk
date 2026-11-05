#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${ANDROID_PLATFORM:?Set ANDROID_PLATFORM to the SDK platform directory containing android.jar}"
: "${ANDROID_BUILD_TOOLS:?Set ANDROID_BUILD_TOOLS to the SDK build-tools directory}"
: "${ANDROID_KEYSTORE:?Set ANDROID_KEYSTORE outside the repository}"
: "${ANDROID_STORE_PASSWORD:?Set ANDROID_STORE_PASSWORD}"
: "${ANDROID_KEY_ALIAS:=newsdesk-alpha}"
mkdir -p build/android/classes build/android/dex releases
rm -f build/android/unsigned.apk build/android/aligned.apk
sed 's/<manifest /<manifest package="kr.newsdesk.client" /' android/app/src/main/AndroidManifest.xml > build/android/AndroidManifest.xml
"$ANDROID_BUILD_TOOLS/aapt2" compile --dir android/app/src/main/res -o build/android/resources.zip
"$ANDROID_BUILD_TOOLS/aapt2" link -o build/android/unsigned.apk -I "$ANDROID_PLATFORM/android.jar" --manifest build/android/AndroidManifest.xml --min-sdk-version 26 --target-sdk-version 35 --version-code 2 --version-name 0.2.0-alpha.1 build/android/resources.zip
# javac is a build dependency only, not a requirement on the user's device.
java com.sun.tools.javac.Main -source 8 -target 8 -encoding UTF-8 -bootclasspath "$ANDROID_PLATFORM/android.jar:$ANDROID_BUILD_TOOLS/core-lambda-stubs.jar" -d build/android/classes android/app/src/main/java/kr/newsdesk/client/MainActivity.java
find build/android/classes -name '*.class' > build/android/classes.txt
"$ANDROID_BUILD_TOOLS/d8" --min-api 26 --lib "$ANDROID_PLATFORM/android.jar" --output build/android/dex @build/android/classes.txt
(cd build/android/dex && zip -q ../unsigned.apk classes.dex)
"$ANDROID_BUILD_TOOLS/zipalign" -p -f 4 build/android/unsigned.apk build/android/aligned.apk
"$ANDROID_BUILD_TOOLS/apksigner" sign --ks "$ANDROID_KEYSTORE" --ks-key-alias "$ANDROID_KEY_ALIAS" --ks-pass env:ANDROID_STORE_PASSWORD --key-pass env:ANDROID_STORE_PASSWORD --out releases/NewsDesk-0.2.0-alpha.apk build/android/aligned.apk
"$ANDROID_BUILD_TOOLS/apksigner" verify --verbose releases/NewsDesk-0.2.0-alpha.apk
