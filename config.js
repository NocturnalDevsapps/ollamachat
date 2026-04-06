// config.js - Frontend endpoint configuration
window.APP_CONFIG = {
  API_URL: '',
  API_PATH: '/api/chat',
  API_FALLBACK_URLS: [
    'http://127.0.0.1:3001/api/chat',
    'http://127.0.0.1:3002/api/chat',
    'http://127.0.0.1:3003/api/chat',
    'http://127.0.0.1:3004/api/chat',
    'http://127.0.0.1:3005/api/chat',
    'http://localhost:3001/api/chat',
    'http://localhost:3002/api/chat',
    'http://localhost:3003/api/chat',
    'http://localhost:3004/api/chat',
    'http://localhost:3005/api/chat'
  ],
  REQUEST_TIMEOUT_MS: 0
};
