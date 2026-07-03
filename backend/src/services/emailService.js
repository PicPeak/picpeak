const nodemailer = require('nodemailer');
const { db } = require('../database/db');
const { emailTemplates } = require('./emailTemplates');
const logger = require('../utils/logger');

// Create transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

async function sendEmail(to, type, data) {
  try {
    const template = emailTemplates[type](data);
    
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: to,
      subject: template.subject,
      html: template.html,
      text: template.text
    });
    
    logger.info(`Email sent: ${info.messageId}`);
    return info;
  } catch (error) {
    logger.error('Error sending email:', error);
    throw error;
  }
}

// Process email queue
async function processEmailQueue() {
  const pendingEmails = await db('email_queue')
    .where('status', 'pending')
    .where('retry_count', '<', 3)
    .limit(10);
  
  for (const email of pendingEmails) {
    try {
      const emailData = JSON.parse(email.email_data);
      await sendEmail(email.recipient_email, email.email_type, emailData);
      
      await db('email_queue').where('id', email.id).update({
        status: 'sent',
        sent_at: new Date()
      });
    } catch (error) {
      await db('email_queue').where('id', email.id).update({
        retry_count: email.retry_count + 1,
        error_message: error.message
      });
    }
  }
}

// Start email queue processor
// DISABLED: Using emailProcessor.js instead to prevent duplicate connections
// setInterval(processEmailQueue, 60000); // Process every minute

module.exports = { sendEmail, processEmailQueue };
