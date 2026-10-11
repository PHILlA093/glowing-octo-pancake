package com.philia.nuanyu;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.util.Log;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 暖屿原生桥。
 *
 * 网页层负责 UI，这里只做网页做不到的三件事：
 *   1) 语音识别 —— 系统 SpeechRecognizer，免 Key，中文由系统引擎提供
 *   2) 语音播报 —— 系统 TextToSpeech
 *   3) 流式聊天 —— HttpURLConnection 逐行读 SSE，绕开 WebView 的 CORS，
 *      并做到真正逐字上屏
 *
 * 与 JS 的约定：
 *   暴露 window.NuanyuNative；
 *   事件统一走 window.__nuanyu._on(jsonString)，
 *   形如 {"id":"reqId","type":"delta|done|error|asr_*","text":"...","meta":{}}
 */
public class MainActivity extends BridgeActivity {

    private static final String TAG = "Nuanyu";
    private static final int REQ_AUDIO = 4101;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, AtomicBoolean> cancels = new ConcurrentHashMap<>();

    private WebView web;

    private SpeechRecognizer sr;
    private String pendingLang = "zh-CN";
    private boolean wantListening = false;
    private final StringBuilder lastHeard = new StringBuilder();

    private TextToSpeech tts;
    private volatile boolean ttsReady = false;

    /* ============================================================
     * 生命周期
     * ============================================================ */
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            if (getBridge() != null) web = getBridge().getWebView();
            if (web != null) {
                web.addJavascriptInterface(new JsApi(), "NuanyuNative");
                Log.i(TAG, "NuanyuNative 已注入");
            } else {
                Log.e(TAG, "拿不到 WebView，原生能力不可用");
            }
        } catch (Throwable t) {
            Log.e(TAG, "注入失败", t);
        }
        applyBarColors(false);
        initTts();
    }

    /* ============================================================
     * 状态栏 / 导航栏跟应用配色走
     * 默认主题下这里是灰的，跟暖色页面接不上；夜间模式再切回深色。
     * 由网页在 applyTheme() 里调用 setNightMode() 保持同步。
     * ============================================================ */
    private void applyBarColors(boolean night) {
        try {
            int bg = Color.parseColor(night ? "#15171D" : "#FFF8F2");
            getWindow().setStatusBarColor(bg);
            getWindow().setNavigationBarColor(bg);
            View dv = getWindow().getDecorView();
            int flags = dv.getSystemUiVisibility();
            if (night) {
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                }
            } else {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                }
            }
            dv.setSystemUiVisibility(flags);
        } catch (Throwable t) {
            Log.e(TAG, "setBarColors failed", t);
        }
    }

    @Override
    public void onDestroy() {
        try { if (sr != null) { sr.destroy(); sr = null; } } catch (Throwable t) {}
        try { if (tts != null) { tts.stop(); tts.shutdown(); tts = null; } } catch (Throwable t) {}
        try { pool.shutdownNow(); } catch (Throwable t) {}
        super.onDestroy();
    }

    /* ============================================================
     * 发事件给网页
     * ============================================================ */
    private void emit(JSONObject o) {
        if (web == null) return;
        final String js;
        try {
            js = "window.__nuanyu&&window.__nuanyu._on(" + JSONObject.quote(o.toString()) + ")";
        } catch (Throwable t) { return; }
        ui.post(new Runnable() {
            @Override public void run() {
                try { web.evaluateJavascript(js, null); } catch (Throwable t) {}
            }
        });
    }

    private void emitSimple(String type, String text) {
        try {
            JSONObject o = new JSONObject();
            o.put("type", type);
            o.put("text", text == null ? "" : text);
            emit(o);
        } catch (Throwable t) {}
    }

    /* ============================================================
     * 暴露给 JS 的接口
     * ============================================================ */
    public class JsApi {

        /* ---------- 流式聊天 ---------- */
        @JavascriptInterface
        public void chat(String payloadJson, String reqId) {
            if (reqId == null || reqId.isEmpty()) reqId = "r" + System.currentTimeMillis();
            final AtomicBoolean cancel = new AtomicBoolean(false);
            cancels.put(reqId, cancel);
            final String id = reqId;
            pool.execute(new Runnable() {
                @Override public void run() { doChat(payloadJson, id, cancel); }
            });
        }

        @JavascriptInterface
        public void abort(String reqId) {
            AtomicBoolean c = cancels.get(reqId);
            if (c != null) c.set(true);
        }

        /* ---------- 语音识别 ---------- */
        @JavascriptInterface
        public boolean asrAvailable() {
            try { return SpeechRecognizer.isRecognitionAvailable(MainActivity.this); }
            catch (Throwable t) { return false; }
        }

        @JavascriptInterface
        public void startASR(String lang) {
            pendingLang = (lang == null || lang.trim().isEmpty()) ? "zh-CN" : lang.trim();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                    && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                wantListening = true;
                ui.post(new Runnable() {
                    @Override public void run() {
                        try { requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO); }
                        catch (Throwable t) { emitSimple("asr_error", "要不到麦克风权限。打字也一样，我不着急。"); }
                    }
                });
                return;
            }
            ui.post(new Runnable() { @Override public void run() { startAsrInternal(); } });
        }

        @JavascriptInterface
        public void stopASR() {
            ui.post(new Runnable() {
                @Override public void run() {
                    try { if (sr != null) sr.stopListening(); } catch (Throwable t) {}
                }
            });
        }

        /* ---------- 语音播报 ---------- */
        @JavascriptInterface
        public boolean ttsAvailable() { return ttsReady; }

        @JavascriptInterface
        public void speak(String text, final float rate, final float pitch) {
            if (!ttsReady || text == null || text.trim().isEmpty()) return;
            final String t = text.trim();
            ui.post(new Runnable() {
                @Override public void run() {
                    try {
                        tts.setSpeechRate(rate <= 0 ? 0.92f : rate);
                        tts.setPitch(pitch <= 0 ? 1.0f : pitch);
                        tts.speak(t, TextToSpeech.QUEUE_FLUSH, null, "nuanyu");
                    } catch (Throwable e) { Log.e(TAG, "speak failed", e); }
                }
            });
        }

        @JavascriptInterface
        public void stopSpeaking() {
            ui.post(new Runnable() {
                @Override public void run() { try { if (tts != null) tts.stop(); } catch (Throwable t) {} }
            });
        }

        /* ---------- 状态栏配色跟随主题 ---------- */
        @JavascriptInterface
        public void setNightMode(final boolean night) {
            ui.post(new Runnable() {
                @Override public void run() { applyBarColors(night); }
            });
        }
    }

    /* ============================================================
     * 语音识别实现
     * ============================================================ */
    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_AUDIO) return;
        boolean ok = grantResults != null && grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (ok && wantListening) {
            ui.post(new Runnable() { @Override public void run() { startAsrInternal(); } });
        } else if (!ok) {
            emitSimple("asr_error", "没拿到麦克风权限。打字也一样，我不着急。");
        }
        wantListening = false;
    }

    private void startAsrInternal() {
        try {
            if (!SpeechRecognizer.isRecognitionAvailable(this)) {
                emitSimple("asr_error", "这台设备没有语音识别。打字也一样，我不着急。");
                return;
            }
            if (sr != null) { try { sr.destroy(); } catch (Throwable t) {} sr = null; }

            lastHeard.setLength(0);
            sr = SpeechRecognizer.createSpeechRecognizer(this);
            sr.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) { emitSimple("asr_ready", ""); }
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float rms) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onEndOfSpeech() {}

                @Override public void onError(int error) {
                    String msg;
                    switch (error) {
                        case SpeechRecognizer.ERROR_NO_MATCH:
                            msg = "没听清。再说一次也行，直接打字也行。"; break;
                        case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                            msg = "没听到声音。什么时候想说都行。"; break;
                        case SpeechRecognizer.ERROR_NETWORK:
                        case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                            msg = "识别服务连不上。打字也一样，我不着急。"; break;
                        case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                            msg = "没拿到麦克风权限。"; break;
                        case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                            msg = "识别服务正忙，等一下再说。"; break;
                        case SpeechRecognizer.ERROR_AUDIO:
                            msg = "录音出了点问题。"; break;
                        default:
                            msg = "识别没成功。没关系，打字也行。"; break;
                    }
                    emitSimple("asr_error", msg);
                }

                @Override public void onResults(Bundle results) {
                    String text = firstOf(results);
                    if (text == null || text.isEmpty()) text = lastHeard.toString();
                    try {
                        JSONObject o = new JSONObject();
                        o.put("type", "asr_final");
                        o.put("text", text == null ? "" : text);
                        emit(o);
                    } catch (Throwable t) {}
                }

                @Override public void onPartialResults(Bundle partialResults) {
                    String text = firstOf(partialResults);
                    if (text == null || text.isEmpty()) return;
                    lastHeard.setLength(0);
                    lastHeard.append(text);
                    try {
                        JSONObject o = new JSONObject();
                        o.put("type", "asr_partial");
                        o.put("text", text);
                        emit(o);
                    } catch (Throwable t) {}
                }

                @Override public void onEvent(int eventType, Bundle params) {}
            });

            Intent it = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            it.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            it.putExtra(RecognizerIntent.EXTRA_LANGUAGE, pendingLang);
            it.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            it.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            it.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
            sr.startListening(it);
        } catch (Throwable t) {
            Log.e(TAG, "startAsr failed", t);
            emitSimple("asr_error", "启动识别失败。打字也一样。");
        }
    }

    private String firstOf(Bundle b) {
        if (b == null) return null;
        try {
            ArrayList<String> list = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (list != null && !list.isEmpty()) return list.get(0);
        } catch (Throwable t) {}
        return null;
    }

    /* ============================================================
     * 语音播报实现
     * ============================================================ */
    private void initTts() {
        try {
            tts = new TextToSpeech(getApplicationContext(), new TextToSpeech.OnInitListener() {
                @Override public void onInit(int status) {
                    if (status != TextToSpeech.SUCCESS) { ttsReady = false; return; }
                    try {
                        int r = tts.setLanguage(Locale.SIMPLIFIED_CHINESE);
                        if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                            tts.setLanguage(Locale.CHINA);
                        }
                        ttsReady = true;
                    } catch (Throwable t) {
                        ttsReady = false;
                    }
                }
            });
        } catch (Throwable t) {
            ttsReady = false;
            Log.e(TAG, "tts init failed", t);
        }
    }

    /* ============================================================
     * 流式聊天实现
     * ============================================================ */
    private void doChat(String payloadJson, String reqId, AtomicBoolean cancel) {
        HttpURLConnection conn = null;
        StringBuilder full = new StringBuilder();
        StringBuilder pending = new StringBuilder();
        long lastFlush = System.currentTimeMillis();

        try {
            JSONObject p = new JSONObject(payloadJson);
            String url = p.optString("url", "https://api.deepseek.com/chat/completions");
            String key = p.optString("apiKey", "");

            JSONArray msgs = p.optJSONArray("messages");
            if (msgs == null) msgs = new JSONArray();

            JSONObject body = new JSONObject();
            body.put("model", p.optString("model", "deepseek-chat"));
            body.put("messages", msgs);
            body.put("stream", true);
            body.put("temperature", p.optDouble("temperature", 1.3));
            body.put("max_tokens", p.optInt("maxTokens", 400));

            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(120000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Accept", "text/event-stream");
            if (!key.isEmpty()) conn.setRequestProperty("Authorization", "Bearer " + key);

            byte[] out = body.toString().getBytes("UTF-8");
            conn.setFixedLengthStreamingMode(out.length);
            OutputStream os = conn.getOutputStream();
            os.write(out);
            os.flush();
            os.close();

            int code = conn.getResponseCode();
            if (code != 200) {
                String err = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
                emitError(reqId, friendlyHttpError(code, err));
                return;
            }

            BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"));
            String line;
            while ((line = br.readLine()) != null) {
                if (cancel.get()) break;
                line = line.trim();
                if (line.isEmpty() || line.charAt(0) == ':') continue;
                if (!line.startsWith("data:")) continue;
                String data = line.substring(5).trim();
                if ("[DONE]".equals(data)) break;

                String piece = extractDelta(data);
                if (piece == null || piece.isEmpty()) continue;

                full.append(piece);
                pending.append(piece);

                long now = System.currentTimeMillis();
                if (pending.length() >= 6 || now - lastFlush > 60) {
                    flushDelta(reqId, pending.toString());
                    pending.setLength(0);
                    lastFlush = now;
                }
            }
            try { br.close(); } catch (Throwable t) {}

            if (pending.length() > 0) {
                flushDelta(reqId, pending.toString());
                pending.setLength(0);
            }

            if (!cancel.get()) {
                JSONObject o = new JSONObject();
                o.put("id", reqId);
                o.put("type", "done");
                o.put("text", full.toString());
                JSONObject meta = new JSONObject();
                meta.put("channel", "native");
                o.put("meta", meta);
                emit(o);
            }
        } catch (Throwable t) {
            Log.e(TAG, "chat failed", t);
            if (!cancel.get()) emitError(reqId, "网络没通：" + shortMsg(t));
        } finally {
            cancels.remove(reqId);
            if (conn != null) { try { conn.disconnect(); } catch (Throwable t) {} }
        }
    }

    private void flushDelta(String reqId, String piece) {
        if (piece == null || piece.isEmpty()) return;
        try {
            JSONObject o = new JSONObject();
            o.put("id", reqId);
            o.put("type", "delta");
            o.put("text", piece);
            emit(o);
        } catch (Throwable t) {}
    }

    private void emitError(String reqId, String msg) {
        try {
            JSONObject o = new JSONObject();
            o.put("id", reqId);
            o.put("type", "error");
            o.put("text", msg);
            emit(o);
        } catch (Throwable t) {}
    }

    /** 从一行 SSE data 里取出增量文本 */
    private String extractDelta(String data) {
        try {
            JSONObject j = new JSONObject(data);
            JSONArray ch = j.optJSONArray("choices");
            if (ch == null || ch.length() == 0) return null;
            JSONObject c0 = ch.optJSONObject(0);
            if (c0 == null) return null;
            JSONObject d = c0.optJSONObject("delta");
            if (d == null) return null;
            return d.optString("content", "");
        } catch (Throwable t) {
            return null;   // 半个 JSON，丢掉即可
        }
    }

    private String readAll(InputStream in) {
        if (in == null) return "";
        try {
            BufferedReader br = new BufferedReader(new InputStreamReader(in, "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String l;
            while ((l = br.readLine()) != null && sb.length() < 600) sb.append(l);
            br.close();
            return sb.toString();
        } catch (Throwable t) { return ""; }
    }

    /** 把接口报错翻译成人话，别把 4xx 原样糊到用户脸上 */
    private String friendlyHttpError(int code, String body) {
        String hint = body == null ? "" : body;
        if (hint.length() > 160) hint = hint.substring(0, 160);
        switch (code) {
            case 401:
            case 403:
                return "Key 不对或没权限（" + code + "）";
            case 402:
                return "账户余额不够了（402）";
            case 404:
                return "接口地址不对（404），检查设置里的地址";
            case 429:
                return "请求太频繁了，缓一下（429）";
            default:
                if (code >= 500) return "服务端出错（" + code + "）";
                return "接口返回 " + code + "：" + hint;
        }
    }

    private String shortMsg(Throwable t) {
        String m = t.getMessage();
        if (m == null) m = t.getClass().getSimpleName();
        return m.length() > 60 ? m.substring(0, 60) : m;
    }
}
