# VEAcom yeni nesil — Python sürümüyle eşitlik listesi

Hedef: Python sürümüyle (VEAcom 1.2.1 + 648f099) aynı arayüz, aynı işlevler, aynı davranış.
İşaretler: [x] bitti ve denendi, [~] kısmen, [ ] yapılmadı. Her madde Python sürümündeki
yerini gösterir (app/... dosyası).

## 1. Ana pencere (ui/main_window.py)
- [x] Başlık "VEAcom", koyu tema, Windows başlık çubuğu #2b2b2e, durum çubuğu 20 px
- [x] Araç çubuğu, sırasıyla ve aynı simgeler/ipuçları:
  İçe aktar (Ctrl+O) · CD/DVD'den içe aktar · Dışa aktar (Ctrl+E) · DICOMDIR (Ctrl+Shift+E) ·
  4 fare tuşu (renkli simge + işlev rozeti, menüyle değişir; tekerlekte "Kaydırma yönünü ters çevir") ·
  Sekans adları (deneysel) · Seriler menüsü · Ekran düzeni (5×5 seçici) · Ölçüm (bölünmüş düğme,
  11 araç, sil, birim mm/piksel, kalibrasyon) · Bu kesitteki çizimleri sil · Pencere ön ayarları ·
  PET/BT füzyon · MPR menüsü · Oblik MPR · 3D (deneysel) · Ön tanı (deneysel) · Açıklamalar (F12 menüsü) ·
  Senkronizasyon (2+ hücrede) · Döndür / ayna · Görünümü sıfırla · sol tuş hızlı şeridi (W/L, kaydırma,
  pan, yakınlaştır) · Fare tuşlarını sıfırla · taşma "Diğer düğmeler"
- [x] Boşluk tuşu: imlecin yerinde hızlı menü
- [~] Sol: seri listesi (en çok 140 px); sağ: Ön tanı paneli (en az 300 px, kapatılabilir) — ön tanı şimdilik kapalı (aşağıya bakın)
- [x] Güncelleme çubuğu (GitHub son sürüm, 4 s sonra), Yenilikler penceresi (yalnız kurulu programda; package.json "veacom.releasesRepo")
- [x] Durum çubuğu: durum yazısı, tarama çubuğu (✕ durdur), dışa aktarma çubuğu, yükleme çubuğu, sürüm etiketi
  (sağ tık: Önbelleği temizle), Python'daki tüm durum mesajları
- [x] Açılış ekranı (logo, "DICOM görüntüleyici", sürüm, tıbbi cihaz uyarısı, adımlar)
- [x] Ekran kartı yetmezse uyarı; ek yerine "Yazılımla çiz" (SwiftShader ile yeniden başlar, ek indirmek gerekmez)
- [x] Klasör/dosya/zip tarama (Python ile birebir aynı gruplama; 6 gerçek çalışmada doğrulandı). RAR, saldırı yüzeyi ve lisans nedeniyle bilerek kaldırıldı.
- [x] Pencereye sürükle-bırak (klasör, dosya, zip); CD'deki DICOMDIR → disk içe aktarma
- [x] Dışa aktarma sürerken kapatma sorusu

## 2. Seri listesi (ui/series_browser.py)
- [x] Hasta bandı #132034 (ad kalın, doğum tarihi), çalışma bandı #1a2c45 (tarih saat, açıklama, "CT/MR: N seri")
- [x] Bant katlama (▸), sağ tık menüleri, listeden kaldırma onayları, "Listeyi temizle..."
- [x] Kart: ad (tahmin açıkken display_name), ipucu, 84 px önizleme + sağ altta kesit sayısı, "—", "Görüntü yok",
  CD'de okunmayan seriler "Okunuyor N"
- [x] Tıkla → aktif hücrede aç; Ctrl/Shift çoklu seçim (seçim sırası korunur)
- [x] Sürükle-bırak: tek seri → o hücre; çoklu (en çok 6) → 2:1×2, 3:1×3, 4:2×2, 5-6:2×3, seçim sırasıyla
- [x] Aktif hücrenin serisi #6a6a6a ile vurgulu (liste kaydırılmadan)
- [x] Yeni açılan çalışma listenin başına gelir, önceki çalışmalar sıralarını korur; liste başa kayar

## 3. Izgara (ui/layout_picker.py, ui/grid_view.py)
- [x] 1×1 – 5×5, üzerinde gezinerek seçilen ızgara, "{r} satır × {c} sütun"
- [x] Hücreler arası 2 px, zemin #101010
- [x] Hücre ✕ ("Bu pencereyi kapat"): ızgara daralır; tek hücrede yalnızca boşalır; 3 düzlemde MPR'yi bitirir
- [x] Aktif hücre: tık, tekerlek, sürükleme ile; çerçeve yok (listede vurgulanır)

## 4. Hücre (ui/viewport.py, annotations.py, interaction.py, palettes.py, units.py)
- [x] Fare işlevleri: Kaydır (T), W/L (W), Kesit kaydırma (S), Yakınlaştır (Z), Döndür (R), Ölçüm (M),
  Artı imleç (H), 3D alan seçimi (V), İşlem yok (N); varsayılan sol W/L, sağ zoom, tekerlek kesit, orta pan
- [x] Ctrl+tekerlek yakınlaştırma (×1.1, imleç çevresinde), tekerlekle döndürme 5°, sağ sürükleme yakınlaştırma
- [x] Görüntünün sağ %12'sinde sol sürükleme kesit kaydırır (6 px/kesit); fareyle, tek parmakla ya da kalemle
- [x] Sol alttaki düzlem adına tık: Aksiyel→Koronal→Sagittal
- [x] Dokunmatik: tek parmak sol tuş, iki parmak pan + pinch (dokunmatik ekranda elle denenmedi)
- [x] Tuşlar: Del, Esc, Enter, oklar, PgUp/PgDn ±10; 0 DICOM pencere, Shift+A otomatik, 1–9 ön ayar, I ters,
  D/A/E/F/K/P/O/Y araçlar
- [x] Açılış kesiti: aksiyel üstten, koronal önden, sagittal ortadan
- [x] Köşe yazıları (4 köşe, Python'daki satırlar ve biçimler; hasta bilgisini gizle)
- [x] R/L kenar harfleri (90° dönünce üst/alt; sagittalde yok)
- [x] Ön ayarlar: Varsayılan (DICOM), Otomatik, Tam aralık, BT ön ayarları (2-9), Ters çevir, Renk paleti
  (Gri, Hot Iron, Hot Metal, Rainbow)
- [x] Döndür/ayna (90° ±, yatay, dikey, sıfırla), görünümü sıfırla, hücreye sığdırma
- [x] Kaydırma çubuğu 14 px (aksiyelde ters), yüklenmeyen kesitlere gidilmez
- [x] Artı imleç (H): aynı çalışmanın hücreleri o noktaya, camgöbeği "+"

## 5. Ölçümler (ui/drawings.py)
- [x] Mesafe, Çoklu çizgi, Açı, Cobb, Dikdörtgen/Elips/Çokgen/Serbest ROI (Alan, Ort/SS, Min/Maks, füzyonda SUV),
  Piksel değeri, Ok, Metin; sarı çizim, seçilince parlak; etiket sürüklenebilir + kılavuz çizgisi
- [x] Kesite/düzleme bağlı çizimler; birim mm/piksel; çizgiyle kalibrasyon; ölçümleri gizle

## 6. Senkronizasyon (ui/cursor_sync.py)
- [x] Aynı çalışma aynı düzlem: konuma göre; farklı çalışma: adım adım (koşullu); elle eşleme (mm)
- [x] Turuncu kesişim çizgileri (eğik düzlemler dahil), sürülen hücrede yok, Ctrl+F12

## 7. MPR, 3D, füzyon
- [x] Tek düzlem MPR (koronal/sagittal/aksiyel), 3 düzlem yan yana, düzlem adına tıklayarak geçiş
- [x] Oblik MPR (düzlem renkleri, tutamaçlar, ortak W/L, "Aksiyel (oblik, N°)", ölçümler, dışa aktarma)
- [x] 3D pencere: bölge, eşik (−200…1500 HU, 300), Frez + geri al, görünümü sıfırla, STL kaydet
- [x] 3D alan seçimi (dikdörtgen/elips/serbest; ara kesitler kesik çizgi)
- [x] PET/BT füzyon: eşleştirme, renk skalaları, karışım, opaklık, üst sınır SUV, cihaz görünümü (GE/Siemens),
  Ctrl+sürükleme, SUV/Bq/ml

## 8. Dışa aktarma
- [~] Görüntüleri dışa aktar penceresi (WMV bilerek kaldırıldı; "en küçük boyut" yalnız sıkıştırılmamışları yeniden kodluyor) (kapsamlar, JPEG/PNG/DICOM/MP4, boyut, açıklamalar, kalite, kare hızı,
  anonimleştir, ZIP JPEG-LS, boyut tahmini, klasör adları)
- [x] DICOMDIR penceresi (CD/DVD, USB, klasör, ISO; sıkıştırmayı aç; boyut; doğrulama; yazdırma)

## 9. Diğer
- [x] DICOM etiketleri penceresi
- [x] İçe aktarma penceresi (kenar çubuğu, sabitlenen klasörler)
- [x] CD içe aktarma (sürücü bulma, DICOMDIR'den önce liste, tıklanan önce)
- [x] Önbellek (ağ/CD görüntüleri, 3 gün, 2 GB, boş alanın ¼'ü) ve geçici dosya temizliği
- [x] Resim dosyaları (PNG/JPEG/BMP/TIFF → seri, "Resim dosyası, DICOM değil")
- [x] Sekans adı tahmini (sequence_name.py) ve ADC'yi önizlemeden tanıma
- [x] Seri bölme kuralları (series.py; birebir aynı)
- [~] Ön tanı paneli (bilgi tabanı, ölçüm, sıralama, yapay zekâ; anahtar yalnız ana süreçte) — şimdilik kapalı: bilgi tabanı, lisansı netleşene kadar depoda değil; düğmesi devre dışı ve nedenini söylüyor
- [x] Kalıcı ayarlar (Python'daki anahtarlar ve varsayılanlar)
- [ ] Kendi kendini sınama + özellik turu (32 adım) — yerine `--shot` ile adım adım görüntülü sınama var
- [x] Kurulum paketi (Windows, NSIS, kullanıcı başına: `packaging/` içindeki electron-builder, `electron-builder.release.cjs` ile; çıktı `release-electron/`, komutlar ve imza `docs/electron-updates.md`'de), güncelleyici

## Python'dan bilinen farklar
- Sürüm etiketi v0.1.0 (Next'in kendi sürümü); kurulum adı "VEAcom-Next", ayrı uygulama kimliği ve klasör
  (Python VEAcom'un kurulumuna dokunmaz).
- WMV bilerek kaldırıldı (MP4 var); "En küçük boyut" yalnız sıkıştırılmamış görüntüleri yeniden kodluyor.
- DICOMDIR metinleri ISO_IR 192 (UTF-8) ile yazılıyor.
- Ekran kartı yetmezse ek indirilmiyor; yazılımla çizimle yeniden başlatılıyor.
- Önbellek kodu çözülmüş kesitleri değil, ağdan/CD'den okunan dosyaların kendisini saklıyor (etkisi aynı).
- Kurulum paketi 112 MB (Electron'un kendi boyutu).
- Kendi kendini sınama (--selftest) yerine `--shot DOSYA KLASÖR ADIMLAR` ile görüntüleyerek sınama var.

