package ar.zscore.lite;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.util.Log;
import com.k2fsa.sherpa.onnx.GeneratedAudio;
import com.k2fsa.sherpa.onnx.OfflineTts;
import com.k2fsa.sherpa.onnx.OfflineTtsConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Voces propias de la app (Piper sobre sherpa-onnx): suenan igual en cualquier celular y funcionan sin internet.
 * Cada voz se baja UNA vez desde el servidor y queda en el almacenamiento privado de la app.
 */
final class NeuralVoices {
    private static final String TAG = "ZScoreVoices";
    private static final String BASE_URL = "https://lite.zscore.ar/voces/";
    private static final String SHARED_PACK = "espeak-ng-data";

    /** id, nombre, genero, pais, MB aproximados de descarga, voz base, tono (1 = el de la voz; menos = mas grave). */
    private static final String[][] CATALOG = {
        { "daniela", "Daniela", "femenina", "Argentina", "37", "daniela", "1" },
        { "claude", "Claudia", "femenina", "México", "23", "claude", "1" },
        { "ald", "Alberto", "masculina", "México", "23", "ald", "1" },
        // Misma voz de Alberto con el tono mas grave: suena como otro hombre y no pesa nada mas.
        { "martin", "Martín", "masculina", "México", "23", "ald", "0.86" },
    };

    interface Listener {
        /** state: "descargando" | "listo" | "error". percent: 0-100. */
        void onProgress(String id, String state, int percent);
    }

    private final Context ctx;
    private final Listener listener;
    private final File root;
    private final ExecutorService speaker = Executors.newSingleThreadExecutor();
    private final ExecutorService downloader = Executors.newSingleThreadExecutor();
    private final AtomicInteger ticket = new AtomicInteger();
    private final Map<String, short[]> cache = new LinkedHashMap<String, short[]>(48, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, short[]> e) { return size() > 40; }
    };
    private OfflineTts engine;
    private String engineId = "";
    private AudioTrack track;
    private volatile boolean downloading = false;

    NeuralVoices(Context ctx, Listener listener) {
        this.ctx = ctx;
        this.listener = listener;
        this.root = new File(ctx.getFilesDir(), "voces");
    }

    private static String[] entry(String id) {
        for (String[] c : CATALOG) if (c[0].equals(id)) return c;
        return null;
    }

    private static boolean known(String id) { return entry(id) != null; }

    /** Carpeta del modelo que usa esta voz (Martin comparte el de Alberto). */
    private static String baseOf(String id) { return entry(id)[5]; }

    boolean isInstalled(String id) {
        if (!known(id)) return false;
        File d = new File(root, baseOf(id));
        return new File(d, "model.onnx").isFile() && new File(d, "tokens.txt").isFile()
            && new File(root, SHARED_PACK + "/phontab").isFile();
    }

    String listJson() {
        JSONArray out = new JSONArray();
        try {
            for (String[] c : CATALOG) {
                out.put(new JSONObject().put("id", c[0]).put("name", c[1]).put("gender", c[2])
                    .put("country", c[3]).put("mb", Integer.parseInt(c[4])).put("installed", isInstalled(c[0])));
            }
        } catch (Exception e) {
            Log.e(TAG, "listJson fallo", e);
        }
        return out.toString();
    }

    // ---------- Descarga ----------

    boolean download(String id) {
        if (!known(id) || downloading) return false;
        downloading = true;
        downloader.execute(() -> {
            try {
                boolean needShared = !new File(root, SHARED_PACK + "/phontab").isFile();
                // La parte compartida (diccionarios) pesa poco y cuenta como el primer 20%.
                if (needShared) fetchPack(SHARED_PACK, new File(root, SHARED_PACK), id, 0, 20);
                String base = baseOf(id);
                if (!new File(root, base + "/model.onnx").isFile()) fetchPack(base, new File(root, base), id, needShared ? 20 : 0, 100);
                listener.onProgress(id, "listo", 100);
            } catch (Exception e) {
                Log.e(TAG, "descarga fallo: " + id, e);
                listener.onProgress(id, "error", 0);
            } finally {
                downloading = false;
            }
        });
        return true;
    }

    /** Baja <pack>.zip y lo descomprime en una carpeta temporal; recien al terminar la mueve a su lugar. */
    private void fetchPack(String pack, File dest, String id, int from, int to) throws Exception {
        root.mkdirs();
        File tmp = new File(root, pack + ".tmp");
        deleteTree(tmp);
        File zip = new File(root, pack + ".zip.part");
        HttpURLConnection c = (HttpURLConnection) new URL(BASE_URL + pack + ".zip").openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        try {
            if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
            long total = c.getContentLengthLong();
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(zip)) {
                byte[] buf = new byte[64 * 1024];
                long got = 0;
                int n, last = -1;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    got += n;
                    if (total > 0) {
                        int pct = from + (int) ((to - from) * 0.9 * got / total);
                        if (pct != last) { last = pct; listener.onProgress(id, "descargando", pct); }
                    }
                }
            }
        } finally {
            c.disconnect();
        }
        unzip(zip, tmp);
        zip.delete();
        deleteTree(dest);
        dest.getParentFile().mkdirs();
        if (!tmp.renameTo(dest)) throw new Exception("no pude mover " + pack);
    }

    private static void unzip(File zip, File into) throws Exception {
        String base = into.getCanonicalPath() + File.separator;
        into.mkdirs();
        try (ZipInputStream z = new ZipInputStream(new java.io.FileInputStream(zip))) {
            ZipEntry e;
            byte[] buf = new byte[64 * 1024];
            while ((e = z.getNextEntry()) != null) {
                File f = new File(into, e.getName());
                if (!f.getCanonicalPath().startsWith(base)) throw new Exception("zip invalido"); // zip-slip
                if (e.isDirectory()) { f.mkdirs(); continue; }
                f.getParentFile().mkdirs();
                try (OutputStream out = new FileOutputStream(f)) {
                    int n;
                    while ((n = z.read(buf)) > 0) out.write(buf, 0, n);
                }
            }
        }
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    boolean delete(String id) {
        if (!known(id)) return false;
        String base = baseOf(id);
        deleteTree(new File(root, base));
        synchronized (this) { if (base.equals(engineId)) releaseEngine(); }
        return true;
    }

    // ---------- Voz ----------

    /** Dice el texto con la voz `id`. Corta lo anterior. false si esa voz no esta instalada. */
    boolean speak(String id, String text, float speed) {
        if (text == null || text.isEmpty() || !isInstalled(id)) return false;
        final int mine = ticket.incrementAndGet();
        stopTrack();
        speaker.execute(() -> {
            if (mine != ticket.get()) return; // ya hay un anuncio mas nuevo
            try {
                short[] pcm;
                int rate;
                float pitch = Float.parseFloat(entry(id)[6]);
                synchronized (this) {
                    OfflineTts tts = engineFor(baseOf(id));
                    // Tono mas grave: se genera mas rapido y se reproduce mas lento, y la duracion queda igual.
                    rate = Math.round(tts.sampleRate() * pitch);
                    String key = id + "|" + speed + "|" + text;
                    pcm = cache.get(key);
                    if (pcm == null) {
                        GeneratedAudio a = tts.generate(text, 0, speed / pitch);
                        float[] f = a.getSamples();
                        pcm = new short[f.length];
                        for (int i = 0; i < f.length; i++) {
                            float v = Math.max(-1f, Math.min(1f, f[i]));
                            pcm[i] = (short) (v * 32767);
                        }
                        cache.put(key, pcm);
                    }
                }
                if (mine != ticket.get() || pcm.length == 0) return;
                play(pcm, rate, mine);
            } catch (Throwable t) {
                Log.e(TAG, "speak fallo", t);
                listener.onProgress(id, "fallo: " + t, 0);
            }
        });
        return true;
    }

    private OfflineTts engineFor(String id) {
        if (engine != null && id.equals(engineId)) return engine;
        releaseEngine();
        File d = new File(root, id);
        OfflineTtsVitsModelConfig vits = new OfflineTtsVitsModelConfig();
        vits.setModel(new File(d, "model.onnx").getAbsolutePath());
        vits.setTokens(new File(d, "tokens.txt").getAbsolutePath());
        vits.setDataDir(new File(root, SHARED_PACK).getAbsolutePath());
        OfflineTtsModelConfig model = new OfflineTtsModelConfig();
        model.setVits(vits);
        model.setNumThreads(2);
        OfflineTtsConfig cfg = new OfflineTtsConfig();
        cfg.setModel(model);
        engine = new OfflineTts(null, cfg); // null: archivos del disco, no de assets
        engineId = id;
        return engine;
    }

    private void releaseEngine() {
        if (engine != null) { engine.release(); engine = null; engineId = ""; }
    }

    private void play(short[] pcm, int rate, int mine) {
        AudioTrack t = new AudioTrack.Builder()
            .setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(new AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setBufferSizeInBytes(pcm.length * 2)
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build();
        t.write(pcm, 0, pcm.length);
        t.setNotificationMarkerPosition(pcm.length);
        t.setPlaybackPositionUpdateListener(new AudioTrack.OnPlaybackPositionUpdateListener() {
            @Override public void onMarkerReached(AudioTrack a) { a.release(); }
            @Override public void onPeriodicNotification(AudioTrack a) { }
        });
        synchronized (this) {
            if (mine != ticket.get()) { t.release(); return; }
            track = t;
        }
        t.play();
    }

    void stopTrack() {
        AudioTrack t;
        synchronized (this) { t = track; track = null; }
        if (t != null) {
            try { t.pause(); t.flush(); t.release(); } catch (Exception ignored) { /* ya liberado por el marcador */ }
        }
    }

    void shutdown() {
        ticket.incrementAndGet();
        stopTrack();
        speaker.shutdownNow();
        downloader.shutdownNow();
        synchronized (this) { releaseEngine(); }
    }
}
