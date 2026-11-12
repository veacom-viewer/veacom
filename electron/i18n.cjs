// The main process's interface language: dialog titles, error boxes, update, export, engine and
// assessment messages. Turkish is the default, as in VEAcom 1.x; the renderer's choice is saved in
// the user's settings folder so the next start (and its "could not start" box) uses it too.
// VEACOM_LOCALE overrides the saved choice (tests, screenshots). Wording follows VEAcom 1.2.1.
const fs = require('node:fs');
const path = require('node:path');

const LOCALES = ['tr', 'en'];
const DEFAULT_LOCALE = 'tr';

const en = {
  'startup.failed': 'VEAcom could not start',
  'launch.cannotOpen': 'Could not open {path}.',
  'dialog.openStudy': 'Open imaging study',
  'dialog.archives': 'Archives',
  'dialog.exportFolder': 'Choose export folder',
  'dialog.exportVideo': 'Export viewport video',
  'dialog.mp4': 'MP4 video',
  'dialog.exportIso': 'Export DICOM disc image',
  'dialog.isoFilter': 'ISO disc image',
  'export.chooseSeries': 'Choose one or more series to export.',
  'export.rootTitle': 'DICOMDIR already there',
  'export.rootExists': '{directory} already has a DICOMDIR or a DICOM folder. It is not overwritten.',
  'export.rootDetail': 'Write the new copy into a subfolder instead? Some neuronavigation systems look for DICOMDIR only at the root of the stick: use an empty stick if yours does.',
  'export.rootSubfolder': 'Write to a subfolder',
  'export.rootCancel': 'Cancel',
  'export.quitTitle': 'Export in progress',
  'export.quitMessage': 'The export has not finished.',
  'export.quitDetail': 'Closing now leaves the exported folder incomplete.',
  'export.quitAnyway': 'Close anyway',
  'export.quitStay': 'Wait',
  'links.notAllowed': 'This external link is not allowed.',
  'app.closing': 'The application is closing.',

  'engine.unavailable': 'The imaging engine is unavailable.',
  'engine.restartedReopen': 'The imaging engine restarted. Reopen this study before loading or exporting its source data.',
  'engine.stopping': 'The imaging engine is stopping.',
  'engine.startTimeout': 'The imaging engine did not start within {seconds} seconds.',
  'engine.incompatible': 'The imaging engine does not match this version of VEAcom. Reinstall VEAcom.',
  'engine.stoppedUnexpectedly': 'The imaging engine stopped unexpectedly ({reason}).',
  'engine.restartedEmpty': 'The imaging engine restarted with an empty study catalog. Loaded images and annotations remain available. The interrupted operation was not retried.',
  'engine.restartLimit': '{message} Automatic restart limit reached. Loaded images remain available. Reopen the app to restart the engine.',
  'engine.restarting': '{message} Restarting the engine; the interrupted operation will not be retried.',
  'engine.cannotStop': 'The imaging engine could not be stopped. No replacement was started.',
  'broker.restarted': 'The imaging engine restarted. Reopen this study.',
  'broker.tooManySelections': 'Too many pending file selections.',
  'broker.seriesNotOpen': 'This series is not open in the current imaging engine.',
  'broker.tooManyImages': 'Too many pending image requests.',

  'video.alreadyRunning': 'Another video export is already running.',
  'video.frameRate': 'Choose a frame rate between 1 and 120.',
  'video.invalidName': 'Invalid video file name.',
  'video.inactive': 'This video export is no longer active.',
  'video.frameLimit': 'Video export is limited to {count} frames.',
  'video.cancelled': 'Video export cancelled.',
  'video.noFrames': 'No video frames were captured.',
  'iso.alreadyRunning': 'An ISO export is already running.',
  'iso.platform': 'ISO export currently supports Windows and macOS. Export a DICOMDIR folder on this platform.',
  'iso.burnerWindows': 'The disc burner dialog is available on Windows. Save an ISO to burn on this computer.',
  'iso.noFolder': 'DICOM export did not return its output folder.',
  'iso.closed': 'ISO export cancelled because the application closed.',
  'iso.cancelled': 'ISO export cancelled.',
  'iso.failed': 'ISO creation failed.',
  'iso.emptyFile': 'ISO creation produced an empty file.',
  'iso.burnerFailed': 'The ISO was saved, but Windows Disc Image Burner could not open: {error}',

  'update.sourceBuild': 'Source build. Check official releases manually.',
  'update.notChecked': 'Updates have not been checked.',
  'update.checking': 'Checking official VEAcom releases…',
  'update.department': 'This beta is distributed by your department. The VEAcom releases page opens in your browser.',
  'update.noInstaller': 'No VEAcom installer with a verified checksum is published for {platform}/{arch}.',
  'update.upToDate': 'VEAcom {version} is up to date for this platform.',
  'update.availableSource': 'VEAcom {version} is available. This source build cannot install updates; use the release page.',
  'update.available': 'VEAcom {version} is available.',
  'update.chooseAvailable': 'Choose an available update from an installed Electron build.',
  'update.downloading': 'Downloading VEAcom {version}…',
  'update.verified': 'Download verified. Review and open the installer when ready.',
  'update.noInstallerReady': 'No verified installer is ready.',
  'update.installerChanged': 'The downloaded installer changed. Download it again.',
  'update.dialogCancel': 'Cancel',
  'update.dialogConfirm': 'Close VEAcom and open installer',
  'update.dialogTitle': 'Install VEAcom update',
  'update.dialogMessage': 'Open the VEAcom {version} installer?',
  'update.dialogDetail': '{signature}\nSHA-256 verified against veacom-viewer/veacom.\n\nExport any unsaved work first. The viewer will close. The installer remains visible and may ask for Windows or macOS permission.',
  'update.changedWhileWaiting': 'The installer changed while awaiting confirmation.',
  'update.openFailed': 'Could not open the installer: {error}',
  'update.installing': 'Installer opened. VEAcom is closing.',
  'update.invalidResponse': 'The release server returned an invalid response.',
  'update.leftHosts': 'Update download left the approved GitHub hosts.',
  'update.redirect': 'Unexpected redirect from the release service.',
  'update.httpStatus': 'Release service returned HTTP {status}.',
  'update.tooManyRedirects': 'Too many update-download redirects.',
  'update.responseTooLarge': 'Release response is too large.',
  'update.tooLarge': 'Installer exceeds the published size.',
  'update.checksum': 'Installer checksum or size does not match the official release.',
  'update.blockedSignature': 'Update blocked: installer signature is {status}. A valid publisher signature is required.',
  'update.blockedUnsigned': 'Update blocked: this application has no valid publisher signature. Install a signed Electron build manually.',
  'update.blockedPublisher': 'Update blocked: the installer publisher does not match the installed application.',
  'update.windowsPublisher': 'Verified Windows publisher: {subject}',
  'update.macPublisherMismatch': 'macOS update publisher does not match the installed application.',
  'update.macPublisher': 'Verified macOS publisher team: {team}; Gatekeeper accepted the disk image.',
  'update.blockedMac': 'Update blocked: macOS signature, notarization or publisher verification failed. {details}',
  'update.platform': 'Installer updates are supported on Windows and macOS.',
  'update.signatureUnknown': 'unknown',

  'ai.invalidModel': 'Enter a valid Claude model identifier.',
  'ai.invalidKey': 'Invalid API key.',
  'ai.noSecretStorage': 'Operating-system secret storage is unavailable.',
  'ai.summaryLength': 'A summary between 1 and 32,000 characters is required.',
  'export.reviewSlice': 'Selected slice {n}',
  'export.reviewTitle': 'Review pixels before export',
  'export.reviewMessage': 'Have you reviewed the pixels in the {count} selected series?',
  'export.reviewDetail': 'Metadata cleanup keeps the pixels, including any burned-in patient names, numbers or faces. Cancel if any identifying information is still visible.',
  'export.reviewAccept': 'I reviewed the pixels. Export',
  'ai.disabled': 'External AI assessment is disabled in this build.',
  'ai.cancelled': 'No assessment was sent.',
  'ai.reviewTitle': 'Review text to be sent to Anthropic',
  'ai.reviewPage': 'Review the outgoing instructions and clinical text ({page} of {total})',
  'ai.busy': 'An assessment request is already running.',
  'ai.configureKey': 'Configure an API key first.',
  'ai.rejected': 'The API key was rejected.',
  'ai.rateLimit': 'The provider rate or spending limit was reached.',
  'ai.httpStatus': 'The assessment provider returned HTTP {status}. Check the configured model and account access.',
  'ai.empty': 'The provider returned no assessment text.',
  'ai.timeout': 'The reply did not arrive in time.',
  'ai.offline': 'The assessment provider could not be reached.',
  'feedback.confirmTitle': 'Send feedback',
  'feedback.confirmMessage': 'Send this to the VEAcom team?',
  'feedback.confirmDetail': 'It goes by e-mail to the team. Check that it holds no patient information.\n\nType: {kind}\nReply address: {email}\nApp and system: {system}\n\n{message}',
  'feedback.confirmSend': 'Send',
  'feedback.confirmCancel': 'Cancel',
  'feedback.kindProblem': 'Problem',
  'feedback.kindSuggestion': 'Suggestion',
  'feedback.noEmail': 'none',
  'feedback.noSystem': 'not included',
  'feedback.confirmNext': 'Read next part',
  'feedback.confirmPage': 'Review feedback ({page} of {total})',
};

const tr = {
  'startup.failed': 'VEAcom başlatılamadı',
  'launch.cannotOpen': '{path} açılamadı.',
  'dialog.openStudy': 'DICOM içe aktar — klasör, dosya ya da arşiv seçin',
  'dialog.archives': 'Arşivler',
  'dialog.exportFolder': 'Dışa aktarma klasörünü seçin',
  'dialog.exportVideo': 'Kesit videosunu dışa aktar',
  'dialog.mp4': 'MP4 videosu',
  'dialog.exportIso': 'DICOM disk görüntüsünü dışa aktar',
  'dialog.isoFilter': 'Disk görüntüsü',
  'export.chooseSeries': 'Dışa aktarmak için bir ya da daha çok seri seçin.',
  'export.rootTitle': 'DICOMDIR zaten var',
  'export.rootExists': '{directory} konumunda zaten bir DICOMDIR ya da DICOM klasörü var. Üzerine yazılmaz.',
  'export.rootDetail': 'Yeni kopya bir alt klasöre yazılsın mı? Bazı nöronavigasyon cihazları DICOMDIR\'i yalnız belleğin kökünde arar; sizinki öyleyse boş bir bellek kullanın.',
  'export.rootSubfolder': 'Alt klasöre yaz',
  'export.rootCancel': 'Vazgeç',
  'export.quitTitle': 'Dışa aktarma sürüyor',
  'export.quitMessage': 'Dışa aktarma henüz bitmedi.',
  'export.quitDetail': 'Şimdi kapatılırsa dışa aktarılan klasör yarım kalır.',
  'export.quitAnyway': 'Yine de kapat',
  'export.quitStay': 'Bekle',
  'links.notAllowed': 'Bu dış bağlantıya izin verilmiyor.',
  'app.closing': 'Uygulama kapanıyor.',

  'engine.unavailable': 'Görüntüleme motoru kullanılamıyor.',
  'engine.restartedReopen': 'Görüntüleme motoru yeniden başladı. Özgün verilerini yüklemek ya da dışa aktarmak için bu çalışmayı yeniden açın.',
  'engine.stopping': 'Görüntüleme motoru kapanıyor.',
  'engine.startTimeout': 'Görüntüleme motoru {seconds} saniye içinde başlamadı.',
  'engine.incompatible': 'Görüntüleme motoru VEAcom\'un bu sürümüyle uyumlu değil. VEAcom\'u yeniden kurun.',
  'engine.stoppedUnexpectedly': 'Görüntüleme motoru beklenmedik biçimde durdu ({reason}).',
  'engine.restartedEmpty': 'Görüntüleme motoru boş bir çalışma listesiyle yeniden başladı. Yüklü görüntüler ve ölçümler yerinde. Yarım kalan işlem yeniden denenmedi.',
  'engine.restartLimit': '{message} Otomatik yeniden başlatma sınırına ulaşıldı. Yüklü görüntüler yerinde. Motoru yeniden başlatmak için uygulamayı yeniden açın.',
  'engine.restarting': '{message} Motor yeniden başlatılıyor; yarım kalan işlem yeniden denenmeyecek.',
  'engine.cannotStop': 'Görüntüleme motoru durdurulamadı. Yerine yenisi başlatılmadı.',
  'broker.restarted': 'Görüntüleme motoru yeniden başladı. Bu çalışmayı yeniden açın.',
  'broker.tooManySelections': 'Bekleyen dosya seçimi çok fazla.',
  'broker.seriesNotOpen': 'Bu seri geçerli görüntüleme motorunda açık değil.',
  'broker.tooManyImages': 'Bekleyen görüntü isteği çok fazla.',

  'video.alreadyRunning': 'Başka bir video dışa aktarma sürüyor.',
  'video.frameRate': '1 ile 120 arasında bir kare hızı seçin.',
  'video.invalidName': 'Video dosya adı geçersiz.',
  'video.inactive': 'Bu video dışa aktarma artık etkin değil.',
  'video.frameLimit': 'Video en çok {count} kare olabilir.',
  'video.cancelled': 'Video dışa aktarma iptal edildi.',
  'video.noFrames': 'Hiç video karesi kaydedilmedi.',
  'iso.alreadyRunning': 'Bir ISO dışa aktarma zaten sürüyor.',
  'iso.platform': 'ISO dışa aktarma şimdilik Windows ve macOS\'ta çalışır. Bu sistemde DICOMDIR klasörü olarak dışa aktarın.',
  'iso.burnerWindows': 'Disk yazıcı penceresi yalnızca Windows\'ta var. Bu bilgisayarda yazmak için ISO kaydedin.',
  'iso.noFolder': 'DICOM dışa aktarma çıktı klasörünü bildirmedi.',
  'iso.closed': 'Uygulama kapandığı için ISO dışa aktarma iptal edildi.',
  'iso.cancelled': 'ISO dışa aktarma iptal edildi.',
  'iso.failed': 'ISO oluşturulamadı.',
  'iso.emptyFile': 'ISO oluşturma boş bir dosya üretti.',
  'iso.burnerFailed': 'ISO kaydedildi ama Windows Disk Görüntüsü Yazıcı açılamadı: {error}',

  'update.sourceBuild': 'Kaynak koddan çalışan kopya. Resmî sürümleri elle denetleyin.',
  'update.notChecked': 'Güncellemeler henüz denetlenmedi.',
  'update.checking': 'Resmî VEAcom sürümleri denetleniyor…',
  'update.department': 'Bu beta sürümünü bölümünüz dağıtıyor. VEAcom sürümleri sayfası tarayıcınızda açılır.',
  'update.noInstaller': '{platform}/{arch} için sağlama toplamı doğrulanmış bir VEAcom kurulum dosyası yayımlanmamış.',
  'update.upToDate': 'VEAcom {version} bu sistem için güncel.',
  'update.availableSource': 'VEAcom {version} yayımlandı. Kaynak koddan çalışan bu kopya güncelleme kuramaz; sürüm sayfasını kullanın.',
  'update.available': 'VEAcom {version} yayımlandı.',
  'update.chooseAvailable': 'Kurulu bir Electron sürümünden, yayımlanmış bir güncelleme seçin.',
  'update.downloading': 'VEAcom {version} indiriliyor…',
  'update.verified': 'İndirme doğrulandı. Hazır olduğunuzda kurulumu açın.',
  'update.noInstallerReady': 'Doğrulanmış bir kurulum dosyası hazır değil.',
  'update.installerChanged': 'İndirilen kurulum dosyası değişmiş. Yeniden indirin.',
  'update.dialogCancel': 'Daha sonra',
  'update.dialogConfirm': 'VEAcom\'u kapat ve kurulumu aç',
  'update.dialogTitle': 'VEAcom güncellemesi',
  'update.dialogMessage': 'VEAcom {version} kurulumu açılsın mı?',
  'update.dialogDetail': '{signature}\nSHA-256, veacom-viewer/veacom ile doğrulandı.\n\nKaydedilmemiş işleri önce dışa aktarın. Görüntüleyici kapanacak. Kurulum penceresi açık kalır ve Windows ya da macOS izni isteyebilir.',
  'update.changedWhileWaiting': 'Onay beklenirken kurulum dosyası değişti.',
  'update.openFailed': 'Kurulum başlatılamadı: {error}',
  'update.installing': 'Kurulum açıldı. VEAcom kapanıyor.',
  'update.invalidResponse': 'Sürüm sunucusu geçersiz bir yanıt verdi.',
  'update.leftHosts': 'Güncelleme indirmesi onaylı GitHub sunucularının dışına çıktı.',
  'update.redirect': 'Sürüm hizmetinden beklenmeyen bir yönlendirme geldi.',
  'update.httpStatus': 'Sürüm hizmeti HTTP {status} yanıtı verdi.',
  'update.tooManyRedirects': 'Güncelleme indirmesinde çok fazla yönlendirme var.',
  'update.responseTooLarge': 'Sürüm yanıtı çok büyük.',
  'update.tooLarge': 'Kurulum dosyası yayımlanan boyutu aşıyor.',
  'update.checksum': 'Kurulum dosyasının sağlama toplamı ya da boyutu resmî sürümle uyuşmuyor.',
  'update.blockedSignature': 'Güncelleme engellendi: kurulum imzası {status}. Geçerli bir yayıncı imzası gerekir.',
  'update.blockedUnsigned': 'Güncelleme engellendi: bu uygulamanın geçerli bir yayıncı imzası yok. İmzalı bir Electron sürümünü elle kurun.',
  'update.blockedPublisher': 'Güncelleme engellendi: kurulumun yayıncısı kurulu uygulamanınkiyle aynı değil.',
  'update.windowsPublisher': 'Doğrulanmış Windows yayıncısı: {subject}',
  'update.macPublisherMismatch': 'macOS güncellemesinin yayıncısı kurulu uygulamanınkiyle aynı değil.',
  'update.macPublisher': 'Doğrulanmış macOS yayıncı ekibi: {team}; Gatekeeper disk görüntüsünü kabul etti.',
  'update.blockedMac': 'Güncelleme engellendi: macOS imzası, onaylama (notarization) ya da yayıncı doğrulaması başarısız. {details}',
  'update.platform': 'Kurulum güncellemeleri Windows ve macOS\'ta desteklenir.',
  'update.signatureUnknown': 'bilinmiyor',

  'ai.invalidModel': 'Geçerli bir Claude model adı gir.',
  'ai.invalidKey': 'Anahtar geçersiz.',
  'ai.noSecretStorage': 'İşletim sisteminin gizli anahtar deposu kullanılamıyor.',
  'ai.summaryLength': 'Özet 1 ile 32.000 karakter arasında olmalı.',
  'export.reviewSlice': 'Seçilen kesit {n}',
  'export.reviewTitle': 'Dışa aktarmadan önce pikselleri inceleyin',
  'export.reviewMessage': 'Seçilen {count} serinin piksellerini incelediniz mi?',
  'export.reviewDetail': 'Üst verileri temizlemek piksellere gömülü hasta adlarını, numaralarını veya yüzleri silmez. Kimlik bilgisi varsa iptal edin.',
  'export.reviewAccept': 'Pikselleri inceledim, dışa aktar',
  'ai.disabled': 'Harici yapay zekâ değerlendirmesi bu sürümde kapalı.',
  'ai.cancelled': 'Hiçbir değerlendirme gönderilmedi.',
  'ai.reviewTitle': 'Anthropic’e gönderilecek metni inceleyin',
  'ai.reviewPage': 'Gönderilecek talimatları ve klinik metni inceleyin ({page}/{total})',
  'ai.busy': 'Önceki soru hâlâ yanıt bekliyor.',
  'ai.configureKey': 'Önce bir API anahtarı kaydet.',
  'ai.rejected': 'Anahtar geçersiz.',
  'ai.rateLimit': 'Çok sık soruldu ya da kota doldu. Biraz sonra yeniden dene.',
  'ai.httpStatus': 'Sunucu hatası ({status}). Kayıtlı modeli ve hesap erişimini denetle.',
  'ai.empty': 'Boş yanıt geldi.',
  'ai.timeout': 'Yanıt zamanında gelmedi.',
  'ai.offline': 'İnternete ulaşılamadı.',
  'feedback.confirmTitle': 'Geri bildirim gönder',
  'feedback.confirmMessage': 'Bu mesaj VEAcom ekibine gönderilsin mi?',
  'feedback.confirmDetail': 'Mesaj ekibe e-postayla gider. Hasta bilgisi içermediğinden emin olun.\n\nTür: {kind}\nYanıt adresi: {email}\nUygulama ve sistem: {system}\n\n{message}',
  'feedback.confirmSend': 'Gönder',
  'feedback.confirmCancel': 'Vazgeç',
  'feedback.kindProblem': 'Sorun',
  'feedback.kindSuggestion': 'Öneri',
  'feedback.noEmail': 'yok',
  'feedback.noSystem': 'eklenmedi',
  'feedback.confirmNext': 'Sonraki kısmı oku',
  'feedback.confirmPage': 'Geri bildirimi gözden geçir ({page}/{total})',
};

const messages = { tr, en };
const isLocale = value => LOCALES.includes(value);
const override = () => isLocale(process.env.VEACOM_LOCALE) ? process.env.VEACOM_LOCALE : null;
let current = override() ?? DEFAULT_LOCALE;
let settingsFile = null;

/** Reads the saved language from the settings folder. Call once the folder is known. */
function load(directory) {
  settingsFile = path.join(directory, 'preferences.json');
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).locale; } catch { /* First start, or unreadable: use the default. */ }
  current = override() ?? (isLocale(saved) ? saved : DEFAULT_LOCALE);
  return current;
}

function getLocale() { return current; }

/** Switches the language and, once `load` has run, remembers it for the next start. */
function setLocale(next) {
  if (!isLocale(next)) throw new Error('Unsupported language.');
  current = next;
  if (!settingsFile) return current;
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {}; } catch { /* Start a new file. */ }
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ ...stored, locale: next }), { mode: 0o600 });
  return current;
}

function t(key, params) {
  const template = messages[current][key] ?? en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (placeholder, name) => Object.hasOwn(params, name) ? String(params[name]) : placeholder);
}

// Messages from the imaging engine (native/src/message.rs) carry a code, parameters and their English
// text. core-messages.json holds the other languages; the renderer translates with the same file
// (src/i18n/core.ts) and the same rules.
const coreMessages = require('./core-messages.json');
const isNote = value => Boolean(value) && typeof value === 'object' && typeof value.text === 'string';
function renderNote(note) {
  const template = note.code ? coreMessages[current]?.[note.code] : undefined;
  if (template === undefined) return note.text;
  return template.replace(/\{(\w+)\}/g, (placeholder, name) => {
    const value = note.params?.[name];
    if (value === undefined) return placeholder;
    if (Array.isArray(value)) return value.map(renderNote).join('; ');
    return typeof value === 'string' ? value : renderNote(value);
  });
}
function coreText(note) {
  const text = renderNote(note);
  const template = note.code ? coreMessages[current]?.[note.code] : undefined;
  return template && /^\p{Ll}/u.test(template) ? text.charAt(0).toLocaleUpperCase(current) + text.slice(1) : text;
}
/** The message of an engine error body ({ error, note }), translated when it carries a note. */
function coreErrorText(body) {
  try {
    const value = JSON.parse(body);
    if (isNote(value?.note)) return coreText(value.note);
    if (typeof value?.error === 'string') return value.error;
  } catch { /* A plain-text body. */ }
  return body;
}

module.exports = { LOCALES, DEFAULT_LOCALE, messages, isLocale, load, getLocale, setLocale, t, coreText, coreErrorText };
