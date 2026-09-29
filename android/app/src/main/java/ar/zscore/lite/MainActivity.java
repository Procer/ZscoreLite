package ar.zscore.lite;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Base64;
import android.util.Log;
import android.view.KeyEvent;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import androidx.core.content.FileProvider;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import java.io.File;
import java.io.FileOutputStream;

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
        // Reintento tras el primer dibujado: en algunos equipos el primer
        // hide() se pierde porque la ventana todavía no está lista.
        getWindow().getDecorView().postDelayed(this::hideSystemBars, 400);
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().addJavascriptInterface(new NativeBridge(), "ZScoreNative");
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        hideSystemBars();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    /** Funciones nativas que la página puede llamar como window.ZScoreNative.* */
    private class NativeBridge {
        /** Copia una imagen PNG (base64, sin prefijo data:) al portapapeles del
         * sistema, para poder pegarla en WhatsApp u otra app. */
        @JavascriptInterface
        public boolean copyImage(String base64Png) {
            try {
                byte[] bytes = Base64.decode(base64Png, Base64.DEFAULT);
                File dir = new File(getCacheDir(), "shared");
                if (!dir.exists() && !dir.mkdirs()) return false;
                File file = new File(dir, "zscore-partido.png");
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(bytes);
                }
                Uri uri = FileProvider.getUriForFile(
                    MainActivity.this, getPackageName() + ".fileprovider", file);
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newUri(getContentResolver(), "Z-Score Lite", uri));
                return true;
            } catch (Exception e) {
                Log.e(TAG, "copyImage fallo", e);
                return false;
            }
        }

        /** Pitido corto de frecuencia y duracion dadas (confirma un toque del control). */
        @JavascriptInterface
        public void beep(int freq, int ms) {
            new Thread(() -> {
                AudioTrack track = null;
                try {
                    int rate = 22050;
                    int n = rate * Math.max(20, Math.min(ms, 600)) / 1000;
                    short[] buf = new short[n];
                    int fade = Math.min(n / 4, rate / 200);
                    for (int i = 0; i < n; i++) {
                        double env = i < fade ? (double) i / fade : (i > n - fade ? (double) (n - i) / fade : 1.0);
                        buf[i] = (short) (Math.sin(2 * Math.PI * i * freq / rate) * 14000 * env);
                    }
                    track = new AudioTrack.Builder()
                        .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                        .setAudioFormat(new AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(rate)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                        .setBufferSizeInBytes(n * 2)
                        .setTransferMode(AudioTrack.MODE_STATIC).build();
                    track.write(buf, 0, n);
                    track.play();
                    Thread.sleep(ms + 60);
                } catch (Exception e) {
                    Log.e(TAG, "beep fallo", e);
                } finally {
                    if (track != null) track.release();
                }
            }).start();
        }

        /** Copia texto plano (un link) al portapapeles del sistema. */
        @JavascriptInterface
        public boolean copyText(String text) {
            try {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("Z-Score Lite", text));
                return true;
            } catch (Exception e) {
                Log.e(TAG, "copyText fallo", e);
                return false;
            }
        }

        /** Abre el menu de compartir del sistema con un texto (WhatsApp, etc.). */
        @JavascriptInterface
        public boolean shareText(String text) {
            try {
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("text/plain");
                send.putExtra(Intent.EXTRA_TEXT, text);
                runOnUiThread(() -> startActivity(Intent.createChooser(send, "Compartir partido en vivo")));
                return true;
            } catch (Exception e) {
                Log.e(TAG, "shareText fallo", e);
                return false;
            }
        }

        @JavascriptInterface
        public void vibrate(int ms) {
            try {
                Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                if (v != null) v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
            } catch (Exception e) {
                Log.e(TAG, "vibrate fallo", e);
            }
        }

        /** Guarda el archivo (base64) y abre el menu de compartir del sistema
         * (WhatsApp, Drive, correo...). Se usa para la copia de seguridad. */
        @JavascriptInterface
        public boolean shareFile(String name, String base64, String mime) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                File dir = new File(getCacheDir(), "shared");
                if (!dir.exists() && !dir.mkdirs()) return false;
                File file = new File(dir, name.replaceAll("[^A-Za-z0-9._-]", "_"));
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(bytes);
                }
                Uri uri = FileProvider.getUriForFile(
                    MainActivity.this, getPackageName() + ".fileprovider", file);
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType(mime);
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                runOnUiThread(() -> startActivity(Intent.createChooser(send, "Copia de seguridad")));
                return true;
            } catch (Exception e) {
                Log.e(TAG, "shareFile fallo", e);
                return false;
            }
        }
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
