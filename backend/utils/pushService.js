const webpush = require('web-push');

const publicKey = process.env.VAPID_PUBLIC_KEY;
const privateKey = process.env.VAPID_PRIVATE_KEY;

if (publicKey && privateKey) {
  webpush.setVapidDetails(
    'mailto:pramodofficial055@gmail.com',
    publicKey,
    privateKey
  );
  console.log('✓ VAPID keys loaded. Push notifications enabled.');
} else {
  console.warn('⚠️ VAPID keys missing. Push notifications DISABLED.');
}

const sendPushNotification = async (subscription, payload) => {
  if (!publicKey || !privateKey) return;

  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (err) {
    console.error('Push send failed:', err.message);
  }
};

module.exports = { sendPushNotification };
