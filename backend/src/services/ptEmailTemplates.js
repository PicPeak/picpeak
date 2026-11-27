'use strict';

/**
 * Brazilian Portuguese (pt) content for the email templates that had none,
 * keyed by template_key (issue 2617).
 *
 * One source for both paths that create pt rows: the boot seeders insert it
 * with a template they create (fresh installs), and migration 378 fills it in
 * for templates that already exist (upgrades). Neither ever overwrites a pt
 * row that has content. Every {{token}} matches the English template.
 */
const PT_EMAIL_TEMPLATES = {
  album_shipped: {
    subject: 'Seu álbum está a caminho{{#if event_name}}: {{event_name}}{{/if}}',
    body_html: `<h2>Seu álbum está a caminho</h2>
<p>Olá, {{customer_name}},</p>
<p>Enviamos <strong>{{product_name}}</strong>{{#if event_name}} referente a "{{event_name}}"{{/if}} pelo correio.</p>
<p>Código de rastreamento{{#if carrier_name}} ({{carrier_name}}){{/if}}: <strong>{{tracking_number}}</strong></p>
{{#if tracking_link}}<p style="text-align: center; margin: 30px 0;"><a href="{{tracking_link}}" class="button">Rastrear encomenda</a></p>{{/if}}
{{#if portal_link}}<p style="font-size: 13px; color: #666;">Você também encontra o envio no seu portal do cliente: {{portal_link}}</p>{{/if}}
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
    body_text: 'Olá, {{customer_name}},\n\nEnviamos {{product_name}}{{#if event_name}} referente a "{{event_name}}"{{/if}} pelo correio.\n\nCódigo de rastreamento{{#if carrier_name}} ({{carrier_name}}){{/if}}: {{tracking_number}}{{#if tracking_link}}\nRastrear encomenda: {{tracking_link}}{{/if}}{{#if portal_link}}\n\nSeu portal do cliente: {{portal_link}}{{/if}}{{#if business_name}}\n\n{{business_name}}{{/if}}',
  },
  archive_complete: {
    subject: 'Arquivamento concluído: {{event_name}}',
    body_html: `<h2>Arquivamento concluído</h2>
<p>Olá, {{host_name}},</p>
<p>A galeria de fotos "{{event_name}}" foi arquivada com sucesso.</p>
<p><strong>Detalhes do arquivo:</strong></p>
<ul>
  <li>Data do evento: {{event_date}}</li>
  <li>Arquivada em: {{archive_date}}</li>
  <li>Número de fotos: {{photo_count}}</li>
  <li>Tamanho do arquivo: {{archive_size}}</li>
</ul>
<p>O arquivo está armazenado com segurança e pode ser restaurado, se necessário.</p>
{{#if support_email}}<p>Dúvidas? Fale conosco em <a href="mailto:{{support_email}}">{{support_email}}</a>.</p>{{/if}}`,
    body_text: 'Arquivamento concluído\n\nOlá, {{host_name}},\n\nA galeria de fotos "{{event_name}}" foi arquivada com sucesso.\n\nData do evento: {{event_date}}\nArquivada em: {{archive_date}}\nNúmero de fotos: {{photo_count}}\nTamanho do arquivo: {{archive_size}}\n\nO arquivo está armazenado com segurança e pode ser restaurado, se necessário.\n\n{{#if support_email}}Dúvidas? Fale conosco em {{support_email}}.{{/if}}',
  },
  booking_request_admin: {
    subject: 'Nova solicitação de agendamento: {{service_name}} em {{booking_date}}',
    body_html: `<h2>Nova solicitação de agendamento</h2>
<p>{{client_name}} ({{client_email}}) solicita <strong>{{service_name}}</strong> em <strong>{{booking_date}}</strong> às <strong>{{booking_time}}</strong>. Estimativa: {{estimate}}.</p>
<p>O horário fica reservado até {{hold_until}}. Aceite a solicitação para criar o cliente, um projeto e um rascunho de orçamento.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_link}}" class="button">Abrir solicitação {{reference}}</a></p>`,
    body_text: '{{client_name}} ({{client_email}}) solicita {{service_name}} em {{booking_date}} às {{booking_time}}. Estimativa: {{estimate}}.\n\nO horário fica reservado até {{hold_until}}. Aceite a solicitação para criar o cliente, um projeto e um rascunho de orçamento.\n\nAbrir: {{admin_link}}',
  },
  booking_request_declined: {
    subject: 'Sua solicitação de agendamento {{reference}}',
    body_html: `<p>Olá, {{client_name}},</p>
<p>infelizmente não podemos atender <strong>{{service_name}}</strong> em {{booking_date}} às {{booking_time}}.</p>
{{#if decline_reason}}<p>{{decline_reason}}</p>{{/if}}
{{#if deposit_refunded}}<p>Seu sinal de {{deposit_refunded}} foi estornado no seu cartão.</p>{{/if}}
{{#if deposit_refund_pending}}<p>Vamos devolver seu sinal de {{deposit_refund_pending}} separadamente.</p>{{/if}}
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
    body_text: 'Olá, {{client_name}},\n\ninfelizmente não podemos atender {{service_name}} em {{booking_date}} às {{booking_time}}.{{#if decline_reason}}\n\n{{decline_reason}}{{/if}}{{#if deposit_refunded}}\n\nSeu sinal de {{deposit_refunded}} foi estornado no seu cartão.{{/if}}{{#if deposit_refund_pending}}\n\nVamos devolver seu sinal de {{deposit_refund_pending}} separadamente.{{/if}}{{#if business_name}}\n\n{{business_name}}{{/if}}',
  },
  booking_request_received: {
    subject: 'Sua solicitação de agendamento: {{service_name}} em {{booking_date}}',
    body_html: `<p>Olá, {{client_name}},</p>
<p>obrigado pela sua solicitação. Reservamos <strong>{{service_name}}</strong> em <strong>{{booking_date}}</strong> às <strong>{{booking_time}}</strong> para você até {{hold_until}}.</p>
<p>Preço estimado: <strong>{{estimate}}</strong>. Trata-se de uma estimativa: você receberá um orçamento com o preço final assim que analisarmos sua solicitação.</p>
<p>Sua referência: <strong>{{reference}}</strong></p>
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
    body_text: 'Olá, {{client_name}},\n\nobrigado pela sua solicitação. Reservamos {{service_name}} em {{booking_date}} às {{booking_time}} para você até {{hold_until}}.\n\nPreço estimado: {{estimate}}. Trata-se de uma estimativa: você receberá um orçamento com o preço final assim que analisarmos sua solicitação.\n\nSua referência: {{reference}}{{#if business_name}}\n\n{{business_name}}{{/if}}',
  },
  contract_data_request: {
    subject: 'Complete seus dados para o contrato {{contract_number}}',
    body_html: `<h2>Contrato {{contract_number}}</h2>
<p>Olá, {{customer_name}},</p>
<p>antes de enviarmos o contrato {{contract_number}} para você assinar, precisamos de alguns dados seus, como o seu endereço.</p>
<p style="text-align: center; margin: 30px 0;">
  <a href="{{response_url}}" class="button">Completar meus dados</a>
</p>
<p style="font-size: 13px; color: #666;">Primeiro, você confirma seu endereço de e-mail com um código. Assim que seus dados forem preenchidos, o contrato é preparado com eles e você pode lê-lo e assiná-lo na hora.</p>`,
    body_text: 'Antes de enviarmos o contrato {{contract_number}} para você assinar, precisamos de alguns dados seus.\n\nAbrir: {{response_url}}\n\nPrimeiro, você confirma seu endereço de e-mail com um código; depois, o contrato é preparado com seus dados e você pode assiná-lo.',
  },
  contract_declined_admin_notification: {
    subject: 'Contrato {{contract_number}} recusado por {{signer_name}}',
    body_html: `<h2>Contrato recusado</h2><p>{{signer_name}} recusou o contrato <strong>{{contract_number}}</strong>.</p>
{{#if reason}}<p>Motivo informado: {{reason}}</p>{{/if}}
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_dashboard_url}}" class="button">Abrir no painel</a></p>
<p style="font-size: 13px; color: #666;">Os links de assinatura deste contrato não funcionam mais. Crie um novo contrato se as condições precisarem mudar.</p>`,
    body_text: 'O contrato {{contract_number}} foi recusado por {{signer_name}}.{{#if reason}} Motivo: {{reason}}{{/if}} Abrir: {{admin_dashboard_url}}',
  },
  contract_expired_admin_notification: {
    subject: 'Contrato {{contract_number}} expirou sem assinatura',
    body_html: `<h2>Contrato expirado</h2><p>O prazo para assinar o contrato <strong>{{contract_number}}</strong> terminou antes que todos os signatários assinassem. Assinaturas já registradas: {{signed_count}}.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_dashboard_url}}" class="button">Abrir no painel</a></p>
<p style="font-size: 13px; color: #666;">Os links de assinatura dele não funcionam mais. Para seguir adiante, crie um novo contrato e envie-o.</p>`,
    body_text: 'O prazo para assinar o contrato {{contract_number}} terminou. Assinaturas já registradas: {{signed_count}}. Os links dele não funcionam mais; crie um novo contrato para seguir adiante. Abrir: {{admin_dashboard_url}}',
  },
  contract_fully_signed: {
    subject: 'Contrato {{contract_number}} assinado pelas duas partes',
    body_html: `<h2>Contrato {{contract_number}} — totalmente assinado</h2>
<p>Olá, {{customer_name}},</p>
<p>As duas partes já assinaram o contrato {{contract_number}}{{#if title}} — "{{title}}"{{/if}}. O PDF com todas as assinaturas segue em anexo para os seus registros.</p>
<p style="font-size: 13px; color: #666;">Esta é a via assinada oficial. Guarde-a junto com o orçamento e as faturas relacionadas.</p>`,
    body_text: 'O contrato {{contract_number}} foi assinado pelas duas partes. O PDF assinado segue em anexo para os seus registros.',
  },
  contract_sent: {
    subject: 'Contrato {{contract_number}} pronto para sua assinatura',
    body_html: `<h2>Contrato {{contract_number}}</h2>
<p>Olá, {{customer_name}},</p>
<p>Segue em anexo o contrato {{contract_number}}{{#if title}} — "{{title}}"{{/if}}{{#if event_name}} referente a "{{event_name}}"{{/if}}.</p>
<p>Você pode revisar e assinar o contrato diretamente no navegador pelo link abaixo:</p>
<p style="text-align: center; margin: 30px 0;">
  <a href="{{response_url}}" class="button">Revisar e assinar o contrato</a>
</p>
<p>Ou abra o contrato completo:<br>
<span style="word-break: break-all; font-size: 13px;">{{response_url}}</span></p>
{{#if valid_until}}<p style="font-size: 13px; color: #666;">Por favor, assine até {{valid_until}}.</p>{{/if}}`,
    body_text: 'Contrato {{contract_number}}\n\nOlá, {{customer_name}},\n\nRevise e assine o contrato {{contract_number}}.\n\nAbrir: {{response_url}}\n\n{{#if valid_until}}Por favor, assine até {{valid_until}}.{{/if}}',
  },
  contract_signature_received: {
    subject: 'Recebemos sua assinatura no contrato {{contract_number}}',
    body_html: `<h2>Assinatura recebida</h2>
<p>Olá, {{customer_name}},</p>
<p>sua assinatura no contrato {{contract_number}}{{#if title}} — "{{title}}"{{/if}} foi registrada em {{signed_at}}.</p>
<p>Assim que todos os signatários tiverem assinado{{#if issuer_name}} e {{issuer_name}} tiver contra-assinado{{/if}}, você receberá por e-mail o contrato final e o respectivo certificado de assinatura.</p>
<p style="font-size: 13px; color: #666;">Se você não assinou este contrato, responda a este e-mail imediatamente.</p>`,
    body_text: 'Sua assinatura no contrato {{contract_number}} foi registrada em {{signed_at}}. Assim que todos tiverem assinado, você receberá por e-mail o contrato final e o respectivo certificado de assinatura. Se você não o assinou, responda a este e-mail imediatamente.',
  },
  contract_signature_reminder: {
    subject: 'Lembrete: o contrato {{contract_number}} aguarda sua assinatura',
    body_html: `<h2>Contrato {{contract_number}}</h2>
<p>Olá, {{customer_name}},</p>
<p>o contrato {{contract_number}}{{#if title}} — "{{title}}"{{/if}} ainda aguarda sua assinatura.</p>
<p style="text-align: center; margin: 30px 0;">
  <a href="{{response_url}}" class="button">Revisar e assinar o contrato</a>
</p>
<p style="font-size: 13px; color: #666;">Este é um novo link. Os links de e-mails anteriores sobre este contrato não funcionam mais.</p>
{{#if valid_until}}<p style="font-size: 13px; color: #666;">Por favor, assine até {{valid_until}}.</p>{{/if}}`,
    body_text: 'O contrato {{contract_number}} ainda aguarda sua assinatura.\n\nAbrir: {{response_url}}\n\nEste é um novo link; os links de e-mails anteriores não funcionam mais.{{#if valid_until}} Por favor, assine até {{valid_until}}.{{/if}}',
  },
  contract_signed_admin_notification: {
    subject: 'Contrato {{contract_number}} assinado por {{customer_email}}',
    body_html: `<h2>Contrato assinado</h2><p>{{signed_customer_name}} ({{customer_email}}) acabou de assinar o contrato <strong>{{contract_number}}</strong>.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_dashboard_url}}" class="button">Abrir no painel</a></p>
<p style="font-size: 13px; color: #666;">O PDF assinado e as provas da assinatura (nome digitado, IP, data/hora e imagem da assinatura, se desenhada) estão disponíveis na página de detalhes do contrato. Para torná-lo plenamente válido, assine também como contratado ou envie uma via assinada à mão.</p>`,
    body_text: 'Contrato {{contract_number}} assinado por {{signed_customer_name}} ({{customer_email}}). Abrir: {{admin_dashboard_url}}',
  },
  contract_signing_code: {
    subject: 'Seu código para o contrato {{contract_number}}: {{code}}',
    body_html: `<h2>Seu código</h2>
<p>Olá, {{customer_name}},</p>
<p>Digite este código para abrir o contrato {{contract_number}}:</p>
<p style="font-size: 30px; font-weight: bold; letter-spacing: 8px; text-align: center; margin: 24px 0;">{{code}}</p>
<p style="font-size: 13px; color: #666;">O código é válido por {{ttl_minutes}} minutos. Se você não o solicitou, pode ignorar este e-mail.</p>`,
    body_text: 'Seu código para o contrato {{contract_number}}: {{code}}\n\nO código é válido por {{ttl_minutes}} minutos. Se você não o solicitou, pode ignorar este e-mail.',
  },
  contract_signing_suspicious_admin_notification: {
    subject: 'Atividade incomum nos links de assinatura de contratos',
    body_html: `<h2>Atividade incomum nos links de assinatura</h2>
<p>Na hora a partir de {{hour}}, as páginas de assinatura registraram <strong>{{count}}</strong> eventos do tipo <code>{{kind}}</code> vindos de uma mesma origem{{#if contract_number}} no contrato {{contract_number}}{{/if}} — o limite de alerta é {{limit}}.</p>
<p>Isso pode indicar alguém testando links ou códigos de assinatura que não foram enviados a essa pessoa. Os links continuam protegidos pelos códigos e por limites de tentativas; nada foi exposto. Se isso continuar, verifique a página System Health e os logs do seu proxy reverso.</p>
<p style="font-size: 13px; color: #666;">Você recebe no máximo um aviso destes por tipo a cada hora. Os limites ficam em Configurações → CRM → Contratos.</p>`,
    body_text: 'Na hora a partir de {{hour}}, as páginas de assinatura registraram {{count}} eventos do tipo {{kind}} vindos de uma mesma origem{{#if contract_number}} no contrato {{contract_number}}{{/if}} (limite {{limit}}). Nada foi exposto; verifique a System Health se isso continuar.',
  },
  customer_document_access_alert_admin: {
    subject: 'Acesso repetido a documentos de outros clientes: {{customer_name}}',
    body_html: `<h2>Acesso incomum a documentos</h2>
<p>Na última hora, {{customer_name}} solicitou ao portal {{attempt_count}} documentos que pertencem a outros clientes. Todos os acessos foram recusados.</p>
<p>Pode ser um link desatualizado, mas também é exatamente o que acontece quando alguém fica testando números de documentos. Se isso continuar, você pode desativar a conta no cadastro do cliente.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_link}}" class="button">Abrir o cadastro do cliente</a></p>`,
    body_text: 'Na última hora, {{customer_name}} solicitou ao portal {{attempt_count}} documentos que pertencem a outros clientes. Todos os acessos foram recusados.\n\nPode ser um link desatualizado, mas também é exatamente o que acontece quando alguém fica testando números de documentos. Se isso continuar, você pode desativar a conta no cadastro do cliente.\n\n{{admin_link}}',
  },
  customer_document_request_reminder: {
    subject: 'Lembrete: {{request_title}}',
    body_html: `<h2>Ainda pendente</h2>
<p>Olá, {{customer_name}},</p>
<p>Ainda estamos aguardando <strong>{{request_title}}</strong>. Por favor, envie o documento pelo seu portal do cliente.</p>
{{#if request_note}}<p>{{request_note}}</p>{{/if}}
{{#if due_date}}<p>Por favor, envie até {{due_date}}.</p>{{/if}}
<p style="text-align: center; margin: 30px 0;"><a href="{{upload_link}}" class="button">Enviar o documento</a></p>
<p style="font-size: 13px; color: #666;">Se você já enviou, pode desconsiderar este lembrete.</p>
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
    body_text: 'Olá, {{customer_name}},\n\nAinda estamos aguardando {{request_title}}. Por favor, envie o documento pelo seu portal do cliente.{{#if request_note}}\n\n{{request_note}}{{/if}}{{#if due_date}}\n\nPor favor, envie até {{due_date}}.{{/if}}\n\nEnviar: {{upload_link}}\n\nSe você já enviou, pode desconsiderar este lembrete.{{#if business_name}}\n\n{{business_name}}{{/if}}',
  },
  customer_document_requested: {
    subject: 'Por favor, envie-nos um documento: {{request_title}}',
    body_html: `<h2>Precisamos de um documento</h2>
<p>Olá, {{customer_name}},</p>
<p>Por favor, envie o seguinte documento pelo seu portal do cliente: <strong>{{request_title}}</strong>.</p>
{{#if request_note}}<p>{{request_note}}</p>{{/if}}
{{#if due_date}}<p>Por favor, envie até {{due_date}}.</p>{{/if}}
<p style="text-align: center; margin: 30px 0;"><a href="{{upload_link}}" class="button">Enviar o documento</a></p>
<p style="font-size: 13px; color: #666;">Será necessário fazer login primeiro.</p>
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
    body_text: 'Olá, {{customer_name}},\n\nPor favor, envie o seguinte documento pelo seu portal do cliente: {{request_title}}.{{#if request_note}}\n\n{{request_note}}{{/if}}{{#if due_date}}\n\nPor favor, envie até {{due_date}}.{{/if}}\n\nEnviar: {{upload_link}}\n(Será necessário fazer login primeiro.){{#if business_name}}\n\n{{business_name}}{{/if}}',
  },
  customer_document_reviewed: {
    subject: 'Seu documento não foi aceito: {{document_title}}',
    body_html: `<h2>Documento não aceito</h2>
<p>Olá, {{customer_name}},</p>
<p>O documento que você enviou, <strong>{{document_title}}</strong>, não foi aceito.</p>
{{#if review_note}}<p><strong>Motivo:</strong> {{review_note}}</p>{{/if}}
<p>Você pode enviar uma versão corrigida pelo seu portal do cliente.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{document_link}}" class="button">Abrir documento</a></p>
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
    body_text: 'Olá, {{customer_name}},\n\nO documento que você enviou, {{document_title}}, não foi aceito.{{#if review_note}}\nMotivo: {{review_note}}{{/if}}\n\nVocê pode enviar uma versão corrigida pelo seu portal do cliente: {{document_link}}{{#if business_name}}\n\n{{business_name}}{{/if}}',
  },
  customer_document_shared: {
    subject: 'Um novo documento está esperando por você: {{document_title}}',
    body_html: `<h2>Novo documento</h2>
<p>Olá, {{customer_name}},</p>
<p>Um documento foi compartilhado com você no seu portal do cliente: <strong>{{document_title}}</strong>{{#if event_name}} referente a "{{event_name}}"{{/if}}.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{document_link}}" class="button">Abrir documento</a></p>
<p style="font-size: 13px; color: #666;">Será necessário fazer login primeiro. Todos os seus documentos estão no seu portal: {{dashboard_link}}</p>
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
    body_text: 'Olá, {{customer_name}},\n\nUm documento foi compartilhado com você no seu portal do cliente: {{document_title}}{{#if event_name}} referente a "{{event_name}}"{{/if}}.\n\nAbrir: {{document_link}}\n(Será necessário fazer login primeiro.)\n\nTodos os seus documentos: {{dashboard_link}}{{#if business_name}}\n\n{{business_name}}{{/if}}',
  },
  customer_document_uploaded_admin: {
    subject: '{{customer_name}} enviou um documento: {{document_title}}',
    body_html: `<h2>Novo envio de cliente</h2>
<p>{{customer_name}} enviou <strong>{{document_title}}</strong> pelo portal do cliente. O documento fica indisponível para o cliente até ser revisado.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_link}}" class="button">Revisar no painel</a></p>`,
    body_text: '{{customer_name}} enviou {{document_title}} pelo portal do cliente. O documento fica indisponível para o cliente até ser revisado.\n\nRevisar: {{admin_link}}',
  },
  delivery_due_reminder: {
    subject: '{{#if overdue}}Atrasada{{/if}}{{#if due_soon}}Prazo próximo{{/if}}: galeria completa de {{event_name}}',
    body_html: `<h2>{{#if overdue}}Galeria completa atrasada{{/if}}{{#if due_soon}}Prazo da galeria completa se aproximando{{/if}}</h2>
<p>A galeria completa de "{{event_name}}" foi prometida para até <strong>{{due_date}}</strong>.</p>
<p>Até agora, {{delivered_count}} de aprox. {{expected_count}} fotos estão na galeria.</p>
<p>Quando a galeria estiver completa, marque-a como pronta para que o cliente seja avisado.</p>
<p><a href="{{admin_link}}">Abrir o evento</a></p>`,
    body_text: 'A galeria completa de "{{event_name}}" foi prometida para até {{due_date}}.\n\nAté agora, {{delivered_count}} de aprox. {{expected_count}} fotos estão na galeria.\n\nQuando a galeria estiver completa, marque-a como pronta para que o cliente seja avisado.\n\n{{admin_link}}',
  },
  download_ready: {
    subject: 'Seu download está pronto: {{event_name}}',
    body_html: `<h2>Seu download está pronto</h2>
<p>As fotos que você solicitou de "{{event_name}}" foram preparadas.</p>
<p><a href="{{gallery_link}}">Abra a galeria para baixá-las</a></p>
<p>O download fica disponível por mais cerca de {{available_hours}} hora(s). Depois disso, basta solicitá-lo novamente na galeria.</p>`,
    body_text: 'Seu download está pronto\n\nAs fotos que você solicitou de "{{event_name}}" foram preparadas.\n\nAbra a galeria para baixá-las: {{gallery_link}}\n\nO download fica disponível por mais cerca de {{available_hours}} hora(s). Depois disso, basta solicitá-lo novamente na galeria.',
  },
  event_reminder_birthday: {
    subject: '{{event_name}} em {{event_date}} — vamos alinhar?',
    body_html: `<p>Olá, {{customer_name}},</p>
<p>{{event_name}} está chegando: <strong>{{event_date}}</strong> — daqui a cerca de {{days_before}} dia(s). Vamos alinhar alguns pontos antes do dia:</p>
<ul>
  <li><strong>Número de convidados:</strong> quantas pessoas, aproximadamente? Isso nos ajuda a planejar as fotos de grupo e as espontâneas.</li>
  <li><strong>Programação:</strong> que horas será o parabéns? Queremos estar prontos para esse momento.</li>
  <li><strong>Tema ou traje:</strong> se houver, conte para acompanharmos o clima da festa.</li>
  <li><strong>Surpresas:</strong> algum convidado ou momento surpresa que devamos manter em segredo?</li>
</ul>
<p>Estamos ansiosos para celebrar — avise se algo mudou.</p>
<p style="margin-top: 24px;">Até breve,<br>{{business_name}}</p>`,
    body_text: 'Olá, {{customer_name}},\n\n{{event_name}} está chegando: {{event_date}} — daqui a cerca de {{days_before}} dia(s). Vamos alinhar:\n- Número de convidados: quantas pessoas, aproximadamente?\n- Programação: que horas será o parabéns?\n- Tema ou traje, se houver.\n- Surpresas que devamos manter em segredo?\n\nEstamos ansiosos para celebrar — avise se algo mudou.\n\nAté breve,\n{{business_name}}',
  },
  event_reminder_corporate: {
    subject: 'Preparação da cobertura: {{event_name}} em {{event_date}}',
    body_html: `<p>Olá, {{customer_name}},</p>
<p>{{event_name}} será em <strong>{{event_date}}</strong> — daqui a cerca de {{days_before}} dia(s). Para garantir que a cobertura atenda aos seus objetivos, alguns itens para confirmar:</p>
<ul>
  <li><strong>Briefing:</strong> para que serão as fotos — comunicação interna, kit de imprensa, redes sociais, site? Isso influencia enquadramentos e cortes.</li>
  <li><strong>Agenda / roteiro:</strong> quem fala e quando, além de momentos que mereçam destaque (premiações, painéis, perguntas e respostas).</li>
  <li><strong>Convidados VIP e marca:</strong> uma lista curta de nomes prioritários, além das diretrizes de logotipo/cores para manter a identidade consistente.</li>
  <li><strong>Acesso:</strong> entrada, doca de carga (se houver) e contato no local pela manhã. É preciso documento com foto ou credenciamento?</li>
  <li><strong>Confidencialidade:</strong> alguma sessão estritamente interna / sem fotos?</li>
  <li><strong>Entrega:</strong> prazo aproximado de que você precisa (seleção para imprensa em 24 h, galeria completa depois)?</li>
</ul>
<p>Se preferir, podemos fazer uma ligação rápida de 10 minutos antes do evento.</p>
<p style="margin-top: 24px;">Até breve,<br>{{business_name}}</p>`,
    body_text: 'Olá, {{customer_name}},\n\n{{event_name}} será em {{event_date}} — daqui a cerca de {{days_before}} dia(s). Para garantir que a cobertura atenda aos seus objetivos, alguns itens para confirmar:\n- Briefing: comunicação interna, kit de imprensa, redes sociais, site?\n- Agenda / roteiro: palestrantes, premiações, painéis, perguntas e respostas.\n- Convidados VIP e marca: nomes prioritários e diretrizes de logotipo/cores.\n- Acesso: entrada, doca de carga, contato no local. Precisa de documento com foto?\n- Confidencialidade: alguma sessão sem fotos?\n- Entrega: prazo aproximado (seleção para imprensa em 24 h, galeria completa depois)?\n\nSe preferir, podemos fazer uma ligação rápida de 10 minutos antes do evento.\n\nAté breve,\n{{business_name}}',
  },
  event_reminder_default: {
    subject: 'Lembrete: {{event_name}} em {{days_before}} dia(s)',
    body_html: `<p>Olá, {{customer_name}},</p>
<p>Passando para lembrar que <strong>{{event_name}}</strong> será em <strong>{{event_date}}</strong> — daqui a cerca de {{days_before}} dia(s).</p>
<p>Algumas coisas que nos ajudam a começar bem no dia:</p>
<ul>
  <li>Confirme o horário exato de início e o endereço (um link de localização ajuda muito).</li>
  <li>Avise se houver algo a que devamos ficar atentos — convidados importantes, surpresas, áreas restritas.</li>
  <li>Em locais fechados, um cantinho para montar o equipamento ajuda bastante.</li>
</ul>
<p>Se algo mudou desde a nossa última conversa, é só responder este e-mail.</p>
<p style="margin-top: 24px;">Até breve,<br>{{business_name}}</p>`,
    body_text: 'Olá, {{customer_name}},\n\nPassando para lembrar que {{event_name}} será em {{event_date}} — daqui a cerca de {{days_before}} dia(s).\n\nAlgumas coisas que nos ajudam a começar bem no dia:\n- Confirme o horário exato de início e o endereço.\n- Avise se houver algo a que devamos ficar atentos (convidados importantes, surpresas, áreas restritas).\n- Em locais fechados, um cantinho para montar o equipamento ajuda bastante.\n\nSe algo mudou desde a nossa última conversa, é só responder este e-mail.\n\nAté breve,\n{{business_name}}',
  },
  event_reminder_other: {
    subject: '{{event_name}} em {{event_date}} — preparação',
    body_html: `<p>Olá, {{customer_name}},</p>
<p>{{event_name}} será em <strong>{{event_date}}</strong> — daqui a cerca de {{days_before}} dia(s). Uma breve nota de preparação:</p>
<ul>
  <li><strong>Horário e endereço:</strong> por favor, confirme os dois — até pequenas mudanças afetam a chegada e a montagem.</li>
  <li><strong>Roteiro do dia:</strong> uma linha do tempo aproximada dos momentos principais (início, destaques, encerramento) nos ajuda a estar no lugar certo.</li>
  <li><strong>Espaço para montagem:</strong> em local fechado, um cantinho para o equipamento faz diferença.</li>
  <li><strong>Algo específico:</strong> pessoas prioritárias, coisas a evitar, traje, surpresas — é só nos avisar.</li>
</ul>
<p>Se algo mudou desde a nossa última conversa, é só responder este e-mail.</p>
<p style="margin-top: 24px;">Até breve,<br>{{business_name}}</p>`,
    body_text: 'Olá, {{customer_name}},\n\n{{event_name}} será em {{event_date}} — daqui a cerca de {{days_before}} dia(s). Uma breve nota de preparação:\n- Horário e endereço: por favor, confirme os dois.\n- Roteiro do dia: uma linha do tempo aproximada dos momentos principais.\n- Espaço para montagem: um cantinho para o equipamento, se for em local fechado.\n- Algo específico: pessoas prioritárias, coisas a evitar, traje, surpresas.\n\nSe algo mudou, é só responder este e-mail.\n\nAté breve,\n{{business_name}}',
  },
  event_reminder_wedding: {
    subject: 'Seu casamento em {{event_date}} — últimos detalhes',
    body_html: `<p>Olá, {{customer_name}},</p>
<p>O grande dia está chegando — <strong>{{event_date}}</strong>, daqui a cerca de {{days_before}} dia(s). Estamos ansiosos!</p>
<p>Um pequeno checklist para que a cobertura fotográfica flua tranquilamente:</p>
<ul>
  <li><strong>Cronograma:</strong> uma programação aproximada, hora a hora (making of → cerimônia → retratos → recepção → festa), nos ajuda a antecipar cada momento.</li>
  <li><strong>Fotos de família:</strong> uma lista curta das fotos de grupo indispensáveis (com nomes) deixa as fotos formais rápidas e sem estresse.</li>
  <li><strong>Espaço do making of:</strong> um ambiente com luz natural (perto de janelas) faz toda a diferença.</li>
  <li><strong>Surpresas:</strong> conte para nós, para estarmos no lugar certo na hora certa — e sem estragar a surpresa.</li>
  <li><strong>Logística:</strong> horário da cerimônia, endereço do local, informações de estacionamento e telefone do cerimonialista no dia.</li>
</ul>
<p>Se algo mudou desde a nossa última conversa — mesmo detalhes pequenos — é só responder este e-mail.</p>
<p style="margin-top: 24px;">Até breve,<br>{{business_name}}</p>`,
    body_text: 'Olá, {{customer_name}},\n\nO grande dia está chegando — {{event_date}}, daqui a cerca de {{days_before}} dia(s). Estamos ansiosos!\n\nUm pequeno checklist para que a cobertura fotográfica flua tranquilamente:\n- Cronograma: uma programação aproximada, hora a hora, nos ajuda a antecipar cada momento.\n- Fotos de família: uma lista curta das fotos de grupo indispensáveis (com nomes).\n- Espaço do making of: um ambiente com luz natural faz toda a diferença.\n- Surpresas: conte para nós — sem estragar nada.\n- Logística: horário da cerimônia, endereço, estacionamento e contato do cerimonialista.\n\nSe algo mudou desde a nossa última conversa, é só responder este e-mail.\n\nAté breve,\n{{business_name}}',
  },
  gallery_completed: {
    subject: 'Sua galeria completa está pronta: {{event_name}}',
    body_html: `<h2>Sua galeria completa está pronta</h2>
<p>Olá, {{host_name}},</p>
<p>Todas as fotos de "{{event_name}}" já estão na sua galeria: {{photo_count}} fotos, incluindo a prévia que você já recebeu.</p>
<p><a href="{{gallery_link}}">Abrir sua galeria</a></p>
{{#if expiry_date}}<p>A galeria fica disponível até {{expiry_date}}.</p>{{/if}}`,
    body_text: 'Sua galeria completa está pronta\n\nOlá, {{host_name}},\n\nTodas as fotos de "{{event_name}}" já estão na sua galeria: {{photo_count}} fotos, incluindo a prévia que você já recebeu.\n\nAbrir sua galeria: {{gallery_link}}{{#if expiry_date}}\n\nA galeria fica disponível até {{expiry_date}}.{{/if}}',
  },
  gallery_expired: {
    subject: 'Sua galeria de fotos expirou',
    body_html: `<h2>Galeria expirada</h2>
<p>Olá, {{host_name}},</p>
<p>Sua galeria de fotos "{{event_name}}" expirou em {{expiry_date}} e não está mais disponível on-line.</p>
<p>Suas fotos foram arquivadas com segurança — nada foi perdido.</p>
<p><strong>Detalhes da galeria:</strong></p>
<ul>
  <li>Data do evento: {{event_date}}</li>
  <li>Expirou em: {{expiry_date}}</li>
</ul>
{{#if support_email}}<p>Se precisar acessar as fotos arquivadas, fale conosco em <a href="mailto:{{support_email}}">{{support_email}}</a>.</p>{{/if}}`,
    body_text: 'Galeria expirada\n\nOlá, {{host_name}},\n\nSua galeria de fotos "{{event_name}}" expirou em {{expiry_date}} e não está mais disponível on-line.\n\nSuas fotos foram arquivadas com segurança — nada foi perdido.\n\nData do evento: {{event_date}}\nExpirou em: {{expiry_date}}\n\n{{#if support_email}}Se precisar acessar as fotos arquivadas, fale conosco em {{support_email}}.{{/if}}',
  },
  invoice_cancelled: {
    subject: 'Fatura {{invoice_number}} cancelada',
    body_html: '<p>Olá, {{customer_name}},</p><p>A fatura {{invoice_number}} foi cancelada. Desconsidere quaisquer lembretes anteriores referentes a ela.</p>',
    body_text: 'A fatura {{invoice_number}} foi cancelada.',
  },
  invoice_collections_handoff: {
    subject: 'Encaminhar para cobrança: fatura {{invoice_number}} continua em aberto após os lembretes',
    body_html: `<h2>Pronta para encaminhar à cobrança</h2>
<p>A fatura <strong>{{invoice_number}}</strong>{{#if event_name}} ({{event_name}}){{/if}} continua em aberto após {{reminder_level}} lembretes. O PDF da fatura segue em anexo para encaminhamento.</p>
<table role="presentation" cellpadding="6" cellspacing="0" border="0" style="border-collapse: collapse; margin: 16px 0;">
  <tr><td style="color:#666;">Cliente</td><td><strong>{{customer_name}}</strong></td></tr>
  {{#if customer_email}}<tr><td style="color:#666;">E-mail</td><td>{{customer_email}}</td></tr>{{/if}}
  {{#if customer_address}}<tr><td style="color:#666;">Endereço</td><td>{{customer_address}}</td></tr>{{/if}}
  <tr><td style="color:#666;">Vencimento</td><td>{{due_date}}</td></tr>
  <tr><td style="color:#666;">Valor original</td><td>{{original_amount}}</td></tr>
  {{#if late_fee_amount}}<tr><td style="color:#666;">Multas por atraso</td><td>{{late_fee_amount}}</td></tr>{{/if}}
  <tr><td style="color:#666;">Pago</td><td>{{paid_amount}}</td></tr>
  <tr><td style="color:#666;"><strong>Em aberto</strong></td><td><strong>{{outstanding_amount}}</strong></td></tr>
</table>
<p style="font-size:13px;color:#666;">Encaminhe à sua empresa de cobrança ou ao setor jurídico. Notificação automática.</p>`,
    body_text: 'Pronta para encaminhar à cobrança\n\nA fatura {{invoice_number}}{{#if event_name}} ({{event_name}}){{/if}} continua em aberto após {{reminder_level}} lembretes. O PDF da fatura segue em anexo.\n\n  Cliente:         {{customer_name}}{{#if customer_email}}\n  E-mail:          {{customer_email}}{{/if}}{{#if customer_address}}\n  Endereço:        {{customer_address}}{{/if}}\n  Vencimento:      {{due_date}}\n  Valor original:  {{original_amount}}{{#if late_fee_amount}}\n  Multas:          {{late_fee_amount}}{{/if}}\n  Pago:            {{paid_amount}}\n  Em aberto:       {{outstanding_amount}}\n\nEncaminhe à sua empresa de cobrança ou ao setor jurídico.',
  },
  invoice_paid_admin_notification: {
    subject: 'Pagamento recebido: fatura {{invoice_number}}',
    body_html: `<h2>Pagamento registrado</h2>
<p>A fatura <strong>{{invoice_number}}</strong> de <strong>{{customer_name}}</strong>{{#if event_name}} ({{event_name}}){{/if}} foi marcada como paga integralmente.</p>
<table role="presentation" cellpadding="6" cellspacing="0" border="0" style="border-collapse: collapse; margin: 16px 0;">
  <tr><td style="color: #666;">Valor total da fatura</td><td><strong>{{total_amount}}</strong></td></tr>
  <tr><td style="color: #666;">Total pago</td><td><strong>{{paid_amount}}</strong></td></tr>
  {{#if skonto_applied}}<tr><td style="color: #0d9488;">Pago com desconto antecipado ({{skonto_percent}}%)</td><td style="color: #0d9488;"><strong>−{{skonto_discount_amount}}</strong></td></tr>{{/if}}
  {{#if payment_method}}<tr><td style="color: #666;">Forma de pagamento</td><td>{{payment_method}}</td></tr>{{/if}}
  {{#if payment_reference}}<tr><td style="color: #666;">Referência</td><td>{{payment_reference}}</td></tr>{{/if}}
  <tr><td style="color: #666;">Registrado em</td><td>{{paid_at}}</td></tr>
</table>
<p style="font-size: 13px; color: #666;">Esta é uma notificação automática — nenhuma ação é necessária.</p>`,
    body_text: 'Pagamento registrado\n\nA fatura {{invoice_number}} de {{customer_name}}{{#if event_name}} ({{event_name}}){{/if}} foi marcada como paga integralmente.\n\n  Valor total da fatura:   {{total_amount}}\n  Total pago:              {{paid_amount}}{{#if skonto_applied}}\n  Pago com desconto antecipado ({{skonto_percent}}%): -{{skonto_discount_amount}}{{/if}}{{#if payment_method}}\n  Forma de pagamento:      {{payment_method}}{{/if}}{{#if payment_reference}}\n  Referência:              {{payment_reference}}{{/if}}\n  Registrado em:           {{paid_at}}\n\nEsta é uma notificação automática — nenhuma ação é necessária.',
  },
  invoice_paid_receipt: {
    subject: 'Recibo da fatura {{invoice_number}}',
    body_html: `<h2>Pagamento recebido</h2><p>Olá, {{customer_name}},</p>
<p>Recebemos seu pagamento de <strong>{{paid_amount}}</strong> referente à fatura {{invoice_number}} em {{paid_at}}. Muito obrigado!</p>`,
    body_text: 'Recibo: {{paid_amount}} recebido referente à fatura {{invoice_number}} em {{paid_at}}.',
  },
  invoice_payment_check: {
    subject: 'Verifique o pagamento da fatura {{invoice_number}}',
    body_html: `<h2>Hora de verificar um pagamento</h2>
<p>A fatura <strong>{{invoice_number}}</strong> de <strong>{{customer_name}}</strong>{{#if event_name}} ({{event_name}}){{/if}} venceu em <strong>{{due_date}}</strong>. Total: <strong>{{total_amount}}</strong>.</p>
<p>Confira no seu banco o que foi recebido (se algo foi) e clique no botão correspondente abaixo — não é preciso fazer login.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 24px auto; border-collapse: collapse;">
  <tr>
    <td style="padding: 0 6px;">
      <a href="{{paid_url}}" style="background: #16a34a; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Pago integralmente</a>
    </td>
    {{#if has_skonto}}<td style="padding: 0 6px;">
      <a href="{{skonto_url}}" style="background: #0d9488; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Pago com desconto antecipado ({{skonto_amount}})</a>
    </td>{{/if}}
    <td style="padding: 0 6px;">
      <a href="{{partial_url}}" style="background: #2563eb; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Pago parcialmente</a>
    </td>
    <td style="padding: 0 6px;">
      <a href="{{unpaid_url}}" style="background: #dc2626; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Ainda não pago</a>
    </td>
  </tr>
</table>
<p style="font-size: 13px; color: #666;">Se você escolher "Ainda não pago" ou "Pago parcialmente", o sistema colocará na fila o próximo lembrete ao cliente{{#if late_fee_due}}, incluindo uma multa por atraso de {{late_fee_amount}}{{/if}}.</p>`,
    body_text: 'Hora de verificar um pagamento\n\nA fatura {{invoice_number}} de {{customer_name}}{{#if event_name}} ({{event_name}}){{/if}} venceu em {{due_date}}. Total: {{total_amount}}.\n\nConfirme o que foi recebido:\n  Pago integralmente:     {{paid_url}}{{#if has_skonto}}\n  Pago com desconto antecipado ({{skonto_amount}}): {{skonto_url}}{{/if}}\n  Parcial:                {{partial_url}}\n  Ainda não pago:         {{unpaid_url}}\n\nEscolher "Ainda não pago" ou "Pago parcialmente" coloca na fila o lembrete ao cliente{{#if late_fee_due}}, incluindo uma multa por atraso de {{late_fee_amount}}{{/if}}.',
  },
  invoice_payment_check_action_recorded: {
    subject: 'Ação de verificação de pagamento registrada: fatura {{invoice_number}}',
    body_html: `<h2>Link de verificação de pagamento usado</h2>
<p>Alguém usou o link de verificação de pagamento (sem login) da fatura <strong>{{invoice_number}}</strong>{{#if customer_name}} ({{customer_name}}){{/if}}{{#if event_name}}, {{event_name}}{{/if}} e registrou: <strong>{{action}}</strong>{{#if has_amount}} ({{amount}}){{/if}}.</p>
<table role="presentation" cellpadding="6" cellspacing="0" border="0" style="border-collapse: collapse; margin: 16px 0;">
  <tr><td style="color: #666;">Ação</td><td><strong>{{action}}</strong></td></tr>
  {{#if has_amount}}<tr><td style="color: #666;">Valor</td><td>{{amount}}</td></tr>{{/if}}
  <tr><td style="color: #666;">Endereço IP</td><td>{{ip}}</td></tr>
  <tr><td style="color: #666;">Registrado em</td><td>{{recorded_at}}</td></tr>
</table>
<p style="font-size: 13px; color: #666;">Este link não exige login — apenas o token da URL. Se você não reconhece esta ação, revise a fatura no painel administrativo.</p>`,
    body_text: 'Link de verificação de pagamento usado\n\nFatura {{invoice_number}}{{#if customer_name}} ({{customer_name}}){{/if}}{{#if event_name}}, {{event_name}}{{/if}} — registrado: {{action}}{{#if has_amount}} ({{amount}}){{/if}}.\n\n  Endereço IP:    {{ip}}\n  Registrado em:  {{recorded_at}}\n\nEste link não exige login — apenas o token da URL. Se você não reconhece esta ação, revise a fatura no painel administrativo.',
  },
  invoice_reminder_first: {
    subject: 'Lembrete: a fatura {{invoice_number}} está vencida',
    body_html: `<h2>Lembrete de pagamento</h2><p>Olá, {{customer_name}},</p>
<p>Nossos registros mostram que a fatura <strong>{{invoice_number}}</strong> (vencimento original em {{due_date}}) está vencida há {{days_overdue}} dias. O valor em aberto é <strong>{{total_amount}}</strong>.</p>
<p>Se você já realizou o pagamento, desconsidere este lembrete. Caso contrário, segue em anexo uma nova via.</p>`,
    body_text: 'A fatura {{invoice_number}} está vencida há {{days_overdue}} dias. Valor em aberto: {{total_amount}}.',
  },
  invoice_reminder_second: {
    subject: 'Segundo lembrete: fatura {{invoice_number}}',
    body_html: `<h2>Segundo lembrete de pagamento</h2><p>Olá, {{customer_name}},</p>
<p>A fatura <strong>{{invoice_number}}</strong> está vencida há {{days_overdue}} dias. Conforme previsto em nossas condições de pagamento, foi acrescentada uma multa por atraso de <strong>{{late_fee_amount}}</strong>. O novo total é <strong>{{new_total_amount}}</strong>.</p>
<p>Pedimos que o valor em aberto seja quitado o quanto antes. Segue em anexo a fatura atualizada.</p>`,
    body_text: 'Segundo lembrete da fatura {{invoice_number}}. Multa por atraso de {{late_fee_amount}} acrescentada. Novo total: {{new_total_amount}}.',
  },
  invoice_sent: {
    subject: 'Fatura {{invoice_number}} — {{total_amount}}',
    body_html: `<h2>Fatura {{invoice_number}}</h2><p>Olá, {{customer_name}},</p>
<p>Segue em anexo a fatura {{invoice_number}}{{#if event_name}} referente a "{{event_name}}"{{/if}}.</p>
<p><strong>Valor:</strong> {{total_amount}}<br><strong>Vencimento:</strong> {{due_date}}{{#if installment_label}}<br><strong>Parcela:</strong> {{installment_label}} ({{installment_index}}/{{installment_total}}){{/if}}</p>
<p>Os dados para pagamento estão no PDF em anexo.</p>`,
    body_text: 'Fatura {{invoice_number}}: {{total_amount}}, vencimento em {{due_date}}.',
  },
  photo_purchase_access: {
    subject: 'Suas fotos compradas estão prontas para download',
    body_html: `<h2>Suas fotos estão prontas para download</h2>
<p>Obrigado pela sua compra!</p>
<p>As fotos que você comprou da galeria <strong>{{gallery_name}}</strong> estão prontas. Você pode baixá-las em qualidade máxima — sem marca d'água — na sua página de acesso pessoal:</p>
<p style="text-align: center; margin: 30px 0;">
  <a href="{{access_link}}" class="button">Baixar minhas fotos</a>
</p>
<p style="font-size: 13px; color: #666;">Se o botão não funcionar, copie e cole este link no seu navegador:<br>
<span style="word-break: break-all;">{{access_link}}</span></p>
<ul>
  <li>Fotos: {{photo_count}}</li>
  <li>Compradas em: {{purchased_at}}</li>
  <li>Acesso expira em: {{expires_at}}</li>
</ul>
<p style="font-size: 13px; color: #666;">Você pode baixar suas fotos quantas vezes quiser até o acesso expirar.</p>
{{#if support_email}}<p>Dúvidas? Fale conosco em <a href="mailto:{{support_email}}">{{support_email}}</a>.</p>{{/if}}`,
    body_text: 'Suas fotos estão prontas para download\n\nObrigado pela sua compra!\n\nAs fotos que você comprou da galeria {{gallery_name}} estão prontas. Baixe-as em qualidade máxima — sem marca d\'água — na sua página de acesso pessoal:\n\n{{access_link}}\n\nFotos: {{photo_count}}\nCompradas em: {{purchased_at}}\nAcesso expira em: {{expires_at}}\n\nVocê pode baixar suas fotos quantas vezes quiser até o acesso expirar.\n\n{{#if support_email}}Dúvidas? Fale conosco em {{support_email}}.{{/if}}',
  },
  photo_purchase_paused: {
    subject: 'Compra confirmada — downloads temporariamente indisponíveis',
    body_html: `<h2>Sua compra foi concluída com sucesso</h2>
<p>Obrigado por comprar {{photo_count}} fotos da galeria <strong>{{gallery_name}}</strong>.</p>
<p>Esta galeria está temporariamente indisponível. Sua compra continua válida. Use este mesmo link quando a galeria estiver disponível novamente:</p>
<p><a href="{{access_link}}" class="button">Ver minha compra</a></p>
<p>{{access_link}}</p>
<p>O tempo perdido durante a pausa será acrescentado ao seu prazo de download quando a galeria voltar.</p>
{{#if expiry_date}}<p>A data de expiração da galeria continua sendo o prazo final: {{expiry_date}}.</p>{{/if}}
{{#if support_email}}<p>Para mais informações, entre em contato pelo e-mail <a href="mailto:{{support_email}}">{{support_email}}</a>.</p>{{/if}}`,
    body_text: 'Sua compra foi concluída com sucesso\n\nObrigado por comprar {{photo_count}} fotos da galeria {{gallery_name}}.\n\nEsta galeria está temporariamente indisponível. Sua compra continua válida. Use este mesmo link quando a galeria estiver disponível novamente:\n{{access_link}}\n\nO tempo perdido durante a pausa será acrescentado ao seu prazo de download quando a galeria voltar.\n\n{{#if expiry_date}}A data de expiração da galeria continua sendo o prazo final: {{expiry_date}}.{{/if}}\n\n{{#if support_email}}Para mais informações, entre em contato pelo e-mail {{support_email}}.{{/if}}',
  },
  quote_accepted_admin: {
    subject: 'Orçamento {{quote_number}} aceito por {{customer_email}}',
    body_html: `<h2>Orçamento aceito</h2><p>{{customer_email}} acabou de aceitar o orçamento <strong>{{quote_number}}</strong>{{#if event_name}} referente a "{{event_name}}"{{/if}}. Total: {{total_amount}}.</p>
{{#if booked_add_ons}}<p>Adicionais contratados: {{booked_add_ons}}</p>{{/if}}
{{#if customer_message}}<p><strong>Mensagem do cliente:</strong><br>{{customer_message}}</p>{{/if}}
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_dashboard_url}}" class="button">Abrir no painel</a></p>`,
    body_text: 'Orçamento {{quote_number}} aceito por {{customer_email}}.{{#if booked_add_ons}} Adicionais contratados: {{booked_add_ons}}.{{/if}}{{#if customer_message}} Mensagem: {{customer_message}}{{/if}} Abrir: {{admin_dashboard_url}}',
  },
  quote_accepted_customer: {
    subject: 'Orçamento {{quote_number}} aceito — obrigado!',
    body_html: `<h2>Obrigado!</h2>
<p>Olá, {{customer_name}},</p>
<p>Confirmamos que o orçamento <strong>{{quote_number}}</strong>{{#if event_name}} referente a "{{event_name}}"{{/if}} foi aceito. Total: <strong>{{total_amount}}</strong>.</p>
{{#if accepted_on_behalf}}<p style="font-size: 13px; color: #666;">Este aceite foi registrado em seu nome pelo seu fotógrafo.</p>{{/if}}
<p>Em breve entraremos em contato com os próximos passos.</p>`,
    body_text: 'Olá, {{customer_name}},\n\nConfirmamos que o orçamento {{quote_number}}{{#if event_name}} referente a "{{event_name}}"{{/if}} foi aceito. Total: {{total_amount}}.\n{{#if accepted_on_behalf}}\nEste aceite foi registrado em seu nome pelo seu fotógrafo.\n{{/if}}\nEm breve entraremos em contato com os próximos passos.',
  },
  quote_addons_updated: {
    subject: 'Seu orçamento {{quote_number}} foi atualizado',
    body_html: `<h2>Orçamento {{quote_number}} atualizado</h2>
<p>Olá, {{customer_name}},</p>
<p>atualizamos os adicionais do seu orçamento aceito {{quote_number}}{{#if event_name}} referente a "{{event_name}}"{{/if}}.</p>
{{#if booked_list}}<p>Contratados agora: {{booked_list}}</p>{{/if}}
{{#if removed_list}}<p>Não mais contratados: {{removed_list}}</p>{{/if}}
<p>Novo total: <strong>{{total_amount}}</strong>.{{#if has_pdf}} O orçamento atualizado segue em anexo.{{/if}}</p>`,
    body_text: 'Orçamento {{quote_number}} atualizado\n\nOlá, {{customer_name}},\n\natualizamos os adicionais do seu orçamento aceito {{quote_number}}.\n{{#if booked_list}}Contratados agora: {{booked_list}}\n{{/if}}{{#if removed_list}}Não mais contratados: {{removed_list}}\n{{/if}}\nNovo total: {{total_amount}}.{{#if has_pdf}} O orçamento atualizado segue em anexo.{{/if}}',
  },
  quote_declined_admin: {
    subject: 'Orçamento {{quote_number}} recusado por {{customer_email}}',
    body_html: `<p>{{customer_email}} recusou o orçamento <strong>{{quote_number}}</strong>{{#if event_name}} referente a "{{event_name}}"{{/if}}.</p>
<p><a href="{{admin_dashboard_url}}">Abrir o orçamento no painel</a></p>`,
    body_text: 'Orçamento {{quote_number}} recusado por {{customer_email}}. Abrir: {{admin_dashboard_url}}',
  },
  quote_sent: {
    subject: 'Seu orçamento {{quote_number}} está pronto',
    body_html: `<h2>Orçamento {{quote_number}}</h2>
<p>Olá, {{customer_name}},</p>
<p>Segue em anexo o orçamento {{quote_number}}{{#if event_name}} referente a "{{event_name}}"{{/if}}. Valor total: <strong>{{total_amount}}</strong>.</p>
{{#if has_add_ons}}<p>Este orçamento inclui adicionais opcionais. Escolha-os on-line antes de aceitar.</p>{{/if}}
<p>Você pode aceitar ou recusar este orçamento diretamente pelos botões abaixo:</p>
<p style="text-align: center; margin: 30px 0;">
  <a href="{{accept_url}}" class="button">Aceitar orçamento</a>
  &nbsp;
  <a href="{{decline_url}}" style="display:inline-block;padding:10px 20px;color:#666;text-decoration:underline;">Recusar</a>
</p>
<p>Ou abra o orçamento completo no navegador:<br>
<span style="word-break: break-all; font-size: 13px;">{{response_url}}</span></p>
{{#if valid_until}}<p style="font-size: 13px; color: #666;">Este orçamento é válido até {{valid_until}}.</p>{{/if}}`,
    body_text: 'Orçamento {{quote_number}}\n\nOlá, {{customer_name}},\n\nSegue em anexo o orçamento {{quote_number}}. Total: {{total_amount}}.\n\n{{#if has_add_ons}}Este orçamento inclui adicionais opcionais. Escolha-os on-line antes de aceitar.\n\n{{/if}}Responder: {{response_url}}\nAceitar: {{accept_url}}\nRecusar: {{decline_url}}\n\n{{#if valid_until}}Válido até {{valid_until}}.{{/if}}',
  },
  selection_submitted: {
    subject: '{{#if is_selection}}Seleção concluída{{/if}}{{#if is_approval}}Fotos editadas aprovadas{{/if}}: {{event_name}}',
    body_html: `<h2>{{#if is_selection}}Seleção concluída{{/if}}{{#if is_approval}}Fotos editadas aprovadas{{/if}}</h2>
<p>Galeria: "{{event_name}}"</p>
{{#if guest_name}}<p>Convidado: {{guest_name}}</p>{{/if}}
{{#if is_selection}}<p>Fotos selecionadas: <strong>{{item_count}}</strong></p>
<p>As escolhas ficam bloqueadas para este convidado até você reabrir a seleção.</p>{{/if}}
{{#if is_approval}}<p>Fotos aprovadas: <strong>{{item_count}}</strong></p>{{/if}}
{{#if rejected_count}}<p>Fotos rejeitadas: {{rejected_count}}</p>{{/if}}
{{#if is_approval}}<p>As decisões ficam bloqueadas para este convidado até você reabrir a aprovação.</p>{{/if}}
{{#if note}}<p>Observação: {{note}}</p>{{/if}}
<p><a href="{{admin_link}}">Abrir a galeria</a></p>`,
    body_text: '{{#if is_selection}}Seleção concluída{{/if}}{{#if is_approval}}Fotos editadas aprovadas{{/if}}\n\nGaleria: "{{event_name}}"{{#if guest_name}}\nConvidado: {{guest_name}}{{/if}}{{#if is_selection}}\nFotos selecionadas: {{item_count}}\n\nAs escolhas ficam bloqueadas para este convidado até você reabrir a seleção.{{/if}}{{#if is_approval}}\nFotos aprovadas: {{item_count}}{{/if}}{{#if rejected_count}}\nFotos rejeitadas: {{rejected_count}}{{/if}}{{#if is_approval}}\n\nAs decisões ficam bloqueadas para este convidado até você reabrir a aprovação.{{/if}}{{#if note}}\n\nObservação: {{note}}{{/if}}\n\n{{admin_link}}',
  },
  storno_issued: {
    subject: 'Fatura de estorno {{storno_number}} referente à fatura {{original_invoice_number}}',
    body_html: `<p>Olá, {{customer_name}},</p>
<p>Segue em anexo a fatura de estorno <strong>{{storno_number}}</strong>, que anula formalmente a fatura <strong>{{original_invoice_number}}</strong> de {{original_issue_date}}, no valor de {{total_amount}}.</p>
<p>A fatura original não deve mais ser paga. Guarde o PDF anexo para os seus registros e desconsidere lembretes anteriores.</p>`,
    body_text: 'A fatura de estorno {{storno_number}} anula formalmente a fatura {{original_invoice_number}} de {{original_issue_date}}, no valor de {{total_amount}}. A fatura original não deve mais ser paga. PDF em anexo.',
  },
  transfer_files_received: {
    subject: 'Arquivos recebidos — {{transfer_title}}',
    body_html: `
<h2>Arquivos recebidos</h2>

<p>{{file_count}} arquivo(s) foram enviados para <strong>{{transfer_title}}</strong>.</p>

<p><strong>Recebido em:</strong> {{received_at}}<br>
<strong>Arquivos nesta solicitação até agora:</strong> {{total_count}}</p>

<p style="margin: 24px 0;">
  <a href="{{admin_url}}" class="button">Abrir no PicPeak</a>
</p>

<p style="color: #888; font-size: 13px;">Os arquivos enviados são armazenados como estão e nunca são abertos nem processados pelo PicPeak. Verifique-os com um antivírus antes de usá-los.</p>

<p>Atenciosamente,<br>
Sua instalação do PicPeak</p>`,
    body_text: 'Arquivos recebidos\n\n{{file_count}} arquivo(s) foram enviados para {{transfer_title}}.\n\nRecebido em: {{received_at}}\nArquivos nesta solicitação até agora: {{total_count}}\n\nAbrir no PicPeak: {{admin_url}}\n\nOs arquivos enviados são armazenados como estão e nunca são abertos nem processados pelo PicPeak. Verifique-os com um antivírus antes de usá-los.\n\nAtenciosamente,\nSua instalação do PicPeak',
  },
  transfer_link_expired: {
    subject: 'Um link de transferência expirou — {{transfer_title}}',
    body_html: `
<h2>Um link de transferência expirou</h2>

<p>A seguinte transferência de arquivos não pode mais ser baixada pelo destinatário:</p>

<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;"><strong>Transferência:</strong> {{transfer_title}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Expirou em:</strong> {{expiry_date}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Arquivos incluídos:</strong> {{file_count}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Envios do cliente recebidos:</strong> {{upload_count}}</p>
</div>

<p>Os arquivos serão mantidos por mais {{grace_days}} dias (até {{delete_date}})
para que você possa compartilhá-los novamente ou recuperar o que ainda precisar; depois disso,
eles são excluídos automaticamente.</p>

<p><a href="{{admin_url}}">Abrir o PicTransfer na área administrativa</a></p>

<p>Atenciosamente,<br>
Sua instalação do PicPeak</p>`,
    body_text: 'Um link de transferência expirou\n\nA seguinte transferência de arquivos não pode mais ser baixada pelo destinatário:\n\nTransferência: {{transfer_title}}\nExpirou em: {{expiry_date}}\nArquivos incluídos: {{file_count}}\nEnvios do cliente recebidos: {{upload_count}}\n\nOs arquivos serão mantidos por mais {{grace_days}} dias (até {{delete_date}}) para\nque você possa compartilhá-los novamente ou recuperar o que ainda precisar; depois disso,\neles são excluídos automaticamente.\n\nAbrir o PicTransfer na área administrativa: {{admin_url}}\n\nAtenciosamente,\nSua instalação do PicPeak',
  },
  transfer_ready: {
    subject: '{{transfer_title}} — seus arquivos estão prontos para download',
    body_html: `
<h2>Seus arquivos estão prontos</h2>

<p>Olá,</p>

<p>{{transfer_title}} está pronto para você — baixe tudo com um único clique abaixo.</p>

{{#if message}}
<div style="background-color: #f6f6f4; border-left: 4px solid #5C8762; padding: 16px 20px; margin: 20px 0; border-radius: 4px; white-space: pre-line;">{{message}}</div>
{{/if}}

<p style="margin: 28px 0;">
  <a href="{{download_url}}" class="button">Baixar seus arquivos</a>
</p>

<p style="color: #555555;">O link fica ativo até {{expiry_date}} e inclui {{file_count}} arquivo(s).</p>

<p style="color: #999999; font-size: 13px;">O botão não funciona? Basta copiar este link no seu navegador:<br>{{download_url}}</p>

<p>Aproveite suas fotos!</p>`,
    body_text: 'Seus arquivos estão prontos\n\nOlá,\n\n{{transfer_title}} está pronto para você — baixe tudo pelo link abaixo.\n{{#if message}}\n\n{{message}}\n{{/if}}\n\nBaixar seus arquivos:\n{{download_url}}\n\nO link fica ativo até {{expiry_date}} e inclui {{file_count}} arquivo(s).\n\nAproveite suas fotos!',
  },
  transfer_request: {
    subject: 'Por favor, envie seus arquivos — {{transfer_title}}',
    body_html: `
<h2>Por favor, envie seus arquivos</h2>

<p>{{transfer_title}}</p>

{{#if message}}<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;">{{message}}</p>
</div>{{/if}}

<p style="margin: 24px 0;">
  <a href="{{upload_url}}" class="button">Enviar seus arquivos</a>
</p>

<p><strong>Envie até:</strong> {{expiry_date}}</p>

<p style="color: #888; font-size: 13px;">Se o botão não funcionar, copie este link no seu navegador:<br>{{upload_url}}</p>

<p>Atenciosamente,<br>
Sua instalação do PicPeak</p>`,
    body_text: 'Por favor, envie seus arquivos\n\n{{transfer_title}}\n{{#if message}}\n{{message}}\n{{/if}}\nEnviar seus arquivos: {{upload_url}}\n\nEnvie até: {{expiry_date}}\n\nAtenciosamente,\nSua instalação do PicPeak',
  },
};

module.exports = { PT_EMAIL_TEMPLATES };
