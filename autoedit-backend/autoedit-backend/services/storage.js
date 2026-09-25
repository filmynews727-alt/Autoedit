const cloudinary = require('cloudinary').v2;

// Only configure Cloudinary if credentials are actually set. If they're not,
// isConfigured() returns false and the caller falls back to serving files
// from local disk — the app keeps working either way, it just won't survive
// a server restart until Cloudinary is set up.
let configured = false;
function ensureConfigured() {
  if (configured) return true;
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    return false;
  }
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  configured = true;
  return true;
}

function isConfigured() {
  return ensureConfigured();
}

// Uploads a local file to Cloudinary and returns its permanent, public URL.
// resourceType: 'video' for .mp4, 'image' for thumbnails.
async function uploadFile(localPath, resourceType, publicId) {
  if (!ensureConfigured()) throw new Error('Cloudinary is not configured');
  const result = await cloudinary.uploader.upload(localPath, {
    resource_type: resourceType,
    public_id: publicId,
    folder: 'autoedit-ai',
    overwrite: true,
  });
  return result.secure_url;
}

// Uploads an in-memory Buffer (e.g. an AI-generated image) without ever
// writing it to disk first.
function uploadBuffer(buffer, resourceType, publicId) {
  if (!ensureConfigured()) throw new Error('Cloudinary is not configured');
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: resourceType, public_id: publicId, folder: 'autoedit-ai', overwrite: true },
      (err, result) => (err ? reject(err) : resolve(result.secure_url))
    );
    stream.end(buffer);
  });
}

module.exports = { isConfigured, uploadFile, uploadBuffer };
