// Читает .env (простой парсер, без зависимостей)
const fs = require('fs');
const path = require('path');
try {
  for (const line of fs.readFileSync(path.join(__dirname,'.env'),'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
} catch (_) { /* .env нет — используем переменные окружения */ }

module.exports = {
  twitch: {
    id: process.env.TWITCH_CLIENT_ID || '',
    secret: process.env.TWITCH_CLIENT_SECRET || '',
    redirect: process.env.TWITCH_REDIRECT || 'http://localhost:3000/auth/twitch/callback',
  },
  da: {
    id: process.env.DA_CLIENT_ID || '',
    secret: process.env.DA_CLIENT_SECRET || '',
    redirect: process.env.DA_REDIRECT || 'http://localhost:3000/auth/da/callback',
  },
  pointsPerRub: parseInt(process.env.POINTS_PER_RUB || '100', 10),
  port: parseInt(process.env.PORT || '3000', 10),
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  sessionSecret: process.env.SESSION_SECRET || 'hollyauc-dev-secret',
};