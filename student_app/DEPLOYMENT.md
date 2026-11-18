# HostelGuard Mobile App — Production Build & Deployment Guide

The student mobile application is built with Flutter and communicates with the HostelGuard Backend via REST and WebSockets (Socket.IO).

## Dynamic API Endpoint Configuration

The API URL is configured at compile/run time using Dart environment defines (`--dart-define`).

### Development
```bash
# Android Emulator (default points to 10.0.2.2:4000)
flutter run

# Physical Device over Local Wi-Fi
flutter run --dart-define=API_URL=http://192.168.1.100:3001
```

### Production Builds

For production releases, pass your live production domain (HTTPS/WSS):

```bash
# Android APK release
flutter build apk --release --dart-define=API_URL=https://api.hostelguard.com

# Android App Bundle (for Google Play Console)
flutter build appbundle --release --dart-define=API_URL=https://api.hostelguard.com

# iOS Release (via Xcode or CLI on macOS)
flutter build ipa --release --dart-define=API_URL=https://api.hostelguard.com

# Web Release
flutter build web --release --dart-define=API_URL=https://api.hostelguard.com
```

## Transport Security
In production:
- Ensure the API URL is always `https://`.
- Socket.IO automatically upgrades to WSS over HTTPS.
- Android Network Security Config & iOS Info.plist enforce TLS 1.2+ by default in release builds.
