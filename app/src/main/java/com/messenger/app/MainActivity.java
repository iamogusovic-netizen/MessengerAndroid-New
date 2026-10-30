package com.messenger.app;

import android.Manifest;
import android.app.Activity;
import android.app.Dialog;
import android.content.ContentUris;
import android.content.pm.PackageManager;
import android.app.DownloadManager;
import android.content.Context;
import android.os.Environment;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.content.res.ColorStateList;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.Set;

public class MainActivity extends Activity {
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private static final String MESSENGER_URL = "http://89.125.121.18";
    private static final int REQ_MEDIA = 704;
    private boolean waitingForGallery = false;
    private boolean fileChooserAllowsMultiple = false;

    @Override public void onCreate(Bundle b) {
        super.onCreate(b);
        // Не меняем системную тему Android. Панели приложения остаются тёмными,
        // чтобы запуск WebView не создавал впечатление переключения темы.
        getWindow().setStatusBarColor(Color.rgb(18, 18, 22));
        getWindow().setNavigationBarColor(Color.rgb(18, 18, 22));
        getWindow().getDecorView().setSystemUiVisibility(0);
        webView = new WebView(this); setContentView(webView);
        WebSettings s = webView.getSettings(); s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setDatabaseEnabled(true); s.setLoadWithOverviewMode(true); s.setUseWideViewPort(true); s.setAllowFileAccess(false); s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        // Не позволяем системной тёмной теме Android перекрашивать сайт.
        if (Build.VERSION.SDK_INT >= 33) s.setAlgorithmicDarkeningAllowed(false);
        if (Build.VERSION.SDK_INT >= 29) s.setForceDark(WebSettings.FORCE_DARK_OFF);
        CookieManager cm = CookieManager.getInstance(); cm.setAcceptCookie(true); cm.setAcceptThirdPartyCookies(webView, true);
        webView.setWebViewClient(new WebViewClient());
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> downloadFile(url, userAgent, contentDisposition, mimeType));
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback; fileChooserAllowsMultiple = params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE; requestGalleryAccess(); return true;
            }
        });
        // Всегда загружаем сайт с сервера при запуске приложения,
        // чтобы получать последние версии интерфейса без пересборки APK.
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        webView.loadUrl(MESSENGER_URL);
    }

    private void requestGalleryAccess() {
        String[] perms;
        if (Build.VERSION.SDK_INT >= 34) perms = new String[]{Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED};
        else if (Build.VERSION.SDK_INT >= 33) perms = new String[]{Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO};
        else perms = new String[]{Manifest.permission.READ_EXTERNAL_STORAGE};
        ArrayList<String> missing = new ArrayList<>();
        for (String p : perms) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) missing.add(p);
        if (!missing.isEmpty()) { waitingForGallery = true; requestPermissions(missing.toArray(new String[0]), REQ_MEDIA); }
        else showGallery();
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_MEDIA && waitingForGallery) {
            waitingForGallery = false;
            boolean granted = false;
            for (String permission : permissions) {
                if (checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) { granted = true; break; }
            }
            if (granted) showGallery();
            else { Toast.makeText(this, "Разреши доступ к фото и видео, чтобы открыть галерею", Toast.LENGTH_LONG).show(); finishFileChooser((Uri[]) null); }
        }
    }

    // Скачивание файлов из WebView в системную папку «Загрузки».
    // Android сам показывает уведомление о ходе загрузки; доступ ко всему хранилищу не нужен.
    private void downloadFile(String url, String userAgent, String contentDisposition, String mimeType) {
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
            request.setTitle(fileName);
            request.setDescription("Загрузка из Мессенджера");
            request.setMimeType(mimeType);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) request.addRequestHeader("Cookie", cookies);
            if (userAgent != null) request.addRequestHeader("User-Agent", userAgent);
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(true);
            DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager != null) {
                manager.enqueue(request);
                Toast.makeText(this, "Файл скачивается в папку «Загрузки»", Toast.LENGTH_LONG).show();
            } else Toast.makeText(this, "Не удалось запустить загрузку", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Toast.makeText(this, "Ошибка загрузки файла", Toast.LENGTH_LONG).show();
        }
    }

    private void showGallery() {
        if (fileCallback == null) return;
        final boolean allowMultiple = fileChooserAllowsMultiple;
        final Dialog dialog = new Dialog(this);
        final Set<Uri> selected = new LinkedHashSet<>();
        final ArrayList<MediaItem> allItems = loadMedia();
        final LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(0, 0, 0, dp(8));
        root.setBackground(roundBg(0xFF17171D, 22));

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(18), dp(14), dp(12), dp(12));
        LinearLayout titles = new LinearLayout(this);
        titles.setOrientation(LinearLayout.VERTICAL);
        titles.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
        TextView title = new TextView(this);
        title.setText("Галерея");
        title.setTextColor(Color.WHITE);
        title.setTextSize(19);
        title.setTypeface(null, Typeface.BOLD);
        TextView subtitle = new TextView(this);
        subtitle.setText("Выбери фото и видео");
        subtitle.setTextColor(0xFFAAAAB0);
        subtitle.setTextSize(12);
        titles.addView(title);
        titles.addView(subtitle);
        TextView close = new TextView(this);
        close.setText("✕");
        close.setTextSize(21);
        close.setTextColor(Color.WHITE);
        close.setGravity(Gravity.CENTER);
        close.setBackground(roundBg(0xFF303039, 30));
        close.setLayoutParams(new LinearLayout.LayoutParams(dp(40), dp(40)));
        close.setOnClickListener(v -> { dialog.dismiss(); finishFileChooser((Uri[]) null); });
        header.addView(titles);
        header.addView(close);
        root.addView(header);

        LinearLayout tabs = new LinearLayout(this);
        tabs.setPadding(dp(12), dp(4), dp(12), dp(10));
        root.addView(tabs);
        android.widget.ScrollView scroll = new android.widget.ScrollView(this);
        LinearLayout grid = new LinearLayout(this);
        grid.setOrientation(LinearLayout.VERTICAL);
        grid.setPadding(dp(5), dp(5), dp(5), dp(12));
        scroll.addView(grid);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));

        LinearLayout footer = new LinearLayout(this);
        footer.setGravity(Gravity.CENTER_VERTICAL);
        footer.setPadding(dp(16), dp(10), dp(16), dp(8));
        TextView count = new TextView(this);
        count.setTextColor(0xFFE4E4EA);
        count.setTextSize(13);
        count.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
        TextView send = new TextView(this);
        send.setText("Отправить");
        send.setTextColor(Color.WHITE);
        send.setTextSize(14);
        send.setTypeface(null, Typeface.BOLD);
        send.setGravity(Gravity.CENTER);
        send.setPadding(dp(20), dp(11), dp(20), dp(11));
        send.setBackground(roundBg(0xFF6657D9, 24));
        footer.addView(count);
        footer.addView(send);
        root.addView(footer);

        final String[] activeFilter = {"Все"};
        Runnable[] render = new Runnable[1];
        render[0] = () -> {
            grid.removeAllViews();
            ArrayList<MediaItem> visible = new ArrayList<>();
            for (MediaItem item : allItems) {
                if ("Фото".equals(activeFilter[0]) && item.video) continue;
                if ("Видео".equals(activeFilter[0]) && !item.video) continue;
                visible.add(item);
            }
            count.setText(allowMultiple ? "Выбрано: " + selected.size() : "Выбери один файл");
            send.setAlpha(selected.isEmpty() ? 0.45f : 1f);
            if (visible.isEmpty()) {
                TextView empty = new TextView(this);
                empty.setText("Медиа не найдено или доступ не предоставлен.");
                empty.setTextColor(0xFFB7B7C0);
                empty.setGravity(Gravity.CENTER);
                empty.setPadding(dp(20), dp(35), dp(20), dp(35));
                grid.addView(empty);
            }
            int cols = 3;
            for (int i = 0; i < visible.size(); i += cols) {
                LinearLayout row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                for (int j = i; j < Math.min(i + cols, visible.size()); j++) {
                    MediaItem item = visible.get(j);
                    FrameLayout cell = new FrameLayout(this);
                    LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(0, dp(116), 1);
                    cp.setMargins(dp(3), dp(3), dp(3), dp(3));
                    cell.setLayoutParams(cp);
                    ImageView image = new ImageView(this);
                    image.setScaleType(ImageView.ScaleType.CENTER_CROP);
                    image.setImageURI(item.uri);
                    image.setBackground(roundBg(0xFF303039, 8));
                    cell.addView(image, new FrameLayout.LayoutParams(-1, -1));
                    if (item.video) {
                        TextView badge = new TextView(this);
                        badge.setText("▶ ВИДЕО");
                        badge.setTextSize(10);
                        badge.setTextColor(Color.WHITE);
                        badge.setPadding(dp(5), dp(3), dp(5), dp(3));
                        badge.setBackground(roundBg(0xAA000000, 5));
                        FrameLayout.LayoutParams bp = new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.START);
                        bp.setMargins(dp(5), 0, 0, dp(5));
                        cell.addView(badge, bp);
                    }
                    boolean isSelected = selected.contains(item.uri);
                    if (isSelected) {
                        View shade = new View(this);
                        shade.setBackground(roundBg(0x776657D9, 8));
                        cell.addView(shade, new FrameLayout.LayoutParams(-1, -1));
                        TextView tick = new TextView(this);
                        tick.setText("✓");
                        tick.setTextColor(Color.WHITE);
                        tick.setTextSize(18);
                        tick.setTypeface(null, Typeface.BOLD);
                        tick.setGravity(Gravity.CENTER);
                        tick.setBackground(roundBg(0xFF6657D9, 18));
                        FrameLayout.LayoutParams tp = new FrameLayout.LayoutParams(dp(28), dp(28), Gravity.TOP | Gravity.END);
                        tp.setMargins(0, dp(5), dp(5), 0);
                        cell.addView(tick, tp);
                    }
                    cell.setOnClickListener(v -> {
                        if (!allowMultiple) {
                            selected.clear();
                            selected.add(item.uri);
                            dialog.dismiss();
                            finishFileChooser(item.uri);
                        } else {
                            if (!selected.add(item.uri)) selected.remove(item.uri);
                            render[0].run();
                        }
                    });
                    row.addView(cell);
                }
                while (row.getChildCount() < cols) row.addView(new View(this), new LinearLayout.LayoutParams(0, dp(116), 1));
                grid.addView(row);
            }
        };

        String[] labels = {"Все", "Фото", "Видео"};
        for (String label : labels) {
            TextView tab = new TextView(this);
            tab.setText(label);
            tab.setTextSize(13);
            tab.setGravity(Gravity.CENTER);
            tab.setPadding(dp(16), dp(9), dp(16), dp(9));
            tab.setTextColor(Color.WHITE);
            tab.setBackground(roundBg(0xFF303039, 20));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
            lp.setMargins(0, 0, dp(8), 0);
            tabs.addView(tab, lp);
            tab.setOnClickListener(v -> {
                activeFilter[0] = label;
                for (int k = 0; k < tabs.getChildCount(); k++)
                    tabs.getChildAt(k).setBackground(roundBg(labels[k].equals(label) ? 0xFF6657D9 : 0xFF303039, 20));
                render[0].run();
            });
        }
        tabs.getChildAt(0).setBackground(roundBg(0xFF6657D9, 20));
        send.setOnClickListener(v -> {
            if (selected.isEmpty()) return;
            Uri[] result = selected.toArray(new Uri[0]);
            dialog.dismiss();
            finishFileChooser(result);
        });
        render[0].run();

        dialog.setContentView(root);
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawableResource(android.R.color.transparent);
            window.setLayout(-1, (int) (getResources().getDisplayMetrics().heightPixels * 0.78));
            window.setGravity(Gravity.BOTTOM);
            window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            WindowManager.LayoutParams attrs = window.getAttributes();
            attrs.dimAmount = 0.38f;
            window.setAttributes(attrs);
        }
        dialog.setOnCancelListener(d -> finishFileChooser((Uri[]) null));
        dialog.show();
        if (window != null) window.setLayout(-1, (int) (getResources().getDisplayMetrics().heightPixels * 0.78));
    }

    private ArrayList<MediaItem> loadMedia() {
        ArrayList<MediaItem> out = new ArrayList<>();
        Uri images = MediaStore.Images.Media.EXTERNAL_CONTENT_URI, videos = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
        String[] projection = {MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DATE_ADDED};
        loadCollection(out, images, projection, false); loadCollection(out, videos, projection, true);
        java.util.Collections.sort(out, (a,b) -> Long.compare(b.date, a.date)); return out;
    }
    private void loadCollection(ArrayList<MediaItem> out, Uri base, String[] projection, boolean video) {
        Cursor c=null; try { c=getContentResolver().query(base,projection,null,null,MediaStore.MediaColumns.DATE_ADDED+" DESC"); if(c!=null) while(c.moveToNext()) { long id=c.getLong(0), date=c.getLong(1); out.add(new MediaItem(ContentUris.withAppendedId(base,id),date,video)); } } catch(Exception ignored) {} finally { if(c!=null)c.close(); }
    }
    private void finishFileChooser(Uri uri) { finishFileChooser(uri == null ? (Uri[]) null : new Uri[]{uri}); }
    private void finishFileChooser(Uri[] uris) {
        if (fileCallback != null) {
            ValueCallback<Uri[]> cb = fileCallback;
            fileCallback = null;
            cb.onReceiveValue(uris);
        }
    }
    private GradientDrawable roundBg(int color, int radius) { GradientDrawable d=new GradientDrawable(); d.setColor(color); d.setCornerRadius(dp(radius)); return d; }
    private int dp(float n) { return (int)(n*getResources().getDisplayMetrics().density+0.5f); }
    private static class MediaItem { Uri uri; long date; boolean video; MediaItem(Uri u,long d,boolean v){uri=u;date=d;video=v;} }
    @Override public void onBackPressed(){ if(webView!=null&&webView.canGoBack())webView.goBack(); else super.onBackPressed(); }
    @Override protected void onSaveInstanceState(Bundle b){ if(webView!=null)webView.saveState(b); super.onSaveInstanceState(b); }
    @Override protected void onDestroy(){ if(fileCallback!=null)finishFileChooser((Uri[]) null); if(webView!=null){webView.destroy();webView=null;} super.onDestroy(); }
}
