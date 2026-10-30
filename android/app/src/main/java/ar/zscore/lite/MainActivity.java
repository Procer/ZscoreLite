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
import android.speech.tts.TextToSpeech;
import android.speech.tts.Voice;
import android.util.Base64;
import android.util.Log;
import android.view.KeyEvent;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import java.io.File;
import java.io.FileOutputStream;
import java.util.Locale;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

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
    private TextToSpeech tts;
    private volatile boolean ttsReady = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        hideSystemBars();
        initTts();
        // Reintento tras el primer dibujado: en algunos equipos el primer
        // hide() se pierde porque la ventana todavía no está lista.
        getWindow().getDecorView().postDelayed(this::hideSystemBars, 400);
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().addJavascriptInterface(new NativeBridge(), "ZScoreNative");
        }
    }

    private void initTts() {
        tts = new TextToSpeech(getApplicationContext(), status -> {
            if (status != TextToSpeech.SUCCESS || tts == null) {
                Log.e(TAG, "TextToSpeech no arranco, status=" + status);
                return;
            }
            Locale[] prefs = { new Locale("es", "AR"), new Locale("es", "MX"), new Locale("es", "ES"), new Locale("es") };
            for (Locale l : prefs) {
                int r = tts.setLanguage(l);
                if (r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED) {
                    ttsReady = true;
                    break;
                }
            }
            if (ttsReady) {
                tts.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
            } else {
                Log.e(TAG, "TextToSpeech sin idioma espanol");
            }
        });
    }

    @Override
    public void onDestroy() {
        if (tts != null) {
            tts.stop();
            tts.shutdown();
            tts = null;
        }
        super.onDestroy();
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

        /** versionCode del APK instalado (0 si no se puede leer). Sirve para avisar de actualizaciones. */
        @JavascriptInterface
        public int appVersionCode() {
            try {
                return (int) PackageInfoCompat.getLongVersionCode(
                    getPackageManager().getPackageInfo(getPackageName(), 0));
            } catch (Exception e) {
                Log.e(TAG, "appVersionCode fallo", e);
                return 0;
            }
        }

        /** Abre un link https del propio servidor en el navegador del sistema (descarga del APK nuevo). */
        @JavascriptInterface
        public boolean openUrl(String url) {
            try {
                Uri uri = Uri.parse(url);
                if (!"https".equals(uri.getScheme()) || !"lite.zscore.ar".equals(uri.getHost())) return false;
                Intent view = new Intent(Intent.ACTION_VIEW, uri);
                runOnUiThread(() -> startActivity(view));
                return true;
            } catch (Exception e) {
                Log.e(TAG, "openUrl fallo", e);
                return false;
            }
        }

        /** Dice el texto con el motor de voz de Android (el speechSynthesis del
         * WebView no suena en varios celulares). Corta lo que estuviera hablando. */
        @JavascriptInterface
        public boolean speak(String text) {
            if (tts == null || !ttsReady || text == null || text.isEmpty()) return false;
            try {
                return tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "zs") == TextToSpeech.SUCCESS;
            } catch (Exception e) {
                Log.e(TAG, "speak fallo", e);
                return false;
            }
        }

        /** Voces en español instaladas, como JSON: [{"name":"...","lang":"es-AR"}]. */
        @JavascriptInterface
        public String listVoices() {
            JSONArray out = new JSONArray();
            try {
                if (tts != null && ttsReady) {
                    Set<Voice> voices = tts.getVoices();
                    if (voices != null) {
                        for (Voice v : voices) {
                            if (!"spa".equals(v.getLocale().getISO3Language())) continue;
                            if (v.getFeatures() != null && v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                            out.put(new JSONObject()
                                .put("name", v.getName())
                                .put("lang", v.getLocale().toLanguageTag())
                                .put("online", v.isNetworkConnectionRequired()));
                        }
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "listVoices fallo", e);
            }
            return out.toString();
        }

        /** Abre la pantalla de Android para descargar más voces (o los ajustes de voz si no existe). */
        @JavascriptInterface
        public boolean openVoiceInstall() {
            String[] actions = { TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA, "com.android.settings.TTS_SETTINGS" };
            for (String action : actions) {
                try {
                    Intent i = new Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    if (i.resolveActivity(getPackageManager()) == null) continue;
                    runOnUiThread(() -> startActivity(i));
                    return true;
                } catch (Exception e) {
                    Log.e(TAG, "openVoiceInstall fallo", e);
                }
            }
            return false;
        }

        /** Abre los ajustes de voz de Android (motor de voz, idioma, voces instaladas). */
        @JavascriptInterface
        public boolean openTtsSettings() {
            String[] actions = { "com.android.settings.TTS_SETTINGS", android.provider.Settings.ACTION_SETTINGS };
            for (String action : actions) {
                try {
                    Intent i = new Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    if (i.resolveActivity(getPackageManager()) == null) continue;
                    runOnUiThread(() -> startActivity(i));
                    return true;
                } catch (Exception e) {
                    Log.e(TAG, "openTtsSettings fallo", e);
                }
            }
            return false;
        }

        /** Elige la voz por nombre; vacío vuelve a la automática. */
        @JavascriptInterface
        public boolean setVoice(String name) {
            if (tts == null || !ttsReady) return false;
            try {
                if (name == null || name.isEmpty()) {
                    tts.setLanguage(new Locale("es", "AR"));
                    return true;
                }
                for (Voice v : tts.getVoices()) {
                    if (v.getName().equals(name)) return tts.setVoice(v) == TextToSpeech.SUCCESS;
                }
            } catch (Exception e) {
                Log.e(TAG, "setVoice fallo", e);
            }
            return false;
        }

        /** true si el motor de voz nativo ya arrancó y tiene un idioma español usable. */
        @JavascriptInterface
        public boolean speakReady() {
            return tts != null && ttsReady;
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
