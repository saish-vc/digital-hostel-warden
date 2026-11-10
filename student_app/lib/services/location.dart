import 'package:geolocator/geolocator.dart';

/// A single position fix captured at SOS time. We never track movement.
typedef LocationFix = ({double lat, double lng, double accuracy});

const _locationTimeout = Duration(seconds: 5);

/// Returns a position fix, or null on any failure.
///
/// Never throws and never takes more than ~5 seconds, so the SOS flow can
/// always proceed without location.
///
/// Permission policy:
///  - granted          -> capture the fix
///  - denied           -> ask again once, then give up (null)
///  - permanently denied -> give up; the caller offers the Settings dialog
Future<LocationFix?> getCurrentLocationSafe() async {
  try {
    final serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      return null;
    }

    var permission = await Geolocator.checkPermission();

    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }

    if (permission == LocationPermission.denied) {
      // The user said no twice; do not nag further.
      permission = await Geolocator.requestPermission();
    }

    if (permission == LocationPermission.deniedForever) {
      return null;
    }

    if (permission != LocationPermission.whileInUse &&
        permission != LocationPermission.always) {
      return null;
    }

    final position = await Geolocator.getCurrentPosition(
      // geolocator 12.x API (13.x renamed this to `locationSettings`).
      desiredAccuracy: LocationAccuracy.high,
      timeLimit: _locationTimeout,
    ).timeout(_locationTimeout);

    return (
      lat: position.latitude,
      lng: position.longitude,
      accuracy: position.accuracy,
    );
  } catch (_) {
    return null;
  }
}
