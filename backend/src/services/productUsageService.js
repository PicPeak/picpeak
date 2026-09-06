const { db } = require('../database/db');
const { UsageService } = require('../usage/UsageService');
module.exports = new UsageService(db);
