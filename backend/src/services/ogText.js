const { db } = require('../database/db');

// The link-preview pages (gallery and transfer) are read by crawlers, which
// send no useful Accept-Language, and a gallery has no language of its own.
// They speak the instance's default language (Settings → General), the one
// the guest emails use when nothing more specific is known (issue 2489).
const TEXT = {
  en: {
    galleryOn: 'Photo gallery from {name} on {date}.',
    gallery: 'Photo gallery from {name}.',
    shared: 'Photo gallery shared with PicPeak.',
    untitled: 'Photo Gallery',
    viewGallery: 'View gallery',
    filesShared: 'Files shared with you.',
    viewFiles: 'View files',
    uploadHere: 'Upload your files here.',
    uploadFiles: 'Upload files',
  },
  de: {
    galleryOn: 'Fotogalerie: {name} vom {date}.',
    gallery: 'Fotogalerie: {name}.',
    shared: 'Fotogalerie, geteilt mit PicPeak.',
    untitled: 'Fotogalerie',
    viewGallery: 'Galerie ansehen',
    filesShared: 'Dateien, die mit Ihnen geteilt wurden.',
    viewFiles: 'Dateien ansehen',
    uploadHere: 'Laden Sie Ihre Dateien hier hoch.',
    uploadFiles: 'Dateien hochladen',
  },
  es: {
    galleryOn: 'Galería de fotos de {name} del {date}.',
    gallery: 'Galería de fotos de {name}.',
    shared: 'Galería de fotos compartida con PicPeak.',
    untitled: 'Galería de fotos',
    viewGallery: 'Ver galería',
    filesShared: 'Archivos compartidos contigo.',
    viewFiles: 'Ver archivos',
    uploadHere: 'Sube tus archivos aquí.',
    uploadFiles: 'Subir archivos',
  },
  fr: {
    galleryOn: 'Galerie photo de {name} du {date}.',
    gallery: 'Galerie photo de {name}.',
    shared: 'Galerie photo partagée avec PicPeak.',
    untitled: 'Galerie photo',
    viewGallery: 'Voir la galerie',
    filesShared: 'Fichiers partagés avec vous.',
    viewFiles: 'Voir les fichiers',
    uploadHere: 'Déposez vos fichiers ici.',
    uploadFiles: 'Déposer des fichiers',
  },
  nl: {
    galleryOn: 'Fotogalerij van {name} op {date}.',
    gallery: 'Fotogalerij van {name}.',
    shared: 'Fotogalerij gedeeld met PicPeak.',
    untitled: 'Fotogalerij',
    viewGallery: 'Galerij bekijken',
    filesShared: 'Bestanden die met u zijn gedeeld.',
    viewFiles: 'Bestanden bekijken',
    uploadHere: 'Upload uw bestanden hier.',
    uploadFiles: 'Bestanden uploaden',
  },
  pt: {
    galleryOn: 'Galeria de fotos de {name} em {date}.',
    gallery: 'Galeria de fotos de {name}.',
    shared: 'Galeria de fotos compartilhada com PicPeak.',
    untitled: 'Galeria de fotos',
    viewGallery: 'Ver galeria',
    filesShared: 'Arquivos compartilhados com você.',
    viewFiles: 'Ver arquivos',
    uploadHere: 'Envie seus arquivos aqui.',
    uploadFiles: 'Enviar arquivos',
  },
  ru: {
    galleryOn: 'Фотогалерея «{name}» от {date}.',
    gallery: 'Фотогалерея «{name}».',
    shared: 'Фотогалерея в PicPeak.',
    untitled: 'Фотогалерея',
    viewGallery: 'Открыть галерею',
    filesShared: 'Файлы, которыми с вами поделились.',
    viewFiles: 'Открыть файлы',
    uploadHere: 'Загрузите сюда свои файлы.',
    uploadFiles: 'Загрузить файлы',
  },
  sl: {
    galleryOn: 'Fotogalerija {name}, {date}.',
    gallery: 'Fotogalerija {name}.',
    shared: 'Fotogalerija, deljena s PicPeak.',
    untitled: 'Fotogalerija',
    viewGallery: 'Ogled galerije',
    filesShared: 'Datoteke, deljene z vami.',
    viewFiles: 'Ogled datotek',
    uploadHere: 'Tukaj naložite svoje datoteke.',
    uploadFiles: 'Naloži datoteke',
  },
};

const OG_LOCALE = {
  en: 'en_US', de: 'de_DE', es: 'es_ES', fr: 'fr_FR', nl: 'nl_NL', pt: 'pt_BR', ru: 'ru_RU', sl: 'sl_SI',
};

function normaliseLanguage(value) {
  const code = typeof value === 'string' ? value.trim().slice(0, 2).toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(TEXT, code) ? code : 'en';
}

async function previewLanguage() {
  try {
    const row = await db('app_settings').where('setting_key', 'general_default_language').first();
    let value = row && row.setting_value;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch (_) { /* stored unquoted */ }
    }
    return normaliseLanguage(value);
  } catch (_) {
    return 'en';
  }
}

function ogText(language, key, vars = {}) {
  const template = (TEXT[language] || TEXT.en)[key] || TEXT.en[key];
  return template.replace(/\{(\w+)\}/g, (_, name) => (vars[name] == null ? '' : String(vars[name])));
}

function ogLocale(language) {
  return OG_LOCALE[language] || OG_LOCALE.en;
}

module.exports = { TEXT, normaliseLanguage, previewLanguage, ogText, ogLocale };
