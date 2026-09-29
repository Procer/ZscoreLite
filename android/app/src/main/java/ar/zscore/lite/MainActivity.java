package ar.zscore.lite;

import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.Window;
import android.view.WindowManager;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

/**
 * Intercepta las teclas de volumen a nivel nativo para que el control remoto
 * Bluetooth (que simula esas teclas) le llegue a la página web como un
 * evento 'remote-shutter', y para que el volumen real del celular no cambie
 * mientras se usa el control durante el partido.
 *
 * Registra TODOS los key events que llegan (no solo volumen) en Logcat con
 * el tag "ZScoreRemote", para poder diagnosticar con datos reales qué manda
 * cada botón del control físico: `adb logcat -s ZScoreRemote`.
 */
public class MainActivity extends BridgeActivity {
    private static final String TAG = "ZScoreRemote";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        hideSystemBars();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    /** Pantalla completa inmersiva: oculta barra de notificaciones y de
     * navegación (reaparecen con un deslizamiento desde el borde). */
    private void hideSystemBars() {
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.getAttributes().layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int keyCode = event.getKeyCode();
        String actionName = event.getAction() == KeyEvent.ACTION_DOWN ? "DOWN"
            : event.getAction() == KeyEvent.ACTION_UP ? "UP"
            : String.valueOf(event.getAction());
        Log.d(TAG, "keyCode=" + keyCode + " (" + KeyEvent.keyCodeToString(keyCode) + ")"
            + " action=" + actionName
            + " repeatCount=" + event.getRepeatCount()
            + " eventTime=" + event.getEventTime()
            + " source=" + event.getSource());

        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
            if (event.getAction() == KeyEvent.ACTION_DOWN) {
                String which = (keyCode == KeyEvent.KEYCODE_VOLUME_UP) ? "volumeup" : "volumedown";
                String js = "window.dispatchEvent(new CustomEvent('remote-shutter', { detail: '" + which + "' }));";
                if (bridge != null && bridge.getWebView() != null) {
                    bridge.getWebView().post(() -> bridge.getWebView().evaluateJavascript(js, null));
                }
            }
            return true; // consumida: no cambia el volumen real del celular
        }
        return super.dispatchKeyEvent(event);
    }
}
