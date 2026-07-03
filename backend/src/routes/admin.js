const express = require('express');
const router = express.Router();

// Import sub-routers
const dashboardRoutes = require('./adminDashboard');
const archiveRoutes = require('./adminArchives');
const emailRoutes = require('./adminEmail');
const settingsRoutes = require('./adminSettings');
const eventsRoutes = require('./adminEvents');
const photosRoutes = require('./adminPhotos');
const categoriesRoutes = require('./adminCategories');
const cmsRoutes = require('./adminCMS');
const notificationsRoutes = require('./adminNotifications');
const backupRoutes = require('./adminBackup');
const restoreRoutes = require('./adminRestore');

// Mount sub-routers
router.use('/dashboard', dashboardRoutes);
router.use('/archives', archiveRoutes);
router.use('/email', emailRoutes);
router.use('/settings', settingsRoutes);
router.use('/events', eventsRoutes);
router.use('/events', photosRoutes);
router.use('/categories', categoriesRoutes);
router.use('/cms', cmsRoutes);
router.use('/notifications', notificationsRoutes);
router.use('/backup', backupRoutes);
router.use('/restore', restoreRoutes);

module.exports = router;