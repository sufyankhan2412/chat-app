const cloudinary = require("cloudinary").v2;

// Configure Cloudinary with environment variables
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a file buffer to Cloudinary
 * @param {Buffer} fileBuffer - The file buffer to upload
 * @param {Object} options - Upload options
 * @param {String} options.folder - Cloudinary folder path (e.g., 'chat-app/avatars')
 * @param {String} options.resourceType - 'image', 'video', 'raw', or 'auto'
 * @param {String} options.publicId - Optional custom public ID
 * @returns {Promise<Object>} Cloudinary upload result
 */
async function uploadToCloudinary(fileBuffer, options = {}) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder || "chat-app",
        resource_type: options.resourceType || "auto",
        public_id: options.publicId,
        // Optimize images automatically
        transformation: options.transformation,
      },
      (error, result) => {
        if (error) {
          console.error("[Cloudinary Upload Error]", error);
          reject(error);
        } else {
          resolve(result);
        }
      }
    );

    uploadStream.end(fileBuffer);
  });
}

/**
 * Delete a file from Cloudinary
 * @param {String} publicId - The public ID of the file to delete
 * @param {String} resourceType - 'image', 'video', or 'raw'
 * @returns {Promise<Object>} Cloudinary deletion result
 */
async function deleteFromCloudinary(publicId, resourceType = "image") {
  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
    });
    return result;
  } catch (error) {
    console.error("[Cloudinary Delete Error]", error);
    throw error;
  }
}

/**
 * Extract public ID from a Cloudinary URL
 * @param {String} url - The Cloudinary URL
 * @returns {String|null} The public ID or null if not a Cloudinary URL
 */
function extractPublicId(url) {
  if (!url || typeof url !== "string") return null;
  
  // Match Cloudinary URL pattern
  const match = url.match(/\/v\d+\/(.+?)(?:\.[^.]+)?$/);
  if (match && match[1]) {
    return match[1];
  }
  
  return null;
}

module.exports = {
  cloudinary,
  uploadToCloudinary,
  deleteFromCloudinary,
  extractPublicId,
};
