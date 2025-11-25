const { Storage } = require('@google-cloud/storage');
const fs = require('fs');
const path = require('path');
const storage = new Storage();

async function ensureDirFor(filePath) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

async function downloadOrEmpty(bucketName, remotePath, localPath) {
  await ensureDirFor(localPath);
  const file = storage.bucket(bucketName).file(remotePath);
  const [exists] = await file.exists();
  if (!exists) {
    await fs.promises.writeFile(localPath, '{}', 'utf8');
    console.log(`↳ no remote, wrote empty ${localPath}`);
    return;
  }
  await file.download({ destination: localPath });
  console.log(`↳ downloaded gs://${bucketName}/${remotePath} -> ${localPath}`);
}

async function upload(bucketName, localPath, remotePath) {
  await storage.bucket(bucketName).upload(localPath, {
    destination: remotePath,
    resumable: false,
    metadata: { contentType: 'application/json', cacheControl: 'no-cache' }
  });
  console.log(`↳ uploaded ${localPath} -> gs://${bucketName}/${remotePath}`);
}

module.exports = { downloadOrEmpty, upload };
