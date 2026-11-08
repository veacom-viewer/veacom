# Tarayıcıda VEAcom: ilk prototip

7–8 Kasım 2026. Yerel dal `local/web-prototype`; hiçbir yere gönderilmedi. Ölçümlerde yalnız sentetik ya da açık lisanslı çalışmalar kullanıldı: `PETCT_8fea5f0537`, `bigct`, `demo\Calisma.zip`; kod çözücüler için ayrıca `bigct`'nin kayıpsız sıkıştırılmış kopyaları `bigct_j2k` ve `bigct_jpegll`.

## Kısaca

- Motorun içe aktarma ve kesit çözme kodu WebAssembly'ye derlendi ve tarayıcıda çalıştı. Üç çalışmada seri sayıları, adları ve görüntü sayıları masaüstüyle aynı çıktı.
- Görüntüler bilgisayardan çıkmıyor. Dosyalar diske kopyalanmıyor, `File.slice()` ile parça parça okunuyor.
- Tek iş parçacığında seri listesi masaüstünden 5–15 kat geç geliyor. Bu sürenin %80–90'ı hesapta değil, tarayıcının dosya okumasında geçiyor.
- Dosya başlarını önceden ve aynı anda okumak bu süreyi yaklaşık yarıya indiriyor. Bunun için SharedArrayBuffer gerekmiyor.
- ZIP, büyük okuma parçalarıyla masaüstüne yakın sürede açılıyor.
- Tüm seriyi çözmek (hacim) tek iş parçacığında masaüstünün 2–2,5 katı sürüyor. İş parçacıkları asıl burada fark yaratır.
- 8 Kasım: site https://viewer.veacom.app/ adresinde yayında. Açma, 4 iş parçacığı ve dışa aktarma gerçek adreste de denendi.
- 8 Kasım: ilk görüntü 0,4–0,8 saniyede geliyor; PlexusMD ile aynı ya da daha erken. Motor tek iş parçacığında %35–45 daha hızlı, pikseller aynı.
- 8 Kasım: seri artık en fazla 4 iş parçacığında çözülüyor. JPEG 2000 serisi 5,5 saniye yerine 2 saniyede, sıkıştırılmamış seriler 2 saniye yerine 0,5–0,7 saniyede yükleniyor. Pikseller tek iş parçacığındakiyle bit bit aynı.
- JPEG 2000 ve JPEG Lossless tarayıcıda bit bit doğru çözülüyor: 400 kesitin hepsi sıkıştırılmamış kopyayla aynı çıktı. JPEG 2000 için openjp2'deki bir hata yüzünden küçük bir düzeltme gerekti.
- Zararlı dosyalar sayfaya ve kullanıcıya zarar veremiyor. Sayfa yalnız kendi kodunu çalıştırıyor, yalnız kendi sitesine bağlanabiliyor, dosyadaki yazıyı HTML olarak kullanmıyor. 247 bozuk ve kötü niyetli dosya denendi; hiçbiri motoru çökertmedi, kod çalıştıramadı, sayfayı kilitleyemedi.
- 8 Kasım: masaüstünün arayüzünün kendisi tarayıcıda çalışıyor (`web.html`). Diskten bırakılan Calisma.zip 2,5–3 saniyede listelendi, ilk görüntü hemen ardından geldi. Masaüstü ekran boyutlarının ve ölçeklerinin hepsinde düzgün görünüyor.

## Gerçek arayüz tarayıcıda (8 Kasım)

Masaüstü uygulamasının arayüzü (`src/`) değişmeden tarayıcıda çalışıyor. Arayüz motorla yalnız `window.veacom` köprüsü üzerinden konuşuyor; bu köprünün tarayıcı karşılığı yazıldı.

**Yapı:**
- `web.html` ve `src/web/main.ts`: tarayıcının giriş sayfası. Önce güvenlik kuralını kuruyor, sonra köprüyü, sonra masaüstündeki uygulamanın aynısını açıyor.
- `src/web/bridge.ts`: `window.veacom`'un tarayıcı karşılığı. Masaüstündeki gibi çalışıyor:
  - Seçilen dosyalar tek kullanımlık bir izin olarak arayüze veriliyor.
  - Seriler hangi motora ait olduklarını taşıyor.
  - Motor çökerse yenisi bir sonraki numarayla başlıyor ve arayüzün kendi kurtarma yolu devreye giriyor.
- `src/web/engine.worker.ts`: motor bir Web Worker'da. İstekler sırayla işleniyor, masaüstü motorunun iş sırası gibi.
- `web/engine/src/session.rs`: tarayıcı oturumu. Masaüstü sunucusundaki katalog sınırları, hacim önbelleği (256 MiB), kaldırma, kesitin kimliği ve etiketler aynı.
- **İlerleme ve iptal:** Çalışan motor ileti alamıyor. Bu yüzden motor dosya okudukça ilerlemesini sayfaya kendisi gönderiyor. Sayfa iptal için ortak bellekteki bir işareti kuruyor, motor bunu görünce kendi iptal yolunu çağırıyor. Motor 8 saniyede durmazsa yenisiyle değiştiriliyor.
- **Klasör bırakma:** Tarayıcıda bırakılan bir klasörün içi yalnız bırakma anında okunabiliyor. Köprü bunu arayüzün kendi bırakma işleyicisinden önce alıyor; arayüzde değişiklik gerekmedi.

**Arayüzde değişen üç küçük şey** (masaüstünü etkilemiyor):
- `api.ts`: tarayıcı köprüsü pikselleri `veacom://` adresi yerine doğrudan yanıt olarak veriyor. Köprüde `fetchPixels` varsa o kullanılıyor.
- `model.ts`: köprüye `web` ve `fetchPixels` alanları eklendi.
- `main.tsx`: başlık çubuğu ayarı yalnız masaüstü penceresinde yapılıyor.
- Arayüzün çevirilerine motorun iki iletisi eklendi.

**Güvenlik kuralı:** Arayüz araç çubuğu simgelerini SVG metni olarak ekliyor. Katı politika altında bu engellenirdi. `src/web/trusted-types.ts` yalnız simgelerin biçimine izin veriyor: aynı şekiller, aynı çizim nitelikleri, yalnız sayı ve renk değerleri. Uygulamanın kendi Worker'ları da yalnız sitenin kendi adresinden başlayabiliyor. Arayüz bu kuralla hatasız açılıyor, konsolda tek bir uyarı yok.

**Deneme:**
- Arayüzün 570 testi geçti.
- Diskteki Calisma.zip arayüze bırakıldı: 2,5–3 saniyede 6 seri ve 988 görüntü listelendi, ilk görüntü hemen ardından çizildi. Hasta, çalışma ve seri ağacı, küçük resimler, yönler, pencere değerleri masaüstündeki gibi.
- Gizli bir Electron penceresinde, DevTools'un sürükleme olaylarıyla gerçek bir bırakma yapıldı (`web/tools/app-check.cjs`).

**Ekran boyutları ve yoğunlukları** (`web/tools/viewports.cjs`):

| Ekran | Sonuç |
|---|---|
| 2560×1440, 1920×1080 | Düzgün; görüntü tam çözünürlükte |
| 1920×1080 dizüstü, %125 ve %150 ölçek | Düzgün; görüntü tam çözünürlükte |
| MacBook 1440×900, 2× | Düzgün; görüntü tam çözünürlükte |
| Eski 1366×768 ekran | Düzgün |
| Masaüstünün en küçük penceresi 900×640 | Düzgün |
| Tablet 1024×768 ve dikey 820×1180 | Sığıyor; dokunmayla kullanım sınırlı |
| Telefon 390×844 | Çalışıyor ama sıkışık: araç çubuğunun sağı ekran dışında, durum çubuğunda yazılar üst üste |

- Hiçbir boyutta sayfa taşmıyor, durum çubuğu her yerde görünüyor.
- Görüntü her yoğunlukta (1×, 1,25×, 1,5×, 2×, 3×) ekranın tam çözünürlüğünde çiziliyor.
- Arayüz fare için tasarlanmış: tekerlekle kesit geçme, sağ tuşla sürükleme gibi. Tablette dokunma hareketleri için ayrı iş gerekir. Telefon için ayrı bir yerleşim gerekir.
- Yalnız Chromium'da denendi (Electron 45 ve uygulama içi tarayıcı). Firefox ve Safari denenmedi.

**CD:** Tarayıcı CD sürücüsüne doğrudan erişemiyor. Disk algılama, sürücü listesi ve CD yazma tarayıcıda olmaz. Ama kullanıcı klasör seçicide CD sürücüsünü seçerse ya da sürücüyü sayfaya sürüklerse, CD'deki dosyalar her klasör gibi okunuyor. Motor CD'nin yapısını (DICOMDIR, iç içe klasörler, CD'deki görüntüleyici programın dosyaları) zaten tanıyor. Tarayıcı derlemesinde CD düğmesi klasör seçiciyi açıyor.
- Chrome'un klasik klasör seçicisi "Bu siteye N dosya yüklensin mi?" diye soruyor. Hiçbir şey yüklenmiyor ama ifade yanıltıcı. Chrome ve Edge'de artık `showDirectoryPicker` kullanılıyor; o yalnız "dosyaları görüntüleme" izni istiyor. Firefox ve Safari klasik seçiciyle soru sormadan açıyor. Bu seçici kendi penceresini açtığı için otomatik denenemedi.
- Gerçek bir diskle denenmedi; bu bilgisayarda CD yok.

## PlexusMD ile karşılaştırma (8 Kasım)

viewer.veacom.app ve viewer.plexusmd.org aynı koşullarda ölçüldü: aynı bilgisayar, aynı Chromium (Electron 45), aynı pencere boyutu. Aynı dosyalar diskten aynı yolla bırakıldı. Her çalışma iki kez açıldı; her açılış için yeni bir pencere kullanıldı. Araç: `web/tools/site-timing.cjs`.

- İlk görüntü: sayfanın en büyük çiziminde ilk görüntünün belirdiği an.
- İş bitti: pencerenin işlemleri iki saniye boyunca bir çekirdeğin beşte birinin altında kaldığı an.
- İşlemci: o ana kadar harcanan işlemci süresi (bütün işlemler). Bilgisayarı ne kadar yorduğunu gösteriyor.
- Bellek: pencerenin işlemlerinin en yüksek toplam belleği (ekran kartı işlemi dahil).

| Çalışma | İlk görüntü | İş bitti | İşlemci | En yüksek bellek |
|---|---|---|---|---|
| JPEG 2000, 400 kesit | VEAcom 2,5–2,6 s · PlexusMD 0,7–0,9 s | 3,0–3,1 s · 2,4–2,6 s | 7,8–8,0 s · 6,0–6,1 s | 1,10 GB · 1,27–1,36 GB |
| JPEG Lossless, 400 kesit | 1,7–2,1 s · 0,5–0,6 s | 2,2–2,6 s · 1,9–2,3 s | 3,9–4,6 s · 4,0–4,7 s | 1,12–1,15 GB · 1,21–1,32 GB |
| bigct, sıkıştırılmamış | 2,5–2,6 s · 0,7–1,2 s | 3,0–3,1 s · 2,1–2,9 s | 4,0 s · 2,5–3,1 s | 1,36–1,38 GB · 1,50–1,72 GB |
| PETCT_8fea5f0537 | 1,7–1,8 s · 0,6–0,8 s | 2,6–2,8 s · 1,7–1,9 s | 3,9–4,3 s · 1,9–2,4 s | 1,77–1,79 GB · 1,32–1,46 GB |

Sayfanın kendi açılışı VEAcom'da 0,3–0,4 saniye, PlexusMD'de 0,5–0,7 saniye sürdü (ikinci ziyaretten sonra; ilk ziyarette ikisi de 1 saniye civarı).

Calisma.zip PlexusMD'de açıldı (6 seri). Ama ilk gösterdiği seri koyu bir PET olduğu için araç görüntüyü algılayamadı; bu satır tabloya alınmadı. VEAcom ZIP'i 2,9 saniyede gösterdi, 3,3 saniyede bitirdi.

Sonuçlar:

- **En büyük fark ilk görüntüde.** PlexusMD ortadaki kesiti seri yüklenmeden gösteriyor, 2–3 kat önce. VEAcom tarayıcıda serinin tamamını bekliyor. Sebebi tarayıcı motorunun istekleri sırayla işlemesi: ekrandaki kesitin isteği, serinin çözülmesinin arkasında bekliyor. Masaüstünde motor istekleri aynı anda karşıladığı için bu sorun yok. Kesit isteği sıranın önüne alınırsa ilk görüntü 1 saniyenin altına iner.
- **Serinin tamamı** ikisinde yakın sürede yükleniyor; PlexusMD 0,2–0,9 saniye önde.
- **İşlemci:** JPEG Lossless'ta eşit. JPEG 2000'de VEAcom %30 fazla harcıyor; sıkıştırılmamış ve PET/BT çalışmalarında 1,5–2 kat fazla.
- **Bellek:** dört çalışmanın üçünde VEAcom daha az kullanıyor, PET/BT'de daha çok.
- **Gizlilik:** VEAcom dosyalar bırakıldıktan sonra hiçbir istek göndermedi. PlexusMD sıkıştırılmış serilerde kendi sitesinden 4 dosya indirdi (kod çözücüler), ZIP'te `/api/stats` adresine 171 baytlık bir kullanım bildirimi gönderdi. Boyutundan görüntü olmadığı anlaşılıyor; içeriği incelenmedi.
- **Türkçe karakterler:** PlexusMD hasta adındaki Türkçe harfleri bozuk gösteriyor ("BÃ…YÃ…K"); VEAcom doğru gösteriyor.

### Hız iyileştirmeleri ve yeniden karşılaştırma

Karşılaştırmadan sonra dört değişiklik yapıldı:

1. **İlk kesit sıranın önüne geçiyor.** Arayüz seriyi ve ilk kesitini aynı anda istiyor. Köprü artık istekleri tutup motora tek tek gönderiyor; kesit, liste ya da etiket isteği bekleyen serilerin önüne geçiyor.
2. **Seri arayüze kopyalanmadan geçiyor.** Motorun verdiği bellek iki kez kopyalanıyordu (200 MB'lık bir seride sayfanın kendi zamanından yaklaşık çeyrek saniye). Artık olduğu gibi geçiyor. Seri kartları da bir kez çiziliyor (`main`'deki seri kartı değişikliğiyle).
3. **WebAssembly SIMD ile derleniyor.** Tek iş parçacığında çözme %25–40 daha az işlemci harcıyor.
4. **Piksel değerleri baytlardan doğrudan okunuyor.** Motor 8 ve 16 bitlik her pikseli bir kütüphanede genel bir dönüşümle 64 bitlik sayıya çeviriyordu. Bu dönüşüm, bir BT kesitinin çözme süresinin %62'sini alıyordu. Aynı değerler artık baytlardan okunuyor. Tek iş parçacığında seriler %35–45 daha hızlı çözülüyor. Bu değişiklik ortak motorda; masaüstü de aynı koddan hızlanır.

Pikseller her adımda aynı kaldı: beş deneme çalışmasındaki 11 serinin özeti değişmedi. Motora, 12 bit düzeninde iki yolun aynı değeri verdiğini denetleyen bir test eklendi.

Aynı araçla, PlexusMD ile arka arkaya yeniden ölçüldü (önce VEAcom, sonra PlexusMD):

| Çalışma | İlk görüntü | İş bitti | İşlemci | En yüksek bellek |
|---|---|---|---|---|
| JPEG 2000 | 0,41–0,59 s · 0,54–0,75 s | 2,6 s · 2,2–2,7 s | 7,0–7,3 s · 5,6–5,8 s | 0,87–0,90 GB · 1,29–1,31 GB |
| JPEG Lossless | 0,50–0,53 s · 0,50–0,72 s | 1,6 s · 1,9–2,0 s | 3,1 s · 3,8–3,9 s | 0,92–0,93 GB · 1,27–1,30 GB |
| bigct, sıkıştırılmamış | 0,75–0,81 s · 0,70–0,72 s | 2,2–2,3 s · 2,3 s | 3,0 s · 2,5–2,6 s | 1,13 GB · 1,51–1,70 GB |
| PETCT_8fea5f0537 | 0,57–0,64 s · 0,58–0,71 s | 2,3–2,6 s · 1,7 s | 2,9–3,5 s · 1,9 s | 1,61–1,62 GB · 1,27–1,40 GB |

- İlk görüntü artık PlexusMD ile aynı ya da daha erken (önce 2–3 kat geçti).
- Serinin tamamı JPEG Lossless'ta daha erken, JPEG 2000'de ve sıkıştırılmamış seride aynı sürede, PET/BT'de 0,6–0,9 saniye geç yükleniyor.
- Bellek dört çalışmanın üçünde %25–35 daha az.
- İşlemci JPEG Lossless'ta %20 daha az. JPEG 2000'de %25, sıkıştırılmamış seride %20, PET/BT'de 1,5–1,8 kat daha fazla. PET/BT'deki fark büyük ihtimalle PET'in ondalıklı (float32) yolundan geliyor; ayrıca bakılmalı.

## Yayın (8 Kasım)

Site 8 Kasım'da yayına alındı: https://viewer.veacom.app/

- Siteyi bir Cloudflare Worker sunuyor; veacom.app de böyle yayınlanıyor. Ayarları `web/site/` içinde.
- Sitede yalnız tarayıcı arayüzü ve onun kullandığı dosyalar var: 35 dosya, 10,7 MB. Masaüstünün kendi sayfaları sitede yok. Ziyaretçi motorun iki derlemesinden yalnız birini indiriyor; sıkıştırılmış hali yaklaşık 1,5 MB.
- Her yanıt güvenlik başlıklarıyla gidiyor. Adı içeriğiyle değişen dosyalar (`/assets/`) tarayıcıda bir yıl tutuluyor; ikinci ziyarette motor yeniden inmiyor. Sayfanın kendisi her ziyarette denetleniyor, böylece yeni sürüm herkese hemen ulaşıyor.
- Site yalnız okuma isteklerine yanıt veriyor. Kullanıcının açtığı dosyalar siteye hiç gelmiyor.
- Sekmede VEAcom simgesi görünüyor.

Cloudflare'ın çalışma ortamında (`wrangler dev`) bu bilgisayarda yapılan denemeler:

- Başlıkların hepsi geliyor; sayfa 4 iş parçacığıyla çalışıyor.
- JPEG 2000 serisi 2,2 saniyede yüklendi. Calisma.zip 2,1 saniyede listelendi (6 seri, 988 görüntü).
- DICOM, anonim DICOMDIR, resim ve video dışa aktarması indirme olarak geldi. Anonim dosyaların hiçbirinde hasta adı yok.
- Konsolda hata ya da güvenlik politikası reddi çıkmadı.

247 zararlı dosya da ölçüm sayfasında, iş parçacıklı motorla yeniden denendi. Hiçbiri motoru çökertmedi ya da kilitlemedi, hiçbiri kod çalıştıramadı.

### Bellek geri veriliyor

WebAssembly belleği hiç küçülmüyor. Bu yüzden bütün seriler kapatılınca motor arka planda yenileniyor, tarayıcı da eski motorun belleğini geri alıyor. Arayüz bunu fark etmiyor, bildirim de çıkmıyor. Motor o sırada bir iş yapıyorsa yenileme iş bitince oluyor.

| Sayfanın belleği | Yenilemesiz | Yenilemeyle |
|---|---|---|
| bigct açıkken | 817 MB | 819 MB |
| Liste temizlenince | 766 MB | 314 MB |
| Sonra JPEG 2000 serisi açılınca | 796 MB | 563 MB |

Temizlemeden sonraki ölçüm, tarayıcının çöp toplayıcısı çalıştıktan sonra alındı. Tarayıcı bunu kendiliğinden biraz sonra yapıyor; ilk denemede 20 saniye içinde olmuştu.

### Yayın

Site `wrangler deploy` ile yayına alındı. Yayından yaklaşık 40 saniye sonra adres açıldı.

- Gerçek adreste başlıkların hepsi geliyor. Motor sıkıştırılmış gidiyor: 4,5 MB yerine 1,4 MB.
- Site yalnız okuma isteklerine yanıt veriyor. Masaüstünün sayfaları sitede yok, workers.dev adresi de yok.
- JPEG 2000 serisi 4 iş parçacığıyla 2,2 saniyede yüklendi. Calisma.zip 2,0 saniyede listelendi.
- DICOM, anonim DICOMDIR, resim ve video dışa aktarması indirme olarak geldi. Anonim dosyaların hiçbirinde hasta adı yok.
- Cloudflare, veacom.app'in bütün alanına açık bir ayar yüzünden sayfaya kendi ziyaretçi sayma betiğini ekliyordu. Sayfanın güvenlik kuralı bu betiği engelledi, hiçbir veri gitmedi. Yine de sayfa artık Cloudflare'a değiştirilmemesini söylüyor (`no-transform`); betik eklenmiyor, konsolda hata çıkmıyor.

Yeni bir sürüm aynı komutlarla yayına alınır (`web/README.md`). Sayfa her ziyarette denetlendiği için yeni sürüm herkese hemen ulaşıyor.

Açık kalanlar: Firefox ve Safari denenmedi, telefonda görünüm sıkışık. Kod henüz ortak depoda değil; Ali İhsan görmedi.

## Güvenlik incelemesi (8 Kasım)

Site yayına alındıktan sonra ayrı bir inceleme yapıldı. Kod okundu, yayındaki site yalnız okunarak denetlendi; siteye saldırı denenmedi.

Açılan bir dosyanın, başka bir sitenin ya da bir bağlantının sayfaya kod ya da HTML sokabileceği bir yol bulunmadı. Dosyadaki yazılar her yerde düz yazı olarak gösteriliyor. İçerik güvenlik kuralı ve Trusted Types yayındaki sitede de doğru çalışıyor. Sayfa açılan çalışmalardan hiçbir şeyi bir yere göndermiyor.

Düzeltilenler:

- Düz HTTP ile gelen istek artık HTTPS'e yönleniyor. Güncel tarayıcılar .app adreslerinde zaten HTTPS kullanıyordu; eski istemciler kullanmıyordu.
- Sayfa yalnız `/assets/` altındaki kendi kodunu çalıştırabiliyor. Cloudflare'ın kendi betikleri de sitenin adresinden açılabiliyordu, kural bunlara da izin veriyordu.
- Motor dosyası yeniden doğrulandığında bir yıllık önbelleğini kaybediyordu; artık kaybetmiyor.
- Sayfaya sürüklenen bir bağlantı tarayıcıyı başka sayfaya götürüyor, açık çalışmalar kayboluyordu. Böyle bir bırakma artık reddediliyor.

Açık kalanlar, önem sırasıyla:

1. **Yayın yetkisi tek bilgisayarda.** Site bu bilgisayardan, Cloudflare hesabına bağlı bir oturumla yayınlanıyor. Kod ortak depoda değil; hangi sürümün yayında olduğu da kayıtlı değil. Bu bilgisayar ya da hesap ele geçirilirse site değiştirilebilir ve bunu kimse fark etmez. Öneriler: hesapta donanım anahtarlı iki aşamalı giriş; geniş yetkili oturum yerine yalnız bu siteyi yayınlayabilen bir anahtar; yayının ortak depodaki incelenmiş bir sürümden yapılması; yayındaki dosyaların düzenli olarak denetlenmesi.
2. **JPEG 2000 çözücüsü güvensiz kod içeriyor.** C'den makineyle çevrilmiş; bir hatası zaten bulundu. WebAssembly'deki bir bellek hatası sayfanın dışına çıkamaz, ama motorun belleğindeki başka bir seriyi sessizce bozabilir. Bu raporda "en kötü durumda motor çöker" deniyordu; bu garanti değil. Öneriler: JPEG 2000 dosyalarıyla bulanık test (fuzzing), çözücüyü ayrı bir bellek alanında çalıştırmak.
3. **Düz DICOM dışa aktarmada dosyanın ilk 128 baytı olduğu gibi kopyalanıyor.** İçine program gizlenmiş bir dosya, dışa aktarılan ZIP'e de öyle geçiyor. Kimlik temizlemeli ve sıkıştırmasız dışa aktarma bu baytları sıfırlıyor. Öneri: düz dışa aktarmada da sıfırlamak (ortak motorda).
4. **"Tam" kimlik temizliği bazı alanları bırakıyor:** çalışma ve seri açıklamaları, serbest metin alanları (ör. çalışma nedeni, alerjiler), bazı UID'ler; resim ve videoda çalışma tarihi. Öneri: DICOM'un temel anonimleştirme profiline (PS3.15 Ek E) göre tamamlamak (ortak motor ve arayüz).
5. Takılan bir kesit isteği motoru sayfa yenilenene kadar bekletebilir; isteklerin süre sınırı yok.
6. DICOMDIR alanlarının uzunluğu ve karakterleri denetlenmiyor. Bozuk bir kaynak, katı okuyucuları (PACS, nöronavigasyon) zorlayabilir.

Hesap ayarları da var: Cloudflare'ın hata raporu başlıkları (NEL) ve alan adı kayıtları (CAA, DNSSEC). Ayrıca masaüstü deposundaki `.wrangler` klasörü bu bilgisayarın konum bilgisini içeriyor ve git'te yok sayılmıyor.

## İş parçacıkları (8 Kasım)

Bir seri artık birkaç iş parçacığında çözülüyor. Bilgisayarı yormamak için havuz çekirdeklerin en fazla yarısını alıyor, 4'ten fazlasını hiç almıyor. İş yokken iş parçacıkları uyuyor.

- İki derleme var. `pkg` tek iş parçacıklı; deponun kararlı Rust'ıyla (1.99.1) derleniyor. `pkg-threads` iş parçacıklı; tarihi sabitlenmiş nightly Rust (2026-11-01) ve `-Z build-std` ile derleniyor. Sayfa "cross-origin isolated" ise motor iş parçacıklı derlemeyi, değilse tek iş parçacıklıyı kullanıyor.
- İş parçacıkları belleği paylaşıyor. Bu nightly paylaşılan bellek ayarlarını bağlayıcıya kendisi vermiyor; `build.ps1` bunları elle veriyor.
- Kullanıcının dosyalarını yalnız motorun kendi Worker'ı okuyabiliyor, çünkü bir Blob onu alan Worker'a ait. Bu yüzden bir seri çözülmeden önce serinin dosyaları paylaşılan belleğe bütün olarak okunuyor, çözme bitince bırakılıyor. Bunun bedeli serinin dosyaları kadar ek bellek.
- Bu ek bellek 256 MiB ile sınırlı. Daha büyük bir seri motorun kendi iş parçacığında okuya okuya çözülüyor; bellek yetmediğinde de böyle. O zaman hız ve bellek tek iş parçacıklı derlemeyle aynı.
- İş parçacıkları başlayamazsa motor tek iş parçacıklı derlemeye geçiyor: bir iş parçacığı yüklenemezse hemen, hiçbir yanıt gelmezse 15 saniye sonra. Worker içinden Worker açamayan bir tarayıcıda bu geçiş olmasa sayfa hiç açılmazdı. Claude uygulamasının içindeki tarayıcı böyle; geçiş orada denendi ve doğru sonuç verdi.
- Çözülen pikseller her yolda aynı. JPEG 2000 ve JPEG Lossless serisinin özeti 1, 2 ve 4 iş parçacığında ve sınır aşıldığında aynı çıktı.
- Gerçek arayüz 4 iş parçacığıyla çalıştı. Diskten bırakılan JPEG 2000 serisi 0,25 saniyede listelendi, 2,6 saniyede tamamen yüklendi. Konsolda hata ya da güvenlik politikası reddi çıkmadı.

Tüm seriyi çözme süresi ve sayfanın harcadığı işlemci süresi (bütün iş parçacıkları toplamı). Dosyalar diskten, gizli bir Electron 45 penceresinde açıldı; her çalışma iki tur.

| Seri | 1 iş parçacığı | 2 iş parçacığı | 4 iş parçacığı |
|---|---|---|---|
| JPEG 2000, 400 kesit | 5,3–5,6 s; işlemci 5,6 s | 2,7–2,9 s; işlemci 5,5 s | 1,9–2,1 s; işlemci 6,8–7,7 s |
| JPEG Lossless, 400 kesit | 1,7–1,8 s; işlemci 1,9–2,1 s | 1,1–1,4 s; işlemci 2,0–2,5 s | 0,74–0,76 s; işlemci 2,4 s |
| bigct, sıkıştırılmamış | 2,0–2,6 s; işlemci 1,8 s | 0,90 s; işlemci 1,5 s | 0,69–0,71 s; işlemci 1,5 s |
| PETCT_8fea5f0537 | 1,4–2,0 s; işlemci 1,4 s | 0,55–0,59 s; işlemci 1,0–1,1 s | 0,45–0,58 s; işlemci 1,1–1,3 s |

WebAssembly belleği JPEG 2000'de 219 MB'tan 250 MB'a, bigct'de 419 MB'tan 651 MB'a çıktı. bigct'deki 230 MB fark serinin bellekte tutulan dosyaları.

- 2 iş parçacığı aynı işlemci süresiyle yaklaşık 2 kat hız veriyor.
- 4 iş parçacığı sıkıştırılmış serilerde 1,3–1,4 kat daha hızlı. Buna karşılık toplam işlemci süresi %20–35 artıyor.
- Sıkıştırılmamış serilerde kazancın çoğu iş parçacıklarından değil, her dosyanın tek seferde okunmasından geliyor: 1'den 2'ye 2,2–2,6 kat, 2'den 4'e yalnız 1,3 kat. Aynı okuma tek iş parçacıklı derlemeye ek bellek tutmadan da uygulanabilir. Bu bir hız değişikliği olduğu için sorulmadan yapılmadı.
- Seri listesi ve ilk görüntü süreleri değişmedi. Orada sınır hâlâ dosya okuma.

## Dışa aktarma ve tarayıcıda olmayanlar (8 Kasım)

**Dışa aktarma indirme olarak yapılıyor:**
- **DICOM:** Motor, masaüstündeki dışa aktarmanın aynısını klasör yerine belleğe yapıyor. Sayfa çıkan dosyaları tek bir ZIP olarak indiriyor. Kimlik temizliği (kısmi, tam), DICOMDIR ve sıkıştırmayı açma masaüstündeki gibi.
- **Resimler:** Kesitler masaüstündeki gibi çiziliyor, PNG ya da JPEG olarak tek bir ZIP'te indiriliyor.
- **Video:** Masaüstündeki gibi WebCodecs ile H.264 kodlanıyor. MP4 dosyasını masaüstünün ana süreci yazıyordu (`electron/mp4.cjs`). Tarayıcıda bunun bir karşılığı (`src/web/mp4.ts`) yazıyor; bir test, ikisinin bayt bayt aynı dosyayı yazdığını denetliyor.
- ZIP'ler sıkıştırmasız: DICOM baytları aynen korunuyor, resimler zaten sıkıştırılmış.

**Motorda:** Dışa aktarma (`export.rs`) da dosyalarına artık `vfs` üzerinden yazıyor. Masaüstünde değişen bir şey yok; motorun bütün testleri geçti. Bellekteki dosya sistemine `create_dir`, `remove_file` ve `OpenOptions::new` eklendi. İptal, sayfanın iptal işaretiyle dosyalar arasında duruyor.

**Tarayıcıda olmayanlar gizlendi:** Köprü neyi yapamadığını söylüyor (`features`), arayüz onu gizliyor. Masaüstü köprüsü bir şey söylemediği için masaüstünde her şey olduğu gibi duruyor.
- CD/ISO yazma ve USB'nin köküne yazma: dışa aktarmada hedef seçimi yok, dosya iniyor.
- Dışa aktarma klasörü, "Değiştir" ve "sonra klasörü aç": yok, dosyalar tarayıcının indirilenlerine gidiyor.
- ZIP ile yeniden sıkıştırma (JPEG-LS gerektiriyor): yok.
- Güncelleme denetimi (yardım penceresinde) ve geri bildirim düğmesi: yok.

**Deneme** (`web/tools/export-check.cjs`; diskten bırakılan çalışma, arayüzün kendi dışa aktarma penceresi, inen dosyanın içeriği):

| Dışa aktarma | Süre | Sonuç |
|---|---|---|
| DICOM, PET/CT'nin BT serisi | 7,2 s | 284 dosya, tek ZIP |
| DICOMDIR + kısmi kimlik temizliği | 2,1 s | 285 dosya, DICOMDIR var, hiçbir dosyada hasta adı kalmadı |
| DICOM, Calisma'nın FLAIR serisi | 0,3 s | 30 dosya |
| Resimler (FLAIR, 30 kesit) | 1,9 s | 30 PNG, tek ZIP |
| Video (FLAIR, 15 kare/sn) | 1,6 s | 4,9 MB MP4. Chromium'da oynatıldı: 2 saniye, 2646×1548, 30 karenin hepsi çözüldü |

- Pencerede yalnız tarayıcıda çalışan seçenekler göründü.
- Resim ve video, görüntünün ekrana çizilişinden alınıyor. Gizli bir pencerede tarayıcı çizmediği için bu deneme görünmeyen ama gösterilen, ekran dışı ve odak almayan bir pencerede yapıldı; sayfada kırmızı "TEST PENCERESİ" yazıyor.
- Arayüzün testleri 574 oldu: MP4'ün masaüstüyle aynılığı, ZIP'in geri okunması, güvenlik kuralının 25 simgenin hepsini geçirip 9 tür zararlı biçimlendirmeyi reddetmesi, Worker'ların yalnız siteden başlaması.

**Kalanlar:**
- Dokunmatik hareketler ve telefon yerleşimi.
- Firefox ve Safari denemesi.
- İş parçacıkları.
- Büyük dışa aktarmalar bellekte iki kopya tutuyor (dışa aktarılan dosyalar ve ZIP); çok büyük çalışmalar için ZIP'i parça parça yazmak gerekir.

## Ne yapıldı (prototip, 7 Kasım)

- `web/engine`: `wasm32-unknown-unknown` için wasm-bindgen'li bir crate. İçinde tokio ve axum yok.
- `web/index.html`, `main.js`, `worker.js`: sayfa. Klasör ya da ZIP sürüklenip bırakılabiliyor ya da seçiciyle açılabiliyor. Motor bir Web Worker'da çalışıyor.
  - Solda her serinin küçük resmi üç sütun halinde diziliyor (dar ekranda iki sütun). Görüntü sayısı resmin köşesinde yazıyor.
  - Ortada ilk serinin ortadaki kesiti, serinin varsayılan penceresiyle çiziliyor. Tıklanan seri ortada gösteriliyor.
- `web/serve.mjs`: COOP/COEP başlıklarını veren yerel sunucu. Sayfa bu başlıklarla "cross-origin isolated" oluyor (`crossOriginIsolated` true çıktı).
- `web/tools/measure.cjs`: ekranda görünmeyen, odak almayan bir Electron penceresinde diskteki dosyalarla ölçüm yapıyor.
- `web/tools/hostile.cjs`: aynı gizli pencerede zararlı dosyaları tek tek açıp her birinin sonucunu yazıyor.
- Sayfa uygulama içi tarayıcıda da denendi ve çalıştı.

## Motorun yapısı: çekirdek ve taşıma

İlk prototipte tarayıcı derlemesi motorun üç dosyasının kopyasını, dosya erişimini derleme sırasında değiştirerek kullanıyordu. 8 Kasım'da motor ikiye ayrıldı (çekirdek/taşıma ayrımı):

- **Çekirdek:** `native/` artık bir kütüphane (`veacom_core`): içe aktarma, kod çözme, etiketler, ölçüm, dışa aktarma.
- **Masaüstü taşıması:** Masaüstünün HTTP sunucusu (`main.rs`) bu kütüphanenin üstünde çalışıyor. Oturum, iş sıraları, iptal ve yollar olduğu gibi kaldı; `main.rs`'te yalnız modül bildirimleri değişti.
- **Dosya erişimi:** Motor dosyaları tek bir yerden (`vfs`) okuyor. Masaüstünde bu, bilgisayarın kendi dosya sistemi. WebAssembly'de `memory_fs`: sayfanın verdiği dosyalar okunabilir kaynaklar olarak listeleniyor, ZIP'ten çıkanlar bellekte tutuluyor. `memory_fs` düz Rust ve masaüstünde de testleri var.
- **Özellikler:** Sunucu (`server`) ve C ile yazılmış kod çözücüler (`native-codecs`) varsayılan olarak açık. Tarayıcı derlemesi ikisini de kapatıp JPEG 2000 için saf Rust çözücüyü açıyor.
- **Sınırlar:** WebAssembly'de piksel, hacim ve ZIP sınırları düşük (aşağıda "Güvenlik"). Masaüstünün sınırları ve hata yazıları aynı.
- **Tarayıcı taşıması:** `web/engine` motoru kütüphane olarak kullanıyor. İçinde yalnız Blob okuma (`blob.rs`), Worker'ın çağırdığı işlevler (`api.rs`), openjp2 için C kütüphanesi karşılıkları (`libc_shim.rs`) ve bellek katmanı (`allocator.rs`) kaldı. Kopyalar ve `build.rs` kaldırıldı.

**Masaüstünün değişmediği şöyle doğrulandı:**
- Masaüstü derlemesi önceki gibi 117 paketi tam aynı özelliklerle kullanıyor (`cargo tree` ile karşılaştırıldı). `native/Cargo.lock` değişmedi.
- `cargo test --release` geçti: kütüphanede 181, sunucuda 11 test. Testlerin hepsi yerinde; 2'si yeni, 2'si yalnız Unix'te çalışıyor.
- CI'ın zorunlu clippy denetimi (engelleyen iş yalnız sıralardan) geçti. Yeni dosyalar rustfmt ve clippy uyarısı vermiyor.

**Tarayıcıda da aynı sonuç alındı:** bigct'nin JPEG 2000, JPEG Lossless ve sıkıştırılmamış kopyaları yine aynı özeti verdi, Calisma.zip yine 6 seri açtı. 247 zararlı dosyanın sonuçları da aynı çıktı.

**Yeni bağımlılık adları:** Tarayıcı derlemesinin kilit dosyası dört yeni ad getiriyor; `tools/dependency-names.txt` listesine eklendiler:

| Ad | Yayımlayan | Neden |
|---|---|---|
| `web-sys` | wasm-bindgen ekibi (`wasm-bindgen` ile aynı) | Blob ve FileReaderSync |
| `console_error_panic_hook` | rustwasm (Alex Crichton, Nick Fitzgerald) | Motorun hata iletisi tarayıcı konsoluna |
| `openjp2` | Neopallium (listedeki `jpeg2k`'nın yazarı) | Saf Rust JPEG 2000 |
| `sprintf` | Thomas Jollans | `openjp2`'nin bağımlılığı |

**Kod çözücüler:**

| Biçim | Durum |
|---|---|
| JPEG baseline ve lossless (jpeg-decoder) | Değişiklik olmadan derlendi; JPEG Lossless veriyle doğrulandı |
| RLE | Değişiklik olmadan derlendi; veriyle denenmedi |
| JPEG 2000 | `openjpeg-sys` yerine saf Rust `openjp2` ile derlendi; veriyle doğrulandı (aşağıya bakın) |
| JPEG-LS (charls, C) | Dışarıda bırakıldı; bu dosyalar "desteklenmeyen sıkıştırma" hatası verir |

`openjp2`, OpenJPEG'in C'den makineyle çevrilmiş hali. Hâlâ C kütüphanesinden `malloc`, `free`, `strlen` gibi işlevler çağırıyor. WebAssembly'de C kütüphanesi olmadığından bunlar `web/engine/src/libc_shim.rs` içinde Rust ile yazıldı. `openjp2` kendi başına da bağlanmaya çalıştığı için bağlayıcıya `--allow-undefined` verildi; `web/build.ps1` sonuçta çözülmemiş bir işlev kalmadığını denetliyor.

**Kod çözücülerin doğrulanması:** `bigct_j2k` (JPEG 2000 kayıpsız, 1.2.840.10008.1.2.4.90) ve `bigct_jpegll` (JPEG Lossless, 1.2.840.10008.1.2.4.70), `bigct`'nin ilk serisinin 400 kesiti. Tarayıcıda çözülen serinin tamamının SHA-1 özeti alındı. Her ikisi de sıkıştırılmamış `bigct` ile aynı çıktı (`int16:14a26de4…`); aynı kodun Windows derlemesi de aynı sonucu verdi.

**openjp2'deki hata:** İlk denemede JPEG 2000 tarayıcıda ilk görüntüde çöktü ("memory access out of bounds"). Hata ayıklama derlemesi nedenini gösterdi: openjp2 0.6.1, çözülmemiş kod bloklarının boş (null) belleğini de Rust'ın `dealloc` işleviyle serbest bırakıyor (`opj_tcd_code_block_dec_deallocate`, tcd.rs). Windows'un bellek yöneticisi bunu görmezden geliyor; WebAssembly'ninki ise belleğin dışını okuyup duruyor. `web/engine/src/allocator.rs`, WebAssembly'de boş göstericiyi serbest bırakmayı yok sayan ince bir katman ekliyor. Hatanın openjp2'ye bildirilmesi gerekir.

WebAssembly dosyası 3,6 MB (wasm-opt uygulanmadan).

## Ölçümler

**Koşullar:**
- Bu bilgisayar (14 çekirdek). Ölçüm sırasında bilgisayarda başka iş de vardı (işlemci %30–60 dolu); sayılar oynak.
- Tarayıcı: Electron 45'in Chromium'u. Dosyalar diskten geliyor, yani kullanıcının sürükleyip bıraktığı türden File nesneleri.
- Tarayıcı süreleri dosyaların Worker'a verildiği andan başlıyor. Her değer 5 turun ortancası; parantez içinde en düşük ve en yüksek tur var.
- Masaüstü motoru: `D:\veacom-dev\bench\rounds3.jsonl`, `base` motoru, 7 turun ortancası.
- "Aynı kod, yerel": bu prototipin crate'i Windows için derlenip diskten çalıştırıldı (`cargo run --release --example bench`). Masaüstü ile WebAssembly arasındaki farkın ne kadarının iş parçacığından geldiğini ayırmak için tek çekirdekle de çalıştırıldı.

**Seri listesi ve ilk görüntü** (başlangıçtan itibaren):

| | Masaüstü motoru | Aynı kod, yerel, tüm çekirdekler | Aynı kod, yerel, tek çekirdek | Tarayıcı | Tarayıcı, başlar önceden |
|---|---|---|---|---|---|
| PET/CT (520): seri listesi | 80 ms | ~60 ms | ~240 ms | 459 ms (405–933) | 398 ms (222–532) |
| PET/CT: ilk görüntü | 88 ms | ~65 ms | ~245 ms | 473 ms | 404 ms |
| bigct (800): seri listesi | 56 ms | ~28 ms | ~110 ms | 795 ms (607–1420) | 452 ms (418–548) |
| bigct: ilk görüntü | 63 ms | ~32 ms | ~115 ms | 801 ms | 458 ms |
| Calisma.zip (988): seri listesi | 1,44 s | 1,7–2,7 s | ~2,1 s | 2,0 s (1,4–2,8) | aynı |

İlk görüntü listeden 5–15 ms sonra geliyor. Küçük resimlerin hepsi ondan sonraki 5–50 ms içinde çiziliyor.

**İlk serinin tamamını çözme** (yalnız çözme süresi; masaüstü için `rounds3.jsonl`'deki hacim süresinden ilk görüntü süresi çıkarıldı):

| | Masaüstü motoru | Aynı kod, yerel, tüm çekirdekler | Aynı kod, yerel, tek çekirdek | Tarayıcı |
|---|---|---|---|---|
| PET/CT, BT serisi (284) | ~590 ms | ~250 ms | ~1,1 s | 1,36 s |
| bigct (400) | ~790 ms | ~280 ms | ~1,3 s | 1,8 s |

**Sıkıştırılmış seriler** (bigct'nin ilk serisi, 400 kesit; tarayıcıda 3 turun ortancası):

| | Aynı kod, yerel, tüm çekirdekler | Aynı kod, yerel, tek çekirdek | Tarayıcı | Tarayıcı, başlar önceden |
|---|---|---|---|---|
| JPEG 2000: seri listesi | ~21 ms | ~68 ms | 332 ms | 172 ms |
| JPEG 2000: bir kesitin çözülmesi | ~13 ms | ~13 ms | 15–30 ms | |
| JPEG 2000: serinin tamamı | ~0,87 s | ~5,8 s | ~5,6 s | |
| JPEG Lossless: seri listesi | ~17 ms | ~70 ms | 428 ms | 244 ms |
| JPEG Lossless: serinin tamamı | ~0,43 s | ~2,5 s | ~2,6 s | |

Sıkıştırılmış çözmede WebAssembly yerel tek çekirdekle aynı hızda. Serinin tamamı tek iş parçacığında yavaş (JPEG 2000'de 5,6 s); burada iş parçacıkları şart.

**WebAssembly belleğinin tepesi:** PET/CT 156 MB, bigct 356 MB, Calisma.zip 510 MB (273 MB'ı ZIP'ten çıkan dosyalar), sıkıştırılmış seriler 411 MB.

Uygulama içi tarayıcıda deneme verisi önce belleğe indiriliyor; orada seri listesi PET/CT'de 580–650 ms, bigct'de 340–540 ms çıktı. Kullanıcının dosyaları diskten geldiği için ana ölçüm Electron'da diskteki dosyalarla yapıldı.

## Süre nereye gidiyor

- Seri listesinde zamanın çoğu tarayıcının dosya okumasında geçiyor. PET/CT'de motorun ~400 ms'sinin ~310 ms'si, bigct'de ~720 ms'nin ~640 ms'si okumayı bekleyerek geçiyor.
- Her okuma (`FileReaderSync`) okunan bayttan bağımsız olarak yaklaşık 0,8 ms tutuyor. 16 KiB'lık parçalar denendi; hızlandırmadı, ZIP'i yavaşlattı.
- Okuma çıkarılınca WebAssembly'deki başlık ayrıştırma 80–100 ms tutuyor. Bu, aynı kodun yerel tek çekirdekteki süresiyle aynı düzeyde.
- **Başları önceden okumak:** Worker her dosyanın ilk 64 KiB'ını `file.slice(0, 65536).arrayBuffer()` ile aynı anda istiyor, motor başlıkları bellekten okuyor. Liste yaklaşık yarıya iniyor. Dosya başına 64 KiB bellek tutuyor; 50.000 dosyada 3 GB eder, gerçek sürümde partiler halinde yapılmalı.
- **ZIP:** 16 MB'tan büyük dosyalar 1 MiB'lık parçalarla okunuyor. ZIP'in okuma süresi ~1,4 s'den ~0,35 s'ye indi.
- **Hacim çözme** hesaba bağlı. WebAssembly burada yerel tek çekirdekten 1,2–1,4 kat yavaş. Masaüstü düzeyine iş parçacıklarıyla yaklaşılır.

## Güvenlik: zararlı dosyalar

Dosyalar sunucuya hiç gitmediği için sunucu dosyalardan etkilenemez. Tehlike, dosyanın kullanıcının tarayıcısında sayfaya ya da kullanıcıya zarar vermesi. Prototip buna izin vermiyor.

**Alınan önlemler:**
- **İçerik politikası (CSP) ve Trusted Types:** Sayfa ve Worker yalnız sitenin kendi betiklerini ve WebAssembly'sini çalıştırabiliyor. Yalnız kendi sitesine bağlanabiliyor; görüntü ya da bilgi başka bir yere gönderilemiyor. Yazıdan HTML üretilemiyor, satır içi betik ve `eval` çalışmıyor. Başlatılabilecek tek betik motorun kendi Worker'ı. Stiller ayrı dosyaya (`style.css`) taşındı.
- **Dosyadaki yazı yalnız yazı olarak gösteriliyor:** Seri adı, hasta adı gibi alanlar `textContent` ile konuyor, sayfada hiç `innerHTML` yok.
- **Motor ayrı bir Worker'da:** Bir dosya motoru çökertirse (çözücü hatası, bellek taşması, yığın taşması) Worker atılıyor, yerine yenisi başlıyor, sayfa çalışmaya devam ediyor. Motor takılırsa sayfa yine yanıt veriyor; yeni dosya açmak takılan motoru durduruyor. Reddedilen her açılıştan sonra da motor yenileniyor; WebAssembly belleği küçülmediği için böylece bellek geri veriliyor.
- **Tarayıcıya göre düşük sınırlar:** Bir dosyanın piksel verisi ve çözülmüş bir hacim en fazla 1 GiB; ZIP'ten açılan veri toplam 1 GiB, girdi başına 512 MiB. Masaüstündeki 2 ve 8 GiB'lık sınırlar 4 GB'a sığmıyordu. Motorun kendi denetimleri (boyut, kare sayısı, iç içe dizi derinliği, üst veri boyutu) olduğu gibi çalışıyor.
- **ZIP:** Dışarı çıkmaya çalışan yollar ve sembolik bağlantılar motorun kendisince reddediliyor. Dosyalar zaten yalnız bellekteki sanal dosya sistemine yazılıyor, diske hiçbir şey yazılmıyor.
- **Dosya içeriği hiç çalıştırılmıyor:** DICOM'un başındaki 128 baytlık alana gizlenmiş bir program ya da HTML (bilinen "polyglot" saldırısı) yalnız veri olarak okunup atlanıyor. Düz resimler (PNG, JPEG, BMP) tarayıcıda şimdilik hiç açılmıyor, SVG de açılmıyor.

**Deneme:** Sentetik bigct dosyalarından 247 zararlı dosya üretildi ve gizli pencerede tek tek açıldı (`web/tools/hostile.cjs`):

| Dosyalar | Sonuç |
|---|---|
| Piksel verisinde rastgele bozulma (120) | 101'i açıldı (bozuk görüntü), 19'u mesajla reddedildi |
| Başlıkta rastgele bozulma (90) | 36'sı açıldı, 54'ü mesajla reddedildi |
| Yarıda kesilmiş dosya (30) | Hepsi reddedildi |
| 32768×32768 boyut, 50.000 kare, 1000 kat iç içe dizi | Hepsi reddedildi |
| Seri ve hasta adında `<img onerror>`, `<script>`; başında `MZ` + `<script>` | Açıldı; adlar düz yazı olarak göründü, sayfaya yabancı öğe eklenmedi, hiçbir betik çalışmadı |
| ZIP bombası: 700 MB'lık tek girdi | Hemen reddedildi (girdi sınırı) |
| ZIP bombası: aynı girdi, boyutunu 1000 bayt diye gösteriyor | Hemen reddedildi (gerçek boyut bildirilenden büyük) |
| ZIP bombası: 3 × 400 MB | 1,3 s sonra 1 GiB sınırında reddedildi |

Hiçbir dosya motoru çökertmedi ya da kilitlemedi. Sonunda açılan sağlam bir dosya normal açıldı.

Ayrıca sayfada şunlar denendi ve hepsi engellendi: başka bir siteye istek, yazıdan HTML ekleme, `eval`, başka bir Worker başlatma, satır içi betik. Bilerek çökertilen motor yenisiyle değişti ve sonraki dosya normal açıldı.

**Gerçek sürüm için kalanlar:**
- Masaüstü arayüzünde `Glyph.tsx` simgeleri `dangerouslySetInnerHTML` ile çiziyor. İçerik dosyadan değil, uygulamanın kendi simgelerinden geliyor; yine de katı politika altında engellenir. Simgeler bileşen olarak yazılmalı ya da yalnız bilinen simgeleri geçiren bir Trusted Types kuralı eklenmeli.
- Kullanım verisi ve geri bildirim adresleri `connect-src`'ye tek tek eklenmeli; başka hiçbir adres eklenmemeli.
- Sitede yalnız derlenmiş dosyalar yayımlanmalı. `serve.mjs`'teki deneme verisi adresi yalnız geliştirme içindir.
- Dışa aktarmada özgün dosya olduğu gibi indirilirse içindeki gizli program da gider. Dışa aktarma dosyayı yeniden yazmalı ya da başındaki 128 baytı sıfırlamalı.
- openjp2 C'den çevrilmiş güvensiz kod. WebAssembly'deki bellek hatası tarayıcının dışına çıkamaz, en kötü durumda motor çöker ve yenilenir. Yine de bulunan hata openjp2'ye bildirilmeli.

## Riskler

**1. SharedArrayBuffer ve COOP/COEP (iş parçacıkları için)**
- Paylaşılan bellek için sayfanın "cross-origin isolated" olması gerekiyor. Başlıkları yerelde `serve.mjs`, Cloudflare'da `site/worker.js` veriyor.
- Bu başlıklarla dışarıdan yüklenen her kaynak (yazı tipi, kullanım verisi, geri bildirim gönderimi) CORP ya da CORS başlığı istiyor. Sayfanın açtığı pencerelerle bağı kopuyor.
- Asıl maliyet derlemede: WebAssembly iş parçacıkları kararlı Rust ile derlenmiyor; nightly Rust ve `-Z build-std` gerekiyor. Nightly'nin tarihi `build.ps1`'de sabit; yenisine geçmek ayrı bir iş, her geçişte özetler yeniden karşılaştırılmalı.
- Bir iş parçacığı çözme sırasında çökerse motor onu sonsuza dek bekler. Kullanıcı işi durdurunca köprü motoru süre dolunca yeniliyor (döngüye giren çözücüdeki gibi). Bu durum ayrıca denenmedi.
- Seri listesindeki darboğaz okuma olduğu için orada SharedArrayBuffer'sız yollar yetiyor: başları önceden okumak ya da birden çok Worker. İş parçacıkları en çok hacim çözmeyi hızlandırır.

**2. 4 GB bellek**
- wasm32 belleği en fazla 4 GB ve hiç küçülmüyor.
- ZIP içeriği şimdilik belleğe çıkarılıyor. Masaüstü 8 GB'a kadar açılmış ZIP kabul ediyor; tarayıcıda büyük bir ZIP sığmaz. Girdiler gerektiğinde doğrudan ZIP'ten okunmalı ya da OPFS'ye yazılmalı.
- Masaüstü 2 GiB'a kadar hacim çözüyor. Tarayıcıda böyle bir hacim, çözme sırasındaki ara bellek ve WebGL'e giden kopyasıyla birlikte 4 GB'ı aşabilir. Hacim önbelleği küçük tutulmalı, büyük seriler kesit kesit gösterilmeli.

**3. Safari'de klasör açma**
- Klasör seçici (`webkitdirectory`) ve klasör sürükle-bırak (`webkitGetAsEntry`) Safari ve Firefox'ta da var; prototip ikisini de kullanıyor.
- Safari ve Firefox'ta File System Access (`showDirectoryPicker`) yok. Klasör her seferinde yeniden seçiliyor; dışa aktarma bir klasöre yazılamıyor, yalnız indirme olarak veriliyor.
- Safari'de denenmedi (bu bilgisayarda Mac yok).

**4. Diğer**
- JPEG-LS yok; ayrı bir WebAssembly derlemesi gerekiyor.
- PNG, JPEG ve BMP resimleri açılmıyor. Masaüstünde bunları arayüz süreci çözüyor; tarayıcıda bu yol henüz yok, motor açık bir iletiyle reddediyor.
- JPEG 2000 çözücüsü `openjp2`, C'den makineyle çevrilmiş güvensiz (unsafe) kod; WebAssembly'de bir hatası bulundu ve aşıldı (yukarıda).
- Blob nesneleri onları alan Worker'a ait. İş parçacıkları dosyaları bu yüzden yalnız paylaşılan bellekte bütün olarak tutulduklarında okuyabiliyor (yukarıda, "İş parçacıkları").
- WebAssembly belleği hiç küçülmüyor. Bütün seriler kapatılınca motor yenileniyor ve bellek geri veriliyor; bir seri açıkken öbürleri kapatılınca bellek geri gelmiyor.
- Tarayıcıdaki dosyaların değişiklik zamanı yok. `input_guard`'ın "dosya okunurken değişti" denetimi bu yüzden her zaman geçiyor. Dosya diskte değişirse Chrome okumayı hatayla kesiyor; motor bunu okuma hatası olarak bildiriyor.
- Her dosya okuması bir tarayıcı çağrısı olduğundan 50.000 dosyalık bir klasörde düz okuma yaklaşık 40 saniye sürer. Önceden okuma ya da paralel Worker'lar burada şart.

## Sonraki adımlar

1. ~~Çekirdek/taşıma ayrımı~~ (8 Kasım, yukarıda).
2. ~~Tarayıcı oturumu~~, ~~web köprüsü~~, ~~`web.html`~~ (8 Kasım, "Gerçek arayüz tarayıcıda").
3. ~~Tarayıcıda olmayan işlevlerin gizlenmesi ve dışa aktarmanın indirme olarak yapılması~~ (8 Kasım).
4. ~~Klasör açmada `showDirectoryPicker`~~ (8 Kasım).
5. ~~İş parçacıkları~~ (8 Kasım, yukarıda).
6. ~~viewer.plexusmd.org ile hız karşılaştırması~~ (8 Kasım, yukarıda).
7. ~~Bütün çalışmalar kapatılınca motoru yenileyip belleği geri vermek~~ (8 Kasım, "Yayın").
8. ~~İş parçacığı üst sınırı~~ (8 Kasım): çekirdeklerin yarısı, en fazla 4 olarak kaldı. Zayıf bilgisayar zaten 2 iş parçacığı alıyor. 8 ve daha çok çekirdekli bilgisayarda 4 iş parçacığı seriyi 1,3–1,4 kat daha çabuk açıyor; fazladan işlemci yükü yalnız birkaç saniye sürüyor.
9. Karar bekleyen: her dosyayı tek seferde okumak tek iş parçacıklı derlemeye de uygulansın mı.
10. ~~Yayın~~ (8 Kasım): https://viewer.veacom.app/
11. ~~İlk görüntü: kesit isteği serinin çözülmesini beklemesin~~ (8 Kasım, "Hız iyileştirmeleri").
12. ~~Tarayıcı sürümünü güncel `main`'e taşımak~~ (8 Kasım). Motorun iş parçacıkları artık rayon değil, `parallel.rs`: tarayıcıda bu koşular sayfanın başlattığı yardımcı Worker'lara gidiyor (`engine/src/helpers.rs`). Tarayıcı derlemesi masaüstününkinden ayrı (`pnpm run build:browser`, `dist-web`).
13. PET/BT'de işlemci hâlâ PlexusMD'nin 1,5–1,8 katı: PET'in ondalıklı yoluna bakmak.
14. Güvenlik incelemesinden kalanlar (yukarıda "Güvenlik incelemesi").
15. Tarayıcıda PNG, JPEG ve BMP resimleri (yukarıda "Diğer").

## Çalıştırma

`web/README.md` içinde.
