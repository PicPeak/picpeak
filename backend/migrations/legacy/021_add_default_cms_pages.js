exports.up = async function(knex) {
  // Check if CMS pages already exist
  const impressumExists = await knex('cms_pages')
    .where('slug', 'impressum')
    .first();
    
  const datenschutzExists = await knex('cms_pages')
    .where('slug', 'datenschutz')
    .first();
  
  const pagesToInsert = [];
  
  // Add Impressum page if it doesn't exist
  if (!impressumExists) {
    pagesToInsert.push({
      slug: 'impressum',
      title_en: 'Legal Notice',
      title_de: 'Impressum',
      content_en: `<h1>Legal Notice</h1>
<p>Information according to § 5 TMG</p>

<h2>Responsible for content</h2>
<p>[Your Name]<br>
[Your Address]<br>
[Postal Code City]</p>

<h2>Contact</h2>
<p>Email: [Your Email Address]<br>
Phone: [Your Phone Number]</p>

<h2>Disclaimer</h2>
<h3>Liability for content</h3>
<p>The contents of our pages were created with great care. However, we cannot guarantee the accuracy, completeness and timeliness of the content.</p>

<h3>Liability for links</h3>
<p>Our website contains links to external third-party websites over whose content we have no influence. Therefore, we cannot accept any liability for this third-party content.</p>`,
      content_de: `<h1>Impressum</h1>
<p>Angaben gemäß § 5 TMG</p>

<h2>Verantwortlich für den Inhalt</h2>
<p>[Ihr Name]<br>
[Ihre Adresse]<br>
[PLZ Ort]</p>

<h2>Kontakt</h2>
<p>E-Mail: [Ihre E-Mail-Adresse]<br>
Telefon: [Ihre Telefonnummer]</p>

<h2>Haftungsausschluss</h2>
<h3>Haftung für Inhalte</h3>
<p>Die Inhalte unserer Seiten wurden mit größter Sorgfalt erstellt. Für die Richtigkeit, Vollständigkeit und Aktualität der Inhalte können wir jedoch keine Gewähr übernehmen.</p>

<h3>Haftung für Links</h3>
<p>Unser Angebot enthält Links zu externen Webseiten Dritter, auf deren Inhalte wir keinen Einfluss haben. Deshalb können wir für diese fremden Inhalte auch keine Gewähr übernehmen.</p>`,
      updated_at: new Date()
    });
  }
  
  // Add Datenschutz page if it doesn't exist
  if (!datenschutzExists) {
    pagesToInsert.push({
      slug: 'datenschutz',
      title_en: 'Privacy Policy',
      title_de: 'Datenschutzerklärung',
      content_en: `<h1>Privacy Policy</h1>

<h2>1. Privacy at a Glance</h2>
<h3>General Information</h3>
<p>The following information provides a simple overview of what happens to your personal data when you visit this website.</p>

<h3>Data Collection on This Website</h3>
<p><strong>Who is responsible for data collection on this website?</strong></p>
<p>Data processing on this website is carried out by the website operator. Their contact details can be found in the legal notice of this website.</p>

<p><strong>How do we collect your data?</strong></p>
<p>Your data is collected when you provide it to us. This could be data that you enter into a contact form, for example.</p>

<p><strong>What do we use your data for?</strong></p>
<p>Some of the data is collected to ensure error-free provision of the website. Other data may be used to analyze your user behavior.</p>

<h2>2. Hosting</h2>
<p>This website is hosted externally. The personal data collected on this website is stored on the servers of the host.</p>

<h2>3. General Information and Mandatory Information</h2>
<h3>Data Protection</h3>
<p>The operators of these pages take the protection of your personal data very seriously. We treat your personal data confidentially and in accordance with the statutory data protection regulations and this privacy policy.</p>`,
      content_de: `<h1>Datenschutzerklärung</h1>

<h2>1. Datenschutz auf einen Blick</h2>
<h3>Allgemeine Hinweise</h3>
<p>Die folgenden Hinweise geben einen einfachen Überblick darüber, was mit Ihren personenbezogenen Daten passiert, wenn Sie diese Website besuchen.</p>

<h3>Datenerfassung auf dieser Website</h3>
<p><strong>Wer ist verantwortlich für die Datenerfassung auf dieser Website?</strong></p>
<p>Die Datenverarbeitung auf dieser Website erfolgt durch den Websitebetreiber. Dessen Kontaktdaten können Sie dem Impressum dieser Website entnehmen.</p>

<p><strong>Wie erfassen wir Ihre Daten?</strong></p>
<p>Ihre Daten werden zum einen dadurch erhoben, dass Sie uns diese mitteilen. Hierbei kann es sich z.B. um Daten handeln, die Sie in ein Kontaktformular eingeben.</p>

<p><strong>Wofür nutzen wir Ihre Daten?</strong></p>
<p>Ein Teil der Daten wird erhoben, um eine fehlerfreie Bereitstellung der Website zu gewährleisten. Andere Daten können zur Analyse Ihres Nutzerverhaltens verwendet werden.</p>

<h2>2. Hosting</h2>
<p>Diese Website wird extern gehostet. Die personenbezogenen Daten, die auf dieser Website erfasst werden, werden auf den Servern des Hosters gespeichert.</p>

<h2>3. Allgemeine Hinweise und Pflichtinformationen</h2>
<h3>Datenschutz</h3>
<p>Die Betreiber dieser Seiten nehmen den Schutz Ihrer persönlichen Daten sehr ernst. Wir behandeln Ihre personenbezogenen Daten vertraulich und entsprechend der gesetzlichen Datenschutzvorschriften sowie dieser Datenschutzerklärung.</p>`,
      updated_at: new Date()
    });
  }
  
  // Insert pages if any need to be added
  if (pagesToInsert.length > 0) {
    await knex('cms_pages').insert(pagesToInsert);
  }
};

exports.down = async function(knex) {
  // Don't remove CMS pages on rollback as they might have been customized
};