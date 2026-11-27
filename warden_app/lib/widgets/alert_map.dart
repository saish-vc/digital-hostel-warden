import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

import '../theme.dart';

/// OpenStreetMap view for one alert. No API key, no Google Maps dependency.
class AlertMap extends StatefulWidget {
  const AlertMap({
    super.key,
    required this.latitude,
    required this.longitude,
    this.accuracy,
    this.height = 220,
  });

  final double latitude;
  final double longitude;
  final double? accuracy;
  final double height;

  @override
  State<AlertMap> createState() => _AlertMapState();
}

class _AlertMapState extends State<AlertMap> {
  final MapController _controller = MapController();
  late LatLng _center;

  @override
  void initState() {
    super.initState();
    _center = LatLng(widget.latitude, widget.longitude);
  }

  @override
  void didUpdateWidget(covariant AlertMap oldWidget) {
    super.didUpdateWidget(oldWidget);
    final next = LatLng(widget.latitude, widget.longitude);
    if (next != _center) {
      _center = next;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _controller.move(next, 18);
      });
    }
  }

  void _recenter() => _controller.move(_center, 18);

  @override
  Widget build(BuildContext context) {
    final accuracy = widget.accuracy ?? 0;
    return ClipRRect(
      borderRadius: BorderRadius.circular(14),
      child: SizedBox(
        height: widget.height,
        child: Stack(
          children: [
            FlutterMap(
              mapController: _controller,
              options: MapOptions(
                initialCenter: _center,
                initialZoom: 17,
                minZoom: 3,
                maxZoom: 19,
                interactionOptions: const InteractionOptions(
                  flags: InteractiveFlag.all & ~InteractiveFlag.rotate,
                ),
              ),
              children: [
                TileLayer(
                  urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                  userAgentPackageName: 'com.hostelguard.warden',
                  maxZoom: 19,
                ),
                if (accuracy > 0)
                  CircleLayer(
                    circles: [
                      CircleMarker(
                        point: _center,
                        radius: accuracy,
                        useRadiusInMeter: true,
                        color: AppColors.pending.withValues(alpha: 0.12),
                        borderColor: AppColors.pending.withValues(alpha: 0.45),
                        borderStrokeWidth: 1,
                      ),
                    ],
                  ),
                MarkerLayer(
                  markers: [
                    Marker(
                      point: _center,
                      width: 44,
                      height: 44,
                      child: const Icon(
                        Icons.location_on,
                        color: AppColors.pending,
                        size: 40,
                        shadows: [
                          Shadow(color: Colors.black54, blurRadius: 6),
                        ],
                      ),
                    ),
                  ],
                ),
              ],
            ),
            Positioned(
              right: 8,
              bottom: 8,
              child: FloatingActionButton.small(
                heroTag: 'recenter',
                backgroundColor: AppColors.surface,
                foregroundColor: AppColors.text,
                onPressed: _recenter,
                child: const Icon(Icons.my_location, size: 18),
              ),
            ),
            Positioned(
              left: 8,
              bottom: 8,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                decoration: BoxDecoration(
                  color: Colors.black.withValues(alpha: 0.55),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: const Text(
                  '© OpenStreetMap contributors',
                  style: TextStyle(color: Colors.white70, fontSize: 9),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
