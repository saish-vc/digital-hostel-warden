package com.hostelguard.warden

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val channelName = "hostelguard/device"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "startOnDuty" -> {
                        startOnDuty()
                        result.success(true)
                    }
                    "stopOnDuty" -> {
                        stopService(Intent(this, OnDutyService::class.java))
                        result.success(true)
                    }
                    "setSecure" -> {
                        setSecure(call.argument<Boolean>("enabled") ?: false)
                        result.success(true)
                    }
                    "isBatteryOptimized" -> result.success(isBatteryOptimized())
                    "requestBatteryExemption" -> {
                        requestBatteryExemption()
                        result.success(true)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    private fun startOnDuty() {
        val intent = Intent(this, OnDutyService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun setSecure(enabled: Boolean) {
        if (enabled) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
    }

    private fun isBatteryOptimized(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        return !power.isIgnoringBatteryOptimizations(packageName)
    }

    @SuppressLint("BatteryLife")
    private fun requestBatteryExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
        intent.data = Uri.parse("package:$packageName")
        try {
            startActivity(intent)
        } catch (_: Exception) {
            // Some OEMs block this action; Settings › Battery still works.
        }
    }
}
