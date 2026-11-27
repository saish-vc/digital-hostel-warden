package com.hostelguard.warden

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Low-importance persistent notification that keeps the process (and its
 * Socket.IO connection) alive while a warden is on duty and the app is not in
 * the foreground. It deliberately uses a separate channel from `warden_alerts`
 * so an ongoing service notification can never mute or outrank an SOS.
 */
class OnDutyService : Service() {
    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "On duty",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Keeps the warden alert connection running while on duty"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java)
                ?.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("On duty")
            .setContentText("Live alert connection is active")
            .setSmallIcon(R.drawable.ic_stat_alert)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)

        val launch = packageManager.getLaunchIntentForPackage(packageName)
        if (launch != null) {
            builder.setContentIntent(
                PendingIntent.getActivity(
                    this,
                    0,
                    launch,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
        }
        return builder.build()
    }

    companion object {
        private const val CHANNEL_ID = "on_duty"
        private const val NOTIFICATION_ID = 7101
    }
}
