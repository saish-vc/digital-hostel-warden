import { useEffect, useState } from 'react';
import { Circle, MapContainer, Marker, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { LatLngExpression } from 'leaflet';
import type { Alert } from '../api/client';

// TODO(owner): set this to the hostel's real coordinates once known.
const HOSTEL_CENTER: LatLngExpression = [12.9716, 77.5946];
const HOSTEL_ZOOM = 16;
const ALERT_ZOOM = 18;

const alertIcon = L.divIcon({
  className: '',
  html: '<div style="width:18px;height:18px;border-radius:50%;background:#dc2626;border:3px solid #ffffff;box-shadow:0 0 0 6px rgba(220,38,38,0.35);"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

interface FocusProps {
  alert: Alert | null;
  recenterToken: number;
}

function MapFocus({ alert, recenterToken }: FocusProps) {
  const map = useMap();

  const hasLocation =
    alert !== null &&
    alert.latitude !== null &&
    alert.longitude !== null &&
    Number.isFinite(alert.latitude) &&
    Number.isFinite(alert.longitude);

  // Pan/zoom to the selected alert's pin.
  useEffect(() => {
    if (alert && hasLocation) {
      map.flyTo([alert.latitude!, alert.longitude!], ALERT_ZOOM, { duration: 0.6 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alert?.id, hasLocation, map]);

  // Fly back to the hostel overview when Recenter is pressed.
  useEffect(() => {
    if (recenterToken === 0) return;
    map.flyTo(HOSTEL_CENTER, HOSTEL_ZOOM, { duration: 0.6 });
  }, [recenterToken, map]);

  return null;
}

interface AlertMapProps {
  alert: Alert | null;
}

export default function AlertMap({ alert }: AlertMapProps) {
  const [recenterToken, setRecenterToken] = useState(0);

  const hasLocation =
    alert !== null &&
    alert.latitude !== null &&
    alert.longitude !== null &&
    Number.isFinite(alert.latitude) &&
    Number.isFinite(alert.longitude);

  return (
    <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-4 py-2">
        <h2 className="text-sm font-semibold text-slate-300">Location</h2>
        <button
          type="button"
          onClick={() => setRecenterToken((token) => token + 1)}
          className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-300 transition hover:bg-slate-800"
        >
          Recenter map
        </button>
      </div>

      <MapContainer
        center={HOSTEL_CENTER}
        zoom={HOSTEL_ZOOM}
        scrollWheelZoom
        className="h-[420px] w-full"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {hasLocation && alert && (
          <>
            <Marker position={[alert.latitude!, alert.longitude!]} icon={alertIcon} />
            {alert.locationAccuracy !== null && alert.locationAccuracy > 0 && (
              <Circle
                center={[alert.latitude!, alert.longitude!]}
                radius={alert.locationAccuracy}
                pathOptions={{
                  color: '#dc2626',
                  weight: 1,
                  fillColor: '#dc2626',
                  fillOpacity: 0.15,
                }}
              />
            )}
          </>
        )}

        <MapFocus alert={alert} recenterToken={recenterToken} />
      </MapContainer>

      {alert && !hasLocation && (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 mx-auto w-fit rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-lg">
          Location unavailable — this alert was sent without GPS data
        </div>
      )}

      {!alert && (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 mx-auto w-fit rounded-lg bg-slate-800 px-4 py-2 text-sm text-slate-200 shadow-lg">
          Select an alert to see where it was sent from
        </div>
      )}
    </div>
  );
}
