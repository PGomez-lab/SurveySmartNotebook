/* photo.js
 * Reads an uploaded field photo and downsizes it to a reasonable max dimension
 * before storing as a base64 data URL, so a class full of projects doesn't blow
 * past the browser's localStorage quota.
 */

const Photo = (() => {
  const MAX_DIM = 640;
  const QUALITY = 0.72;

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function processFile(file) {
    const rawUrl = await fileToDataUrl(file);
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = rawUrl;
    });

    const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);

    return canvas.toDataURL("image/jpeg", QUALITY);
  }

  return { processFile };
})();
