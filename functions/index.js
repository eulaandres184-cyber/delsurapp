const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

initializeApp();

const ADMIN_PIN = '2026';

exports.adminLogin = onCall((request) => {
  if (request.data?.pin !== ADMIN_PIN) {
    throw new HttpsError('permission-denied', 'Credenciales invalidas.');
  }

  return getAuth().createCustomToken('admin-user', { admin: true })
    .then((token) => ({ token }));
});