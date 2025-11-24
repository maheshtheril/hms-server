// scripts/test-bcrypt-compare.js
const bcrypt = require('bcryptjs');
const [,, hash, plain] = process.argv;
if (!hash || !plain) { console.error('Usage: node scripts/test-bcrypt-compare.js "<hash>" "<plaintext>"'); process.exit(2); }
bcrypt.compare(plain, hash)
  .then(ok => { console.log('match?', ok); process.exit(ok ? 0 : 1); })
  .catch(e => { console.error(e); process.exit(3); });
