package io.github.pythdom.runbpm;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.view.WindowManager;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Course en cours : service de premier plan « lecture multimédia » (l'application continue de jouer
 * écran verrouillé) et, si demandé, écran maintenu allumé.
 */
@CapacitorPlugin(name = "RunSession")
public class RunSessionPlugin extends Plugin {

    private static final int NOTIFICATION_PERMISSION_REQUEST = 4242;

    @PluginMethod
    public void start(PluginCall call) {
        Activity activity = getActivity();
        if (Build.VERSION.SDK_INT >= 33
            && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            // Sans cette autorisation le service fonctionne, mais sa notification reste invisible.
            ActivityCompat.requestPermissions(activity, new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFICATION_PERMISSION_REQUEST);
        }
        Intent intent = new Intent(getContext(), RunService.class)
            .putExtra(RunService.EXTRA_TITLE, call.getString("title", "RunBPM"))
            .putExtra(RunService.EXTRA_TEXT, call.getString("text", ""));
        try {
            ContextCompat.startForegroundService(getContext(), intent);
        } catch (RuntimeException e) {
            call.reject("Service de course indisponible : " + e.getMessage());
            return;
        }
        boolean keepScreenOn = Boolean.TRUE.equals(call.getBoolean("keepScreenOn", true));
        activity.runOnUiThread(() -> {
            if (keepScreenOn) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), RunService.class));
        Activity activity = getActivity();
        activity.runOnUiThread(() -> activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
        call.resolve();
    }
}
